import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { buildTrajectories } from "../dist/trajectory/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, "..", "src", "trajectory", "__fixtures__");

function loadJsonl(name) {
  const raw = fs.readFileSync(path.join(FIX, name), "utf-8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function countToolCalls(traj) {
  return traj.steps.reduce((n, s) => n + s.toolCalls.length, 0);
}

function countObservations(traj) {
  return traj.steps.reduce((n, s) => n + (s.observation ? s.observation.results.length : 0), 0);
}

test("buildTrajectories([]) returns []", () => {
  assert.deepEqual(buildTrajectories([]), []);
  assert.deepEqual(buildTrajectories(null), []);
});

test("Claude: single grouped trajectory across volatile cch/cache_control", () => {
  const pairs = loadJsonl("claude-tooluse.jsonl");
  const trajs = buildTrajectories(pairs);

  // Both pairs share a conversation despite differing cch hash + cache_control ttl.
  assert.equal(trajs.length, 1);
  const t = trajs[0];
  assert.equal(t.agent.name, "claude");
  assert.equal(t.agent.model, "claude-opus-4");

  // Steps: user prompt, agent turn (tool call), agent final answer.
  assert.equal(t.steps.length, 3);
  assert.deepEqual(
    t.steps.map((s) => s.role),
    ["user", "agent", "agent"],
  );
  assert.equal(t.steps[0].message, "Read foo.txt please");
  assert.equal(t.steps[1].message, "I'll read it.");
  assert.equal(t.steps[2].message, "The file says hello world.");

  // 1-based indices.
  assert.deepEqual(
    t.steps.map((s) => s.index),
    [1, 2, 3],
  );

  // Exactly one tool call and one stitched observation.
  assert.equal(countToolCalls(t), 1);
  assert.equal(countObservations(t), 1);
});

test("Claude: tool_call<->observation stitched ACROSS the pair boundary", () => {
  const pairs = loadJsonl("claude-tooluse.jsonl");
  const t = buildTrajectories(pairs)[0];

  const toolStep = t.steps[1];
  assert.equal(toolStep.toolCalls.length, 1);
  const call = toolStep.toolCalls[0];
  assert.equal(call.id, "toolu_01");
  assert.equal(call.name, "Read");
  assert.deepEqual(call.arguments, { path: "foo.txt" });

  // The result lives in pair 1's request, but must attach to the call from
  // pair 0's response.
  assert.ok(toolStep.observation);
  assert.equal(toolStep.observation.results.length, 1);
  assert.equal(toolStep.observation.results[0].sourceCallId, "toolu_01");
  assert.equal(toolStep.observation.results[0].content, "hello world");

  // The final answer step has no observation.
  assert.equal(t.steps[2].observation, undefined);
});

test("Claude: per-step and per-trajectory token totals equal raw usage", () => {
  const pairs = loadJsonl("claude-tooluse.jsonl");
  const t = buildTrajectories(pairs)[0];

  const s1 = t.steps[1].metrics;
  assert.deepEqual(s1, {
    promptTokens: 100,
    completionTokens: 30,
    cacheCreationTokens: 20,
    cacheReadTokens: 50,
  });
  const s2 = t.steps[2].metrics;
  assert.deepEqual(s2, {
    promptTokens: 150,
    completionTokens: 10,
    cacheCreationTokens: 0,
    cacheReadTokens: 120,
  });

  // User step carries no metrics.
  assert.equal(t.steps[0].metrics, undefined);

  // Trajectory rollup == sum of raw usage in the log.
  assert.deepEqual(t.metrics, {
    promptTokens: 250,
    completionTokens: 40,
    cacheCreationTokens: 20,
    cacheReadTokens: 170,
  });
});

test("Codex: grouped by prompt_cache_key, steps/tools/observations reconstructed", () => {
  const pairs = loadJsonl("codex-tooluse.jsonl");
  const trajs = buildTrajectories(pairs);

  assert.equal(trajs.length, 1);
  const t = trajs[0];
  assert.equal(t.agent.name, "codex");
  assert.equal(t.agent.model, "gpt-5.1");
  assert.equal(t.sessionId, "codex:k:sess-abc");

  // user prompt, agent (reasoning + tool call), agent (reasoning + final).
  assert.equal(t.steps.length, 3);
  assert.deepEqual(
    t.steps.map((s) => s.role),
    ["user", "agent", "agent"],
  );
  assert.equal(t.steps[0].message, "List the files");
  assert.equal(t.steps[1].reasoningContent, "I'll list files.");
  assert.equal(t.steps[2].message, "There are two files.");
  assert.equal(t.steps[2].reasoningContent, "Two files found.");

  assert.equal(countToolCalls(t), 1);
  assert.equal(countObservations(t), 1);
});

test("Codex: function_call_output stitched across pair boundary", () => {
  const pairs = loadJsonl("codex-tooluse.jsonl");
  const t = buildTrajectories(pairs)[0];

  const toolStep = t.steps[1];
  const call = toolStep.toolCalls[0];
  assert.equal(call.id, "call_1");
  assert.equal(call.name, "shell");
  assert.deepEqual(call.arguments, { cmd: "ls" });

  assert.ok(toolStep.observation);
  assert.equal(toolStep.observation.results.length, 1);
  assert.equal(toolStep.observation.results[0].sourceCallId, "call_1");
  assert.equal(toolStep.observation.results[0].content, "file1.txt\nfile2.txt");
});

test("Codex: token totals (incl reasoning + cached) equal raw usage", () => {
  const pairs = loadJsonl("codex-tooluse.jsonl");
  const t = buildTrajectories(pairs)[0];

  assert.deepEqual(t.steps[1].metrics, {
    promptTokens: 200,
    completionTokens: 40,
    cacheCreationTokens: 0,
    cacheReadTokens: 80,
    reasoningTokens: 15,
  });
  assert.deepEqual(t.steps[2].metrics, {
    promptTokens: 260,
    completionTokens: 20,
    cacheCreationTokens: 0,
    cacheReadTokens: 200,
    reasoningTokens: 8,
  });

  assert.deepEqual(t.metrics, {
    promptTokens: 460,
    completionTokens: 60,
    cacheCreationTokens: 0,
    cacheReadTokens: 280,
    reasoningTokens: 23,
  });
});

test("Gemini: grouped trajectory, model from URL, steps/tools/observations reconstructed", () => {
  const pairs = loadJsonl("gemini-tooluse.jsonl");
  const trajs = buildTrajectories(pairs);

  assert.equal(trajs.length, 1);
  const t = trajs[0];
  assert.equal(t.agent.name, "gemini");
  // Model id is parsed from the request URL (/models/<model>:method), not the body.
  assert.equal(t.agent.model, "gemini-2.5-flash");

  // user prompt, agent (thinking + tool call), agent (final answer).
  assert.equal(t.steps.length, 3);
  assert.deepEqual(
    t.steps.map((s) => s.role),
    ["user", "agent", "agent"],
  );
  assert.equal(t.steps[0].message, "List the files please");
  assert.equal(t.steps[1].reasoningContent, "I should list the files.");
  assert.equal(t.steps[2].message, "Found two files.");

  assert.equal(countToolCalls(t), 1);
  assert.equal(countObservations(t), 1);
});

test("Gemini: functionResponse stitched across pair boundary by id", () => {
  const pairs = loadJsonl("gemini-tooluse.jsonl");
  const t = buildTrajectories(pairs)[0];

  const toolStep = t.steps[1];
  assert.equal(toolStep.toolCalls.length, 1);
  const call = toolStep.toolCalls[0];
  assert.equal(call.id, "fc_1");
  assert.equal(call.name, "list_files");
  assert.deepEqual(call.arguments, { path: "." });

  assert.ok(toolStep.observation);
  assert.equal(toolStep.observation.results.length, 1);
  assert.equal(toolStep.observation.results[0].sourceCallId, "fc_1");
  assert.equal(toolStep.observation.results[0].content, "a.txt\nb.txt");

  // The final answer step has no observation.
  assert.equal(t.steps[2].observation, undefined);
});

test("Gemini: token totals (candidates+thoughts, cached) equal raw usage", () => {
  const pairs = loadJsonl("gemini-tooluse.jsonl");
  const t = buildTrajectories(pairs)[0];

  // completionTokens = candidatesTokenCount + thoughtsTokenCount.
  assert.deepEqual(t.steps[1].metrics, {
    promptTokens: 100,
    completionTokens: 20,
    cacheCreationTokens: 0,
    cacheReadTokens: 40,
    reasoningTokens: 8,
  });
  assert.deepEqual(t.steps[2].metrics, {
    promptTokens: 150,
    completionTokens: 14,
    cacheCreationTokens: 0,
    cacheReadTokens: 100,
    reasoningTokens: 4,
  });

  assert.deepEqual(t.metrics, {
    promptTokens: 250,
    completionTokens: 34,
    cacheCreationTokens: 0,
    cacheReadTokens: 140,
    reasoningTokens: 12,
  });
});

test("mixed-agent logs produce one trajectory per wire format", () => {
  const pairs = [
    ...loadJsonl("claude-tooluse.jsonl"),
    ...loadJsonl("codex-tooluse.jsonl"),
    ...loadJsonl("gemini-tooluse.jsonl"),
  ];
  const trajs = buildTrajectories(pairs);
  assert.equal(trajs.length, 3);
  const names = trajs.map((t) => t.agent.name).sort();
  assert.deepEqual(names, ["claude", "codex", "gemini"]);
});

// ---------------------------------------------------------------------------
// Transcript resets. Real Claude sessions do not only grow the resent
// transcript: auto-compaction re-sends a lone summary, `/clear` starts over.
// A monotonic high-water-mark cursor dropped every prompt and tool_result after
// the first reset until the new transcript outgrew the old one.

let synthTs = 1_700_000_000;
function claudePair(messages, content) {
  synthTs += 1;
  return {
    request: {
      timestamp: synthTs,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: {},
      body: { model: "claude-opus-4", system: "You are a test harness.", messages },
    },
    response: {
      timestamp: synthTs + 0.5,
      status_code: 200,
      headers: {},
      body: {
        model: "claude-opus-4",
        stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
        content,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    logged_at: new Date(synthTs * 1000).toISOString(),
  };
}
const userText = (text) => ({ role: "user", content: [{ type: "text", text }] });
const toolUse = (id, name = "Bash") => ({ type: "tool_use", id, name, input: { cmd: id } });
const assistant = (...blocks) => ({ role: "assistant", content: blocks });
const toolResult = (id, text) => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: text }],
});
const userPrompts = (t) => t.steps.filter((s) => s.role === "user").map((s) => s.message);
const observationFor = (t, id) =>
  t.steps.flatMap((s) => s.observation?.results ?? []).filter((r) => r.sourceCallId === id);

