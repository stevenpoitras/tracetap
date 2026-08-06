import assert from "node:assert/strict";
import { test } from "node:test";

import { buildStdinPreview } from "../dist/hooks/tap.js";

/**
 * Join keys must survive capture.
 *
 * `buildStdinPreview`'s allowlist runs at CAPTURE time, so a key it drops is
 * gone from the event on disk forever — no reindex can bring it back. That is
 * what makes this different from an indexing bug: every hook that fires while
 * the allowlist is short is permanently unattributable.
 */
test("buildStdinPreview keeps the join keys Claude Code provides", () => {
  const out = buildStdinPreview({
    session_id: "s1",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu_0147L55M7Tpku4zRqFLMvj3Z",
    prompt_id: "9828edff-d039-471a-bd55-1f39c48cf92e",
    agent_id: "a7c72e93914dfb111",
    agent_type: "general-purpose",
    source: "startup",
  });
  // tool_use_id is the exact key pairing a PreToolUse hook to the call it gated
  // and to the matching PostToolUse; prompt_id partitions a flat hook stream
  // into turns; agent_id says which subagent fired it.
  assert.equal(out.tool_use_id, "toolu_0147L55M7Tpku4zRqFLMvj3Z");
  assert.equal(out.prompt_id, "9828edff-d039-471a-bd55-1f39c48cf92e");
  assert.equal(out.agent_id, "a7c72e93914dfb111");
  assert.equal(out.agent_type, "general-purpose");
  assert.equal(out.source, "startup");
});

test("buildStdinPreview still drops bulk and secret-prone payload", () => {
  // The allowlist widened for identifiers only. Free text must stay summarized,
  // since these events are indexed without --redact-bodies.
  const out = buildStdinPreview({
    session_id: "s1",
    prompt: "x".repeat(500),
    last_assistant_message: "y".repeat(900),
    tool_response: "z".repeat(9000),
  });
  assert.equal(out.prompt, undefined, "raw prompt must not be copied verbatim");
  assert.equal(out.prompt_chars, 500);
  assert.equal(out.last_assistant_chars, 900);
  assert.equal(out.tool_response, undefined, "tool output is not an identifier");
});

test("widening the allowlist did not let the sensitive neighbours through", () => {
  // The fence is the list itself — nothing caps or sanitizes a key once it is
  // on it. So the property worth pinning is which keys are NOT on it. These all
  // travel on the same hook stdin as the join keys, and session_title in
  // particular is a summary of the user's ask, present on SessionStart and
  // UserPromptSubmit.
  const out = buildStdinPreview({
    session_id: "s1",
    hook_event_name: "SessionStart",
    tool_use_id: "toolu_keepme",
    session_title: "Rotate the production database credentials",
    compact_summary: "s".repeat(4000),
    custom_instructions: "c".repeat(4000),
    error_details: "e".repeat(4000),
    message: "m".repeat(4000),
  });
  assert.equal(out.tool_use_id, "toolu_keepme", "the join key still lands");
  for (const k of [
    "session_title",
    "compact_summary",
    "custom_instructions",
    "error_details",
    "message",
  ]) {
    assert.ok(!(k in out), `${k} must stay outside the redaction fence`);
  }
  assert.ok(!JSON.stringify(out).includes("production database"));
});

test("absent join keys stay absent rather than becoming null", () => {
  // The allowlist copies only keys that are actually present, so a harness that
  // does not send them leaves no empty columns behind for consumers to guess at.
  const out = buildStdinPreview({ session_id: "s1", hook_event_name: "Stop" });
  assert.ok(!("tool_use_id" in out));
  assert.ok(!("prompt_id" in out));
  assert.equal(out.session_id, "s1");
});
