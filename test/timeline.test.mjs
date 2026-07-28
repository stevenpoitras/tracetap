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
