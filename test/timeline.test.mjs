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
  assert.equal(tl.points[2].compaction.prePromptTokens, 200);
  assert.equal(tl.points[2].compaction.postPromptTokens, 80);
  assert.equal(tl.peakPromptTokens, 200);
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
  assert.equal(tl.peakPromptTokens, 250);
});

// ---------------------------------------------------------------------------
// Compaction efficacy
//
// Shapes below are taken from real sessions in the local index (notably
// claude:2d8ba2b4), so these lock in the arithmetic against observed data
// rather than invented numbers.
// ---------------------------------------------------------------------------

/**
 * Build a timeline from compact per-call specs.
 * `{ items, ctx, cc, cr, errored }` → one request with precomputed composition,
 * so approx tokens are exactly `ctx`.
 */
function timelineOf(specs, opts = {}) {
  const requests = specs.map((s, i) => ({
    seq: i,
    ts: 100 * (i + 1),
    model: "m",
    promptTokens: s.ctx,
    completionTokens: 10,
    cacheRead: s.cr ?? 0,
    cacheCreation: s.cc ?? 0,
    transcriptItems: s.items,
    promptHash: "h",
    errored: !!s.errored,
  }));
  const precomputedBySeq = new Map(
    specs.map((s, i) => [i, { totalChars: s.ctx * 4, totalApproxTokens: s.ctx, buckets: {} }]),
  );
  return buildContextTimeline({ requests, precomputedBySeq, ...opts });
}

/** N filler calls at a flat cache_creation, to pin the baseline median. */
const filler = (n, { items = 40, ctx = 90000, cc = 1000 } = {}) =>
  Array.from({ length: n }, (_, i) => ({ items: items + i, ctx: ctx + i, cc }));

test("compaction efficacy reports reclaim against attributable cache rebuild", () => {
  // claude:2d8ba2b4 @ seq 131: dropped 12 items, reclaimed 78 tokens, and paid
  // 46,698 of cache_creation against an ambient baseline of a few hundred.
  const tl = timelineOf([
    ...filler(5, { cc: 1000 }),
    { items: 20, ctx: 109656, cc: 667, cr: 164651 },
    { items: 8, ctx: 109578, cc: 46698, cr: 121187 }, // compaction
    { items: 9, ctx: 110604, cc: 1000, cr: 121187 },
    ...filler(4, { items: 12, ctx: 100000, cc: 1000 }),
  ]);

  const c = tl.points[6].compaction;
  assert.ok(c, "seq 6 shrank the transcript");
  const e = c.efficacy;
  assert.equal(e.reclaimedTokens, 109656 - 109578);
  assert.equal(e.reclaimedTokens, 78);
  assert.equal(e.reclaimedPct, 0.1);
  assert.equal(e.cacheRebuildTokens, 46698, "raw cache_creation on the compaction call");
  assert.equal(e.cacheReadBefore, 164651);
  assert.equal(e.cacheReadAfter, 121187);
  assert.equal(e.callsToRegrow, 1, "context was back over its old size on the very next call");
  assert.equal(e.verdict, "negative");
  // Cost is baselined: 46698 - median(1000) = 45698, not the raw 46698.
  assert.match(e.verdictReason, /reclaimed 78 tokens but paid ~45\.7K/);
});

test("cache cost is baselined against nearby calls, not the preceding one", () => {
  // Regression for claude:2d8ba2b4 @ seq 121: the call *before* the compaction
  // was itself a full prefix rebuild (cache_creation 164,283 > the
  // compaction's own 158,823). Baselining on the previous call alone would
  // report this compaction as free.
  const tl = timelineOf([
    ...filler(5, { cc: 1000 }),
    { items: 24, ctx: 107528, cc: 164283, cr: 0 }, // prev call: full rebuild
    { items: 6, ctx: 103911, cc: 158823, cr: 0 }, // compaction
    ...filler(5, { items: 12, ctx: 104000, cc: 1000 }),
  ]);

  const e = tl.points[6].compaction.efficacy;
  assert.equal(e.reclaimedTokens, 3617);
  assert.equal(e.verdict, "negative", "a 158.8K rebuild is not free just because the prior call also rebuilt");
  assert.match(e.verdictReason, /paid ~157\.8K/);
});