/** Three growing calls (2 prompts, 2 tool calls) — a long pre-reset history. */
function growingHistory() {
  const h1 = [userText("first prompt")];
  const a1 = assistant({ type: "text", text: "looking" }, toolUse("t1"));
  const h2 = [...h1, a1, toolResult("t1", "r1")];
  const a2 = assistant(toolUse("t2"));
  const h3 = [...h2, a2, toolResult("t2", "r2"), userText("second prompt")];
  const pairs = [
    claudePair(h1, a1.content),
    claudePair(h2, a2.content),
    claudePair(h3, [{ type: "text", text: "done" }]),
  ];
  return { pairs, last: [...h3, assistant({ type: "text", text: "done" })] };
}

test("transcript reset: a prompt and tool result after a shrink to 1 item are not lost", () => {
  const { pairs } = growingHistory();
  // /clear-style fresh start: the transcript drops to ONE item, a new prompt
  // that triggers a tool call; the next call carries that call's result.
  const r1 = [userText("brand new prompt after reset")];
  const ar = assistant(toolUse("t9", "Read"));
  pairs.push(claudePair(r1, ar.content));
  pairs.push(claudePair([...r1, ar, toolResult("t9", "fresh result")], [{ type: "text", text: "ok" }]));

  const trajs = buildTrajectories(pairs);
  assert.equal(trajs.length, 1);
  const t = trajs[0];

  assert.deepEqual(userPrompts(t), ["first prompt", "second prompt", "brand new prompt after reset"]);
  const obs = observationFor(t, "t9");
  assert.equal(obs.length, 1, "the post-reset tool_result is stitched exactly once");
  assert.equal(obs[0].content, "fresh result");
  const callStep = t.steps.find((s) => s.toolCalls.some((c) => c.id === "t9"));
  assert.equal(callStep.observation.results[0].sourceCallId, "t9");
  // Pre-reset results are stitched once each, never re-stitched by a replay.
  assert.equal(observationFor(t, "t1").length, 1);
  assert.equal(observationFor(t, "t2").length, 1);
  assert.equal(countToolCalls(t), countObservations(t));
});

