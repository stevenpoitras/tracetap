import { test } from "node:test";
import assert from "node:assert/strict";

import { buildContextTimeline } from "../dist/context/timeline.js";

/**
 * One call. Overrides are spread, so a test states only what it is about.
 *
 * Sizes in these tests are in the tens of thousands on purpose. Measured
 * against Claude Code's own `compact_boundary` records — 200 of them across 88
 * session transcripts — the SMALLEST real compaction freed 24,287 tokens and
 * none freed under 10,000. A fixture that frees 130 is not a small compaction;
 * it is not a compaction, and asserting on one asserted behaviour that cannot
 * occur.
 */
const call = (o) => ({
  seq: 0,
  ts: 100,
  durationMs: 1000,
  model: "m",
  promptTokens: 2,
  completionTokens: 10,
  cacheRead: 0,
  cacheCreation: 0,
  transcriptItems: 5,
  promptHash: "h",
  errored: false,
  ...o,
});

test("buildContextTimeline marks compaction pre/post sizes", () => {
  const tl = buildContextTimeline({
    requests: [
      call({ seq: 0, ts: 100, promptTokens: 40_000, transcriptItems: 5 }),
      call({ seq: 1, ts: 200, promptTokens: 100_000, cacheRead: 50_000, transcriptItems: 12 }),
      call({ seq: 2, ts: 300, promptTokens: 8_000, cacheRead: 4_000, transcriptItems: 4 }),
    ],
  });
  assert.equal(tl.points.length, 3);
  assert.equal(tl.compactionCount, 1);
  assert.ok(tl.points[2].compaction);
  assert.equal(tl.points[2].compaction.fromItems, 12);
  assert.equal(tl.points[2].compaction.toItems, 4);
  // contextTokens = promptTokens + cacheRead + cacheCreation, i.e. what the
  // model actually read — not `input_tokens`, which caching pins near zero.
  assert.equal(tl.points[2].compaction.preContextTokens, 150_000);
  assert.equal(tl.points[2].compaction.postContextTokens, 12_000);
  assert.equal(tl.points[2].compaction.droppedTokens, 138_000);
  assert.equal(tl.peakContextTokens, 150_000);
});

/**
 * Every rejection case below is paired with a POSITIVE twin.
 *
 * `compactionCount === 0` is also what a fixture that never reached the
 * detector produces, so a lone negative assertion cannot tell "correctly
 * rejected" from "never ran". Each pair changes ONE property and asserts the
 * verdict flips, which proves the fixture is live and that the named gate is
 * the thing doing the work.
 */

test("a drop far below the observed floor is not a compaction", () => {
  // 350 tokens. Real ones start at 24,287 — see `call` above. This exact shape
  // (items fall by one, context falls by a few hundred, and the session's
  // context is GROWING through it) accounted for 10 of 10 reported compactions
  // on one live session.
  const tl = buildContextTimeline({
    requests: [
      call({ seq: 0, ts: 100, promptTokens: 166_784, transcriptItems: 12 }),
      call({ seq: 1, ts: 200, promptTokens: 166_434, transcriptItems: 9 }),
    ],
  });
  assert.equal(tl.compactionCount, 0);
  assert.equal(tl.points[1].compaction, undefined);

  // Twin: identical but for the size of the drop. Proves the fixture reaches
  // the detector and that the FLOOR is what rejected the first one.
  const real = buildContextTimeline({
    requests: [
      call({ seq: 0, ts: 100, promptTokens: 166_784, transcriptItems: 12 }),
      call({ seq: 1, ts: 200, promptTokens: 130_000, transcriptItems: 9 }),
    ],
  });
  assert.equal(real.compactionCount, 1);
  assert.equal(real.points[1].compaction.droppedTokens, 36_784);
});

