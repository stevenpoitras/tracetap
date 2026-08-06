import assert from "node:assert/strict";
import { test } from "node:test";

import {
    computeToolsetTax,
    normalizeToolDefinition,
    toolName,
    toolsetFromBody,
} from "../dist/context/tooltax.js";

const READ = { name: "Read", description: "Read a file", input_schema: {} };
const SLEEPER = {
  name: "SleeperTool",
  description: "x".repeat(400),
  input_schema: { type: "object", properties: {} },
};

test("toolName handles Anthropic and chat-completions shapes", () => {
  assert.equal(toolName({ name: "Read" }), "Read");
  assert.equal(toolName({ function: { name: "read_file" } }), "read_file");
  assert.equal(toolName(null), "");
  assert.equal(toolName({ description: "no name" }), "");
});

test("normalizeToolDefinition strips cache_control only", () => {
  const norm = normalizeToolDefinition({ ...READ, cache_control: { type: "ephemeral" } });
  assert.deepEqual(norm, READ);
});

test("toolsetFromBody sizes each tool and preserves wire order", () => {
  const ts = toolsetFromBody({ tools: [SLEEPER, READ] });
  assert.ok(ts);
  assert.equal(ts.tools.length, 2);
  assert.equal(ts.tools[0].name, "SleeperTool");
  assert.equal(ts.tools[1].name, "Read");
  for (const t of ts.tools) {
    assert.equal(t.approxTokens, Math.ceil(t.chars / 4));
    assert.equal(t.chars, JSON.stringify(t.name === "Read" ? READ : SLEEPER).length);
  }
  assert.equal(ts.totalChars, ts.tools[0].chars + ts.tools[1].chars);
  assert.equal(ts.totalApproxTokens, ts.tools[0].approxTokens + ts.tools[1].approxTokens);
});

test("toolset hash is stable under declaration order and cache_control", () => {
  const a = toolsetFromBody({ tools: [READ, SLEEPER] });
  const b = toolsetFromBody({
    tools: [{ ...SLEEPER, cache_control: { type: "ephemeral" } }, READ],
  });
  assert.equal(a.hash, b.hash);
  const c = toolsetFromBody({ tools: [READ] });
  assert.notEqual(a.hash, c.hash);
});

test("toolsetFromBody returns null when nothing is declared", () => {
  assert.equal(toolsetFromBody(null), null);
  assert.equal(toolsetFromBody({}), null);
  assert.equal(toolsetFromBody({ tools: [] }), null);
});

test("toolsetFromBody reads OpenAI-ish tools_list and names unnamed tools", () => {
  const ts = toolsetFromBody({ tools_list: [{ description: "mystery" }] });
  assert.ok(ts);
  assert.equal(ts.tools[0].name, "(unnamed)");
});

test("computeToolsetTax crosses declared sizes with the call histogram", () => {
  const perTool = [
    { name: "Read", approxTokens: 100 },
    { name: "SleeperTool", approxTokens: 900 },
  ];
  const tax = computeToolsetTax("hash1", perTool, { Read: 3 }, 10, 1.5);
  assert.equal(tax.declaredCount, 2);
  assert.equal(tax.calledCount, 1);
  assert.equal(tax.deadCount, 1);
  assert.equal(tax.deadTokensPerRequest, 900);
  assert.equal(tax.deadTokensCumulative, 9000);
  // 9000 dead tokens at $1.5 per 1M cache-read tokens.
  assert.ok(Math.abs(tax.deadCostUsd - 0.0135) < 1e-9);
  // Ranked by cumulative cost: the dead 900-token tool outranks the live one.
  assert.equal(tax.tools[0].name, "SleeperTool");
  assert.equal(tax.tools[0].dead, true);
  assert.equal(tax.tools[0].cumulativeTokens, 9000);
  assert.equal(tax.tools[1].calls, 3);
  assert.equal(tax.tools[1].dead, false);
});

test("computeToolsetTax with no price yields null cost, not zero", () => {
  const tax = computeToolsetTax("h", [{ name: "A", approxTokens: 10 }], {}, 2, null);
  assert.equal(tax.deadCostUsd, null);
  assert.equal(tax.deadTokensCumulative, 20);
});
