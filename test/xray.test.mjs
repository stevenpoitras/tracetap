import assert from "node:assert/strict";
import { test } from "node:test";

import { XRAY_BUCKETS } from "../dist/context/xray-buckets.js";
import {
    buildContextXray,
    segmentsFromRequestBody,
} from "../dist/context/xray.js";

test("XRAY_BUCKETS taxonomy is non-empty and ordered", () => {
  assert.ok(XRAY_BUCKETS.length >= 7);
  assert.equal(XRAY_BUCKETS[0].id, "system");
});

test("segmentsFromRequestBody partitions Anthropic messages", () => {
  const segs = segmentsFromRequestBody({
    model: "claude-opus-4",
    system: "You are Claude Code.",
    tools: [{ name: "Read", description: "Read a file", input_schema: {} }],
    messages: [
      { role: "user", content: [{ type: "text", text: "Read foo.txt" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should use Read" },
          { type: "text", text: "I'll read it." },
          {
            type: "tool_use",
            id: "t1",
            name: "Read",
            input: { path: "foo.txt" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "hello" }],
      },
    ],
  });
  const buckets = new Set(segs.map((s) => s.bucket));
  assert.ok(buckets.has("system"));
  assert.ok(buckets.has("tools"));
  assert.ok(buckets.has("user"));
  assert.ok(buckets.has("assistant"));
  assert.ok(buckets.has("thinking"));
  assert.ok(buckets.has("tool_result"));
});

test("buildContextXray diffs new vs carried vs dropped", () => {
  const prev = {
    request: {
      body: {
        model: "m",
        system: "sys",
        messages: [{ role: "user", content: "keep me" }],
      },
    },
  };
  const curr = {
    request: {
      body: {
        model: "m",
        system: "sys",
        messages: [
          { role: "user", content: "keep me" },
          { role: "assistant", content: "new reply" },
        ],
      },
    },
  };
  // Drop the first-only message by replacing user text
  const droppedPrev = {
    request: {
      body: {
        model: "m",
        system: "sys",
        messages: [
          { role: "user", content: "old only" },
          { role: "user", content: "keep me" },
        ],
      },
    },
  };
  const x = buildContextXray({
    seq: 1,
    pair: curr,
    prev: { seq: 0, pair: droppedPrev },
  });
  assert.equal(x.seq, 1);
  assert.ok(x.buckets.length >= 1);
  assert.ok(x.delta);
  assert.ok(x.delta.droppedCount >= 1);
  assert.ok(x.delta.newCount >= 1);
  assert.ok(x.delta.carriedCount >= 1);

  const solo = buildContextXray({ seq: 0, pair: prev });
  assert.equal(solo.delta, undefined);
});

test("tools declarations segment per tool, not as one blob", () => {
  const read = { name: "Read", description: "Read a file", input_schema: {} };
  const sleeper = {
    name: "SleeperTool",
    description: "x".repeat(400),
    input_schema: { type: "object", properties: {} },
  };
  const segs = segmentsFromRequestBody({
    model: "claude-opus-4",
    system: "sys",
    tools: [read, sleeper],
    messages: [{ role: "user", content: "hi" }],
  });
  const toolSegs = segs.filter((s) => s.bucket === "tools");
  assert.equal(toolSegs.length, 2);
  assert.deepEqual(
    toolSegs.map((s) => s.kind),
    ["tool:Read", "tool:SleeperTool"],
  );
  // Each segment is sized to ITS tool, so the bucket now exposes per-tool cost.
  assert.equal(toolSegs[0].chars, JSON.stringify(read).length);
  assert.equal(toolSegs[1].chars, JSON.stringify(sleeper).length);
  // Per-tool ids diff independently: dropping one tool drops one segment.
  const without = segmentsFromRequestBody({
    model: "claude-opus-4",
    system: "sys",
    tools: [read],
    messages: [{ role: "user", content: "hi" }],
  }).filter((s) => s.bucket === "tools");
  assert.equal(without.length, 1);
  assert.equal(without[0].id, toolSegs[0].id);
});