test("two calls in flight together are never a compaction", () => {
  // A conversation is strictly sequential — turn N+1 cannot be sent before turn
  // N returns — so overlapping spans PROVE these are different conversations.
  // This is why the detector needs durationMs, not just ts.
  const overlapping = buildContextTimeline({
    requests: [
      call({ seq: 0, ts: 100, durationMs: 60_000, promptTokens: 200_000, transcriptItems: 40 }),
      // starts 10s later, while seq 0 is still running
      call({ seq: 1, ts: 110, durationMs: 5_000, promptTokens: 20_000, transcriptItems: 7 }),
    ],
  });
  assert.equal(overlapping.compactionCount, 0);

  // Same sizes, but the second call starts after the first finished.
  const sequential = buildContextTimeline({
    requests: [
      call({ seq: 0, ts: 100, durationMs: 60_000, promptTokens: 200_000, transcriptItems: 40 }),
      call({ seq: 1, ts: 200, durationMs: 5_000, promptTokens: 20_000, transcriptItems: 7 }),
    ],
  });
  assert.equal(sequential.compactionCount, 1);
});

test("detection follows TIME order, not seq order", () => {
  // seq is assignment order in the log; concurrent calls finish out of order.
  // By seq the items read 10, 60, 30 — a drop at seq 2. By time they read
  // 10, 30, 60 — monotonic growth and no compaction anywhere. Ordering alone
  // accounted for 53 of 209 false positives on the live index.
  const tl = buildContextTimeline({
    requests: [
      call({ seq: 0, ts: 100, promptTokens: 40_000, transcriptItems: 10 }),
      call({ seq: 1, ts: 400, promptTokens: 240_000, transcriptItems: 60 }),
      call({ seq: 2, ts: 200, promptTokens: 120_000, transcriptItems: 30 }),
    ],
  });
  assert.equal(tl.compactionCount, 0);

  // Twin: the SAME three rows with only the timestamps permuted, so that time
  // order now agrees with seq order and the drop at seq 2 is genuine. If the
  // fixture were inert, this would also read 0.
  const ordered = buildContextTimeline({
    requests: [
      call({ seq: 0, ts: 100, promptTokens: 40_000, transcriptItems: 10 }),
      call({ seq: 1, ts: 200, promptTokens: 240_000, transcriptItems: 60 }),
      call({ seq: 2, ts: 400, promptTokens: 120_000, transcriptItems: 30 }),
    ],
  });
  assert.equal(ordered.compactionCount, 1);
  assert.equal(ordered.points[2].compaction.fromItems, 60);
});

test("compaction pre-size comes from the time predecessor, not seq-1", () => {
  // seq 1 ran LAST. Its predecessor in time is seq 2 (200,000 tokens), not
  // seq 0. Quoting seq 0 would report a pre-size from an unrelated call.
  const tl = buildContextTimeline({
    requests: [
      call({ seq: 0, ts: 100, promptTokens: 30_000, transcriptItems: 8 }),
      call({ seq: 1, ts: 300, durationMs: 1000, promptTokens: 15_000, transcriptItems: 9 }),
      call({ seq: 2, ts: 150, durationMs: 1000, promptTokens: 200_000, transcriptItems: 55 }),
    ],
  });
  assert.equal(tl.compactionCount, 1);
  const c = tl.points.find((p) => p.seq === 1).compaction;
  assert.ok(c, "seq 1 should carry the compaction");
  assert.equal(c.preContextTokens, 200_000);
  assert.equal(c.postContextTokens, 15_000);
  assert.equal(c.fromItems, 55);
});

const req = (seq, promptTokens, transcriptItems) => ({
  seq,
  ts: 100 * (seq + 1),
  model: "m",
  promptTokens,
  completionTokens: 10,
  cacheRead: 0,
  cacheCreation: 0,
  transcriptItems,
  promptHash: "h" + seq,
  errored: false,
});