test("transcript reset: repeated resets keep yielding prompts and results", () => {
  const { pairs } = growingHistory();
  for (let i = 0; i < 3; i++) {
    const r = [userText(`summary ${i}`)];
    const a = assistant(toolUse(`c${i}`));
    pairs.push(claudePair(r, a.content));
    const r2 = [...r, a, toolResult(`c${i}`, `res ${i}`), userText(`follow-up ${i}`)];
    pairs.push(claudePair(r2, [{ type: "text", text: "k" }]));
  }
  const t = buildTrajectories(pairs)[0];
  assert.deepEqual(userPrompts(t), [
    "first prompt",
    "second prompt",
    "summary 0",
    "follow-up 0",
    "summary 1",
    "follow-up 1",
    "summary 2",
    "follow-up 2",
  ]);
  for (let i = 0; i < 3; i++) assert.equal(observationFor(t, `c${i}`).length, 1);
  assert.equal(countToolCalls(t), countObservations(t));
});

test("compaction: summary + carried tail does not re-emit carried prompts", () => {
  const { pairs, last } = growingHistory();
  // Compaction: the history collapses to a summary followed by the most recent
  // turns carried verbatim (the "second prompt" exchange), then a new prompt.
  const tail = last.slice(-3); // t2's tool_result, "second prompt", "done"
  const compacted = [userText("Summary of the earlier conversation."), ...tail];
  assert.ok(compacted.length < last.length);
  const ac = assistant(toolUse("t3"));
  pairs.push(claudePair([...compacted, userText("third prompt")], ac.content));
  pairs.push(
    claudePair(
      [...compacted, userText("third prompt"), ac, toolResult("t3", "r3")],
      [{ type: "text", text: "fin" }],
    ),
  );

  const t = buildTrajectories(pairs)[0];
  const prompts = userPrompts(t);
  // The summary sits BEFORE the carried reply ("done"), the newest assistant
  // item we saw come back, so only what follows that reply is new. (A
  // summary-only compaction — what Claude Code actually sends — has no anchor
  // and is emitted; see the reset tests above.)
  assert.deepEqual(prompts, ["first prompt", "second prompt", "third prompt"]);
  assert.equal(new Set(prompts).size, prompts.length, "no duplicate prompts");
  assert.equal(observationFor(t, "t3").length, 1);
  assert.equal(observationFor(t, "t2").length, 1, "carried tool_result not re-stitched");
});