test("a compaction call that errored is costed on the retry that ran", () => {
  // claude:2d8ba2b4 @ seq 99: 429 on the compacted request, so it recorded no
  // usage at all; the prefix rebuild landed on the next call instead.
  const tl = timelineOf([
    ...filler(5, { cc: 1000 }),
    { items: 49, ctx: 108039, cc: 113, cr: 164667 },
    { items: 7, ctx: 100917, cc: 0, cr: 0, errored: true }, // compaction, 429
    { items: 8, ctx: 100942, cc: 153782, cr: 0 }, // retry pays the rebuild
    ...filler(4, { items: 12, ctx: 101000, cc: 1000 }),
  ]);

  const e = tl.points[6].compaction.efficacy;
  assert.equal(e.cacheRebuildTokens, 0, "the field still reports the compaction call's own value");
  assert.equal(e.verdict, "negative", "but the cost rolled forward to the retry");
  assert.match(e.verdictReason, /paid ~152\.8K/);
});

test("verdict boundary: marginal when the reclaim is regrown within 5 calls", () => {
  const tail = (regrowAt) => {
    // ctx climbs back to the pre-compaction 105000 exactly `regrowAt` calls on.
    const out = [];
    for (let i = 1; i <= regrowAt; i++) {
      out.push({ items: 5 + i, ctx: i === regrowAt ? 105000 : 85000 + i * 1000, cc: 1000 });
    }
    return out;
  };
  const head = [
    ...filler(5, { cc: 1000 }),
    { items: 15, ctx: 105000, cc: 1000, cr: 160000 },
    { items: 5, ctx: 85000, cc: 1000, cr: 120000 }, // compaction, rebuild == baseline
  ];

  const marginal = timelineOf([...head, ...tail(5), ...filler(5, { ctx: 106000 })]);
  const m = marginal.points[6].compaction.efficacy;
  assert.equal(m.reclaimedTokens, 20000);
  assert.equal(m.callsToRegrow, 5);
  assert.equal(m.verdict, "marginal", "5 calls is inside the short-lived window");
  assert.match(m.verdictReason, /back to its old size within 5 calls/);

  const positive = timelineOf([...head, ...tail(6), ...filler(5, { ctx: 106000 })]);
  const p = positive.points[6].compaction.efficacy;
  assert.equal(p.callsToRegrow, 6);
  assert.equal(p.verdict, "positive", "one call past the window flips the verdict");
  assert.match(p.verdictReason, /holding for 6 calls/);
});

test("verdict boundary: reclaim below the attributable rebuild is negative", () => {
  const at = (reclaimed) =>
    timelineOf([
      ...filler(5, { cc: 1000 }),
      { items: 15, ctx: 100000, cc: 1000, cr: 160000 },
      { items: 5, ctx: 100000 - reclaimed, cc: 11000, cr: 120000 }, // attributable = 10000
      ...filler(6, { items: 8, ctx: 60000, cc: 1000 }),
    ]).points[6].compaction.efficacy;

  assert.equal(at(9999).verdict, "negative", "one token short of paying for itself");
  assert.equal(at(10000).verdict, "positive", "breaking even, and it never regrew");
  assert.equal(at(10000).callsToRegrow, null);
});

test("a trivial reclaim is negative even when the rebuild was free", () => {
  const e = timelineOf([
    ...filler(5, { cc: 1000 }),
    { items: 15, ctx: 100000, cc: 1000, cr: 160000 },
    { items: 5, ctx: 99955, cc: 1000, cr: 120000 }, // 45 tokens back
    ...filler(6, { items: 8, ctx: 60000, cc: 1000 }),
  ]).points[6].compaction.efficacy;

  assert.equal(e.reclaimedTokens, 45);
  assert.equal(e.verdict, "negative");
  assert.match(e.verdictReason, /reclaimed only 45 tokens/);
});

test("compaction trigger falls back to inferred/unknown without a PreCompact hook", () => {
  const specs = [
    ...filler(5, { cc: 1000 }),
    { items: 15, ctx: 100000, cc: 1000, cr: 160000 },
    { items: 5, ctx: 90000, cc: 1000, cr: 120000 },
    ...filler(5, { items: 8, ctx: 60000, cc: 1000 }),
  ];

  const bare = timelineOf(specs).points[6].compaction.trigger;
  assert.deepEqual(bare, { kind: "unknown", source: "inferred" }, "nothing on the wire says auto vs manual");

  const hooked = timelineOf(specs, {
    triggersBySeq: new Map([[6, { kind: "manual", source: "hook", hookTs: 42 }]]),
  }).points[6].compaction.trigger;
  assert.deepEqual(hooked, { kind: "manual", source: "hook", hookTs: 42 });
});