test("precomputed composition is preferred over re-reading request bodies", () => {
  let xrayCalls = 0;
  const tl = buildContextTimeline({
    requests: [req(0, 100, 5), req(1, 200, 8)],
    precomputedBySeq: new Map([
      [0, { totalChars: 4000, totalApproxTokens: 1000, buckets: { system: 400, user: 600 } }],
    ]),
    // seq 1 has no precomputed row, so it must still fall back to the body.
    pairsBySeq: new Map([[1, { request: { body: {} } }]]),
    xrayFor: () => {
      xrayCalls++;
      return { totalChars: 8000, totalApproxTokens: 2000, buckets: [{ bucket: "user", approxTokens: 2000 }] };
    },
  });

  assert.equal(tl.points[0].approxTokens, 1000, "seq 0 used the precomputed value");
  assert.equal(tl.points[0].approxChars, 4000);
  assert.deepEqual(tl.points[0].buckets, { system: 400, user: 600 });
  assert.equal(xrayCalls, 1, "the body was read only for the seq lacking a precomputed row");
  assert.equal(tl.points[1].approxTokens, 2000, "seq 1 fell back to segmenting the body");
  assert.equal(tl.peakApproxTokens, 2000);
});

test("a session with no bodies and no precompute still yields a timeline", () => {
  // Wire token counts are always present; composition is the optional part.
  const tl = buildContextTimeline({ requests: [req(0, 100, 5), req(1, 250, 9)] });
  assert.equal(tl.points.length, 2);
  assert.equal(tl.points[1].approxTokens, 250);
  assert.equal(tl.points[1].buckets, undefined);
  assert.equal(tl.peakContextTokens, 250);
});

// -- the two defects that made the pane report fiction ----------------------

test("contextTokens counts the cached prompt, not just the uncached remainder", () => {
  // A real row from a live session: 269,760 read from cache, 2,175 written,
  // and `input_tokens` of 2. Reporting the 2 as "prompt tokens" is what put
  // "peak 2 prompt tokens" in the header of a 224-call session.
  const tl = buildContextTimeline({
    requests: [call({ promptTokens: 2, cacheRead: 269760, cacheCreation: 2175 })],
  });
  assert.equal(tl.points[0].promptTokens, 2, "the wire value is preserved as-is");
  assert.equal(tl.points[0].contextTokens, 271937);
  assert.equal(tl.peakContextTokens, 271937);
});

test("dropping transcript items while context GROWS is not a compaction", () => {
  // Interleaved subagents make item counts hop between conversations. Keying
  // on item count alone found 85 "compactions" in one 8m55s session, 30 of
  // which showed context growing across them (146,698 -> 160,698 tokens).
  const tl = buildContextTimeline({
    requests: [
      call({ seq: 0, ts: 100, transcriptItems: 69, cacheRead: 146698 }),
      call({ seq: 1, ts: 200, transcriptItems: 61, cacheRead: 160698 }),
    ],
  });
  assert.equal(tl.compactionCount, 0);
  assert.equal(tl.points[1].compaction, undefined);
});

test("dropping items AND context is a compaction", () => {
  const tl = buildContextTimeline({
    requests: [
      call({ seq: 0, ts: 100, transcriptItems: 69, cacheRead: 160000 }),
      call({ seq: 1, ts: 200, transcriptItems: 12, cacheRead: 40000 }),
    ],
  });
  assert.equal(tl.compactionCount, 1);
  assert.equal(tl.points[1].compaction.droppedTokens, 120000);
});

test("interleaved concurrent calls are counted, not silently smoothed", () => {
  // seq is index order, not time order. When a session runs a fleet, adjacent
  // rows belong to different conversations and every neighbour-diffing metric
  // is comparing across threads. The caveat has to be visible.
  const tl = buildContextTimeline({
    requests: [
      call({ seq: 0, ts: 500 }),
      call({ seq: 1, ts: 100 }),
      call({ seq: 2, ts: 300 }),
      call({ seq: 3, ts: 200 }),
    ],
  });
  assert.equal(tl.outOfOrderPairs, 2);
});

test("a strictly sequential session reports no interleaving", () => {
  const tl = buildContextTimeline({
    requests: [call({ seq: 0, ts: 100 }), call({ seq: 1, ts: 200 }), call({ seq: 2, ts: 300 })],
  });
  assert.equal(tl.outOfOrderPairs, 0);
});