test("interleaved shorter call under one key does not duplicate the main thread", () => {
  const { pairs, last } = growingHistory();
  // A short side call shares the conversation key, then the main thread resumes.
  pairs.push(claudePair([userText("side question")], [{ type: "text", text: "side answer" }]));
  pairs.push(claudePair([...last, userText("main resumes")], [{ type: "text", text: "ok" }]));
  const t = buildTrajectories(pairs)[0];
  assert.deepEqual(userPrompts(t), ["first prompt", "second prompt", "side question", "main resumes"]);
});

// Parallel same-type subagents share system prompt + model, so their calls
// interleave under ONE conversation key.

test("interleaved lineages without a shared header: both prompts survive", () => {
  const pairs = [
    claudePair([userText("task A")], [toolUse("a1")]),
    claudePair([userText("task B")], [toolUse("b1")]),
    claudePair([userText("task A"), assistant(toolUse("a1")), toolResult("a1", "ra")], [
      { type: "text", text: "doneA" },
    ]),
    claudePair([userText("task B"), assistant(toolUse("b1")), toolResult("b1", "rb")], [
      { type: "text", text: "doneB" },
    ]),
  ];
  const t = buildTrajectories(pairs)[0];
  assert.deepEqual(userPrompts(t), ["task A", "task B"]);
  assert.equal(observationFor(t, "a1")[0].content, "ra");
  assert.equal(observationFor(t, "b1")[0].content, "rb");
});

