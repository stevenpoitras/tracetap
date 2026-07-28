import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveFlow } from "../dist/flow/derive.js";

test("deriveFlow builds user → assistant → tool → result chain", () => {
  const flow = deriveFlow({
    steps: [
      {
        stepIndex: 1,
        role: "user",
        message: "Read foo.txt",
        reasoning: "",
        toolName: "",
        toolInput: "",
        observation: "",
        errored: false,
      },
      {
        stepIndex: 2,
        role: "agent",
        message: "I'll read it.",
        reasoning: "Need the file contents",
        toolName: "Read",
        toolInput: JSON.stringify({ path: "foo.txt" }),
        observation: "hello world",
        errored: false,
      },
    ],
    requests: [
      {
        seq: 0,
        ts: 1700000000,
        model: "claude",
        promptTokens: 100,
        completionTokens: 30,
        durationMs: 500,
        promptHash: "abc",
        agentStepIndex: 2,
        errored: false,
      },
    ],
    hooks: [
      {
        id: 1,
        sessionId: "s",
        ts: 1699999990,
        event: "UserPromptSubmit",
        hookName: "posture",
        durationMs: 2,
        decision: null,
        stdinDigest: "d",
        stdinPreview: {},
        stdoutPreview: null,
        outcome: "ok",
        exitCode: 0,
        payload: null,
        sourcePath: "/tmp/x.jsonl",
      },
    ],
  });

  const kinds = flow.nodes.map((n) => n.kind);
  assert.ok(kinds.includes("hook"));
  assert.ok(kinds.includes("user"));
  assert.ok(kinds.includes("thinking"));
  assert.ok(kinds.includes("assistant"));
  assert.ok(kinds.includes("api_call"));
  assert.ok(kinds.includes("tool_call"));
  assert.ok(kinds.includes("tool_result"));
  assert.ok(flow.edges.length >= flow.nodes.length - 1);
});

test("deriveFlow marks Task tools as branch nodes", () => {
  const flow = deriveFlow({
    steps: [
      {
        stepIndex: 1,
        role: "agent",
        message: "",
        reasoning: "",
        toolName: "Task",
        toolInput: JSON.stringify({ description: "explore" }),
        observation: "done",
        errored: false,
      },
    ],
  });
  const branch = flow.nodes.find((n) => n.kind === "branch");
  assert.ok(branch);
  assert.equal(branch.lane, 1);
});
