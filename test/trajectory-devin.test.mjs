import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { buildTrajectories, DevinAdapter } from "../dist/trajectory/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, "..", "src", "trajectory", "__fixtures__");

function loadJsonl(name) {
  return fs
    .readFileSync(path.join(FIX, name), "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("Devin: reconstructs user → tool turn → final answer", () => {
  const pairs = loadJsonl("devin-tooluse.jsonl");
  const trajs = buildTrajectories(pairs);

  assert.equal(trajs.length, 1);
  const t = trajs[0];
  assert.equal(t.agent.name, "devin");
  assert.equal(t.agent.model, "claude-sonnet-4-6");
  assert.equal(t.sessionId, "devin:test-sess");

  const roles = t.steps.map((s) => s.role);
  assert.deepEqual(roles, ["user", "agent", "agent"]);

  // User prompt.
  assert.equal(t.steps[0].message, "List the files");

  // First agent turn: text + one tool call + stitched observation.
  const turnA = t.steps[1];
  assert.equal(turnA.message, "I'll list them.");
  assert.equal(turnA.toolCalls.length, 1);
  assert.equal(turnA.toolCalls[0].name, "exec");
  assert.deepEqual(turnA.toolCalls[0].arguments, { command: "ls" });
  assert.equal(turnA.observation.results.length, 1);
  assert.equal(turnA.observation.results[0].sourceCallId, "toolu_bdrk_01");
  assert.equal(turnA.observation.results[0].content, "a.txt\nb.txt");

  // Second agent turn: final answer, no tool calls.
  assert.equal(t.steps[2].message, "There are two files: a.txt and b.txt.");
  assert.equal(t.steps[2].toolCalls.length, 0);
});

test("Devin: token metrics roll up (incl. cache tokens)", () => {
  const pairs = loadJsonl("devin-tooluse.jsonl");
  const t = buildTrajectories(pairs)[0];
  assert.equal(t.metrics.promptTokens, 15); // 10 + 5
  assert.equal(t.metrics.completionTokens, 35); // 20 + 15
  assert.equal(t.metrics.cacheReadTokens, 250); // 100 + 150
  assert.equal(t.metrics.cacheCreationTokens, 50); // 50 + 0
});

test("DevinAdapter: strict provider marker; ignores non-devin wire", () => {
  const adapter = new DevinAdapter();
  const devinPair = loadJsonl("devin-tooluse.jsonl")[0];
  assert.equal(adapter.matches(devinPair), true);

  // A bare Anthropic-shaped pair (messages[]) must NOT be claimed by Devin.
  const anthropicish = { request: { timestamp: 1, method: "POST", url: "x", headers: {}, body: { model: "claude-x", messages: [{ role: "user", content: "hi" }] } }, response: null, logged_at: "" };
  assert.equal(adapter.matches(anthropicish), false);

  // System prompt is extracted with volatile fragments normalized away.
  const sys = adapter.systemPromptText(devinPair);
  assert.ok(sys.includes("You are Devin"));
  assert.ok(sys.includes("[SYSTEM_INFO]"));
  assert.ok(!sys.includes("2026-07-08"));
});

test("Devin: a real Anthropic pair still routes to the claude adapter", () => {
  // Guards against DevinAdapter over-matching and stealing Anthropic traffic.
  const anthropicPair = {
    request: { timestamp: 1, method: "POST", url: "https://api.anthropic.com/v1/messages", headers: {}, body: { model: "claude-sonnet-4", system: "sys", messages: [{ role: "user", content: "hi" }] } },
    response: { timestamp: 2, status_code: 200, headers: {}, body: { model: "claude-sonnet-4", content: [{ type: "text", text: "hello" }], usage: { input_tokens: 1, output_tokens: 1 } } },
    logged_at: "",
  };
  const trajs = buildTrajectories([anthropicPair]);
  assert.equal(trajs.length, 1);
  assert.equal(trajs[0].agent.name, "claude");
});