const headerAnd = (...texts) => ({ role: "user", content: texts.map((text) => ({ type: "text", text })) });
const resultAnd = (id, out, text) => ({
  role: "user",
  content: [
    { type: "tool_result", tool_use_id: id, content: out },
    { type: "text", text },
  ],
});

test("interleaved lineages with a shared header: no prompt is dropped", () => {
  const pairs = [
    claudePair([headerAnd("H", "task A")], [toolUse("a1")]),
    claudePair([headerAnd("H", "task B")], [toolUse("b1")]),
    claudePair([headerAnd("H", "task A"), assistant(toolUse("a1")), resultAnd("a1", "ra", "remA")], [
      { type: "text", text: "doneA" },
    ]),
    claudePair([headerAnd("H", "task B"), assistant(toolUse("b1")), resultAnd("b1", "rb", "remB")], [
      { type: "text", text: "doneB" },
    ]),
  ];
  const t = buildTrajectories(pairs)[0];
  // The shared header is emitted once; each lineage's own prompts all survive.
  assert.deepEqual(userPrompts(t), ["H", "task A", "task B", "remA", "remB"]);
});

test("a shorter interleaved lineage does not make the longer one re-emit", () => {
  const a1 = assistant(toolUse("a1"));
  const a2 = assistant(toolUse("a2"));
  const pairs = [
    claudePair([headerAnd("H", "taskA")], a1.content),
    claudePair([headerAnd("H", "taskA"), a1, resultAnd("a1", "x", "remA1")], a2.content),
    claudePair([headerAnd("H", "taskB")], [toolUse("b1")]),
    claudePair(
      [headerAnd("H", "taskA"), a1, resultAnd("a1", "x", "remA1"), a2, resultAnd("a2", "y", "remA2")],
      [{ type: "text", text: "doneA" }],
    ),
  ];
  const t = buildTrajectories(pairs)[0];
  assert.deepEqual(userPrompts(t), ["H", "taskA", "remA1", "taskB", "remA2"]);
  assert.equal(observationFor(t, "a1").length, 1);
  assert.equal(observationFor(t, "a2").length, 1);
});

test("a retried request (first attempt got no reply) does not duplicate its prompt", () => {
  const failed = claudePair([userText("hello")], []);
  failed.response = { timestamp: failed.request.timestamp, status_code: 529, headers: {}, body: { type: "error" } };
  const pairs = [failed, claudePair([userText("hello")], [{ type: "text", text: "hi" }])];
  const t = buildTrajectories(pairs)[0];
  assert.deepEqual(userPrompts(t), ["hello"]);
});

test("after a /clear, a new prompt behind the same header is emitted", () => {
  const ok = assistant({ type: "text", text: "ok" });
  const pairs = [
    claudePair([headerAnd("H", "run tests")], ok.content),
    claudePair([headerAnd("H", "run tests"), ok, userText("fix it")], [{ type: "text", text: "ok2" }]),
    claudePair([headerAnd("H", "deploy")], [{ type: "text", text: "ok3" }]),
  ];
  const t = buildTrajectories(pairs)[0];
  assert.deepEqual(userPrompts(t), ["H", "run tests", "fix it", "deploy"]);
});

test("single-shot side calls re-sending a growing context emit each block once", () => {
  // Shape of Claude Code's auto-mode security monitor: every call is a fresh
  // one-message transcript replaying the same context plus the agent's actions.
  const pairs = [
    claudePair([headerAnd("CLAUDE.md context", "action 1")], [{ type: "text", text: "<severity>3" }]),
    claudePair([headerAnd("CLAUDE.md context", "action 1", "action 2")], [{ type: "text", text: "<severity>3" }]),
    claudePair([headerAnd("CLAUDE.md context", "action 1", "action 2")], [{ type: "text", text: "<severity>3" }]),
  ];
  const t = buildTrajectories(pairs)[0];
  assert.deepEqual(userPrompts(t), ["CLAUDE.md context", "action 1", "action 2"]);
});
