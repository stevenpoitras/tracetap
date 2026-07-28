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
