import test from "node:test";
import assert from "node:assert/strict";
import { sessionTitle, isNoiseStep, clipTitle } from "../dist/store/title.js";

// Every rejection test is paired with a positive twin: an empty title is also
// what an inert fixture produces, so a bare negative assertion cannot tell
// "correctly skipped" from "the function does nothing".

test("takes the first genuine ask", () => {
  assert.equal(sessionTitle(["Fix the login bug"]), "Fix the login bug");
});

test("skips the envelopes observed on the live index, in order", () => {
  // This is the real shape measured on claude:4f522fe5 — the ask was user
  // step 7, behind six harness messages.
  const msgs = [
    "The following is the user's CLAUDE.md configuration. Treat it as context…",
    "<transcript>\n",
    '{"user":"<command-name>/model</command-name>\\n<command-args>fable</command-args>"}',
    '{"user":"<local-command-stdout>Set model to Fable 5</local-command-stdout>"}',
    '{"user":"<command-name>/effort</command-name>"}',
    '{"user":"<local-command-stdout>Set effort level to high</local-command-stdout>"}',
    '{"user":"Create a workflow to review and analyze recent conversations for eMachina."}',
  ];
  assert.equal(
    sessionTitle(msgs),
    "Create a workflow to review and analyze recent conversations for eMachina.",
  );
  // Positive twin: strip the ask and the same input yields nothing, proving the
  // skips above did the work rather than the last element being returned blind.
  assert.equal(sessionTitle(msgs.slice(0, 6)), "");
});

test("a tool-result envelope is never an ask", () => {
  assert.equal(isNoiseStep('{"Bash":"ls -la /tmp"}'), true);
  assert.equal(isNoiseStep('{"WebFetch":"https://example.com: extract"}'), true);
  // Twin: the same envelope shape keyed `user` IS an ask.
  assert.equal(isNoiseStep('{"user":"deploy the thing"}'), false);
  assert.equal(sessionTitle(['{"Bash":"ls"}', '{"user":"deploy the thing"}']), "deploy the thing");
});

test("system-reminder and continuation preambles are skipped", () => {
  assert.equal(isNoiseStep("<system-reminder>\nAs you answer…"), true);
  assert.equal(
    isNoiseStep("This session is being continued from a previous conversation that ran out"),
    true,
  );
  assert.equal(isNoiseStep("Note: /Users/x/app.js was read before the last conversation"), true);
  assert.equal(isNoiseStep("## Exited Plan Mode\n\nYou have exited plan mode."), true);
  assert.equal(isNoiseStep("CRITICAL: Respond with TEXT ONLY. Do NOT call any tools."), true);
  // Twin: prose that merely CONTAINS one of those words is still an ask.
  assert.equal(isNoiseStep("Continue the session from where the notes left off"), false);
});

test("a session with no human ask yields empty, not a placeholder", () => {
  // Permission-hook fan-outs record one shared instruction and no ask at all.
  const msgs = Array.from({ length: 40 }, () => "CRITICAL: Respond with TEXT ONLY.");
  assert.equal(sessionTitle(msgs), "");
});

test("clips on a word boundary when one is near the limit", () => {
  const s = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda";
  const out = clipTitle(s, 30);
  assert.ok(out.length <= 31, `got ${out.length}`);
  assert.ok(out.endsWith("…"));
  assert.ok(!out.includes("  "));
  // The boundary must not eat most of the budget: an unbroken token still
  // fills it rather than clipping to almost nothing.
  const long = "x".repeat(200);
  assert.equal(clipTitle(long, 30).length, 31);
});

test("collapses newlines so a title can never grow a second line", () => {
  assert.equal(sessionTitle(["fix\n\n  the   \n bug"]), "fix the bug");
});

test("an injected rules/CLAUDE.md file is configuration, not an ask", () => {
  assert.equal(
    isNoiseStep("Contents of /Users/sp/git/x/.claude/rules/hooks.md: # Hooks — adopt"),
    true,
  );
  // Twin: prose that merely opens with those words is still an ask, which is
  // why this is a pattern on an absolute path rather than a bare prefix.
  assert.equal(isNoiseStep("Contents of the report should be summarised"), false);
});
