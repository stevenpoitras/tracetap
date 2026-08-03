import { test } from "node:test";
import assert from "node:assert/strict";

import { buildContextTimeline } from "../dist/context/timeline.js";

test("buildContextTimeline marks compaction pre/post sizes", () => {
  const tl = buildContextTimeline({
    requests: [
      {
        seq: 0,
        ts: 100,
        model: "m",
        promptTokens: 100,
        completionTokens: 10,
        cacheRead: 0,
        cacheCreation: 0,
        transcriptItems: 5,
        promptHash: "a",
        errored: false,
      },
      {
        seq: 1,
        ts: 200,
        model: "m",
        promptTokens: 200,
        completionTokens: 10,
        cacheRead: 50,
        cacheCreation: 0,
        transcriptItems: 12,
        promptHash: "a",
        errored: false,
      },
      {
        seq: 2,
        ts: 300,
        model: "m",
        promptTokens: 80,
        completionTokens: 10,
        cacheRead: 40,
        cacheCreation: 0,
        transcriptItems: 4, // shrunk → compaction
        promptHash: "b",
        errored: false,
      },
    ],
  });
  assert.equal(tl.points.length, 3);
  assert.equal(tl.compactionCount, 1);
  assert.ok(tl.points[2].compaction);
  assert.equal(tl.points[2].compaction.fromItems, 12);
  assert.equal(tl.points[2].compaction.toItems, 4);
  // contextTokens = promptTokens + cacheRead + cacheCreation, i.e. what the
  // model actually read — not `input_tokens`, which caching pins near zero.
  assert.equal(tl.points[2].compaction.preContextTokens, 250);
  assert.equal(tl.points[2].compaction.postContextTokens, 120);
  assert.equal(tl.points[2].compaction.droppedTokens, 130);
  assert.equal(tl.peakContextTokens, 250);
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

/** @param o overrides; defaults describe one ordinary cached call. */
const call = (o) => ({
  seq: 0,
  ts: 100,
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
