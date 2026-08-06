import test from "node:test";
import assert from "node:assert/strict";
import { activityTitle, sessionTitle, isNoiseStep, clipTitle } from "../dist/store/title.js";

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

test("harness envelopes measured on the live index are skipped", () => {
  // Each of these titled real sessions before it was listed: the caveat wrapper
  // 5 of 86, the background-task notification 3, the post-compaction tool echo
  // 2. All three announce in their own text that they are not the user talking.
  assert.equal(isNoiseStep("<local-command-caveat>Caveat: The messages below…"), true);
  assert.equal(isNoiseStep("[SYSTEM NOTIFICATION - NOT USER INPUT]\nautomated event"), true);
  assert.equal(
    isNoiseStep('Called the Read tool with the following input: {"file_path":"/a/b.ts"}'),
    true,
  );
  assert.equal(isNoiseStep("Result of calling the Bash tool: ok"), true);
  // Twin: the tool-echo frame is matched whole, so ordinary prose that starts
  // with the same word survives.
  assert.equal(isNoiseStep("Called the shots on the release plan"), false);
  assert.equal(
    sessionTitle([
      "<local-command-caveat>Caveat: The messages below…",
      "[SYSTEM NOTIFICATION - NOT USER INPUT]\nautomated event",
      'Called the Read tool with the following input: {"file_path":"/a/b.ts"}',
      "Survey the design corpus and propose a consolidation",
    ]),
    "Survey the design corpus and propose a consolidation",
  );
});

test("hook stdout and mid-turn interjections are not the session's ask", () => {
  assert.equal(isNoiseStep("UserPromptSubmit hook success: [01:14 CDT — sp]\nNote: …"), true);
  // Matched on the `<Event> hook <outcome>` frame, so a variant nobody listed
  // is caught too — three shapes appeared across one 86-session index.
  assert.equal(isNoiseStep("UserPromptSubmit hook additional context: [02:36 CDT]"), true);
  assert.equal(isNoiseStep("SessionStart hook additional context: you are in learning mode"), true);
  assert.equal(isNoiseStep("PreToolUse hook failed: exit 2"), true);
  // Twin: prose about hooks is still an ask.
  assert.equal(isNoiseStep("the hook additional context is wrong, please fix"), false);
  // The words after this frame ARE the user's, but they are an aside inside a
  // running turn — one live session would have been titled "proud of you!".
  assert.equal(
    isNoiseStep("The user sent a new message while you were working:\nproud of you!"),
    true,
  );
  // Twin: an ask that merely mentions the user sending messages survives.
  assert.equal(isNoiseStep("The user sent a new message to the wrong channel — fix it"), false);
});

test("a <session> wrapper is OPENED, because its contents are the ask", () => {
  // Claude Code's own title-generation call hands the model the conversation it
  // is naming, wrapped, followed by instructions. The wrapper is scaffolding;
  // what it holds is the only real ask in that session.
  assert.equal(
    sessionTitle([
      "<session>\nfor the context storage via MCP, what resources would you expose?\n</session>\n\n" +
        "Write the title in the predominant language of the session.",
    ]),
    "for the context storage via MCP, what resources would you expose?",
  );
  // The same shape ships under a second tag name.
  assert.equal(
    sessionTitle(["<conversation>\n# Fix the Wire pane renderers\n</conversation>\nSummarise."]),
    "# Fix the Wire pane renderers",
  );
  // Twin: an UNCLOSED tag is not a wrapper, so nothing is silently unwrapped.
  assert.equal(sessionTitle(["<session>\nhalf a wrapper"]), "<session> half a wrapper");
});

test("a concatenated transcript dump is not an ask", () => {
  // Auxiliary calls (permission checks, title generation) are handed the whole
  // transcript as ONE user message — several envelopes joined, which is the tell
  // that no single person typed it.
  const dump = '{"Bash":"git status"} {"user":"<command-name>/model</command-name>"}';
  assert.equal(isNoiseStep(dump), true);
  // Twin: ONE well-formed envelope still yields its ask, so the rule keys on
  // "does not parse", not on "starts with a brace".
  assert.equal(isNoiseStep('{"user":"ship the release"}'), false);
  assert.equal(sessionTitle([dump, '{"user":"ship the release"}']), "ship the release");
});

test("both halves of the transcript wrapper are skipped", () => {
  assert.equal(isNoiseStep("</transcript>"), true);
  assert.equal(isNoiseStep("Subagent has finished and is handing back control to the main agent."), true);
  // Twin: the wrapper skips do not swallow the ask that follows them.
  assert.equal(
    sessionTitle(["<transcript>", "</transcript>", "rename the pane"]),
    "rename the pane",
  );
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

// -- shapes measured on the 82 live main-thread sessions --------------------

test("the cancel marker is the harness narrating, not the user", () => {
  assert.equal(isNoiseStep("[Request interrupted by user]"), true);
  // Twin: this is the real shape from claude:7d1305b6, where the marker sat
  // between two genuine messages and used to win the title outright.
  assert.equal(
    sessionTitle([
      "[Request interrupted by user] ",
      "you should be searching in the filesystem as well",
    ]),
    "you should be searching in the filesystem as well",
  );
});

test("the output-style banner is skipped for any style name", () => {
  assert.equal(isNoiseStep("Learning output style is active. Remember to follow…"), true);
  assert.equal(isNoiseStep("Explanatory output style is active. Remember to follow…"), true);
  // Matched on the frame, so a style that did not exist when this was written
  // is skipped too.
  assert.equal(isNoiseStep("Socratic Tutor output style is active. Remember…"), true);
  // Twin: prose about output styles is still an ask.
  assert.equal(isNoiseStep("the output style is active but wrong, please fix"), false);
});

test("a fetched web page echoed back is not an ask", () => {
  assert.equal(isNoiseStep(" Web page content: --- > ## Documentation Index"), true);
  // Twin: the prefix carries the colon, so prose that merely opens with those
  // words is untouched.
  assert.equal(isNoiseStep("Web page content is missing from the report"), false);
  // Twin: the skip does not swallow a following ask.
  assert.equal(
    sessionTitle(["Web page content: --- > ## Docs", "summarise that page"]),
    "summarise that page",
  );
});

test("a mid-turn interjection titles a session that has nothing else", () => {
  const aside =
    "The user sent a new message while you were working: are you checking the messages?\n\n" +
    "This is how Claude Code surfaces messages the user sends mid-turn — within the running turn.";
  // Pass 1 still prefers a standalone ask, so the aside does NOT win here.
  assert.equal(sessionTitle([aside, "rewrite the parser"]), "rewrite the parser");
  // Pass 2: with no standalone ask, the user's own words beat an empty row —
  // and the explanation addressed to the model is stripped off.
  assert.equal(sessionTitle([aside]), "are you checking the messages?");
  // It is still noise for pass 1, which is what makes the ordering above hold.
  assert.equal(isNoiseStep(aside), true);
});

test("a role-assignment prompt is clipped to the clause naming the job", () => {
  assert.equal(
    sessionTitle([
      "You are an INDEPENDENT REVIEWER for PR #390 in the repo at /Users/sp/Documents/git/eMachina (GitHub: x/y)",
    ]),
    "You are an INDEPENDENT REVIEWER for PR #390 in the repo at…",
  );
  assert.equal(
    sessionTitle(["You are summarizing a Claude Code session for a daily memory log. Read the conversation…"]),
    "You are summarizing a Claude Code session for a daily memory log.",
  );
  // An ordinary ask is untouched by the clipping — it only applies to the
  // role frame, so a normal sentence keeps everything up to the 120-char clip.
  assert.equal(
    sessionTitle(["Fix the login bug. It fails on empty passwords."]),
    "Fix the login bug. It fails on empty passwords.",
  );
  // A role prompt with no break is returned whole rather than truncated away.
  assert.equal(sessionTitle(["You are a careful reviewer"]), "You are a careful reviewer");
});

test("activityTitle names the tool mix, ordered by count then name", () => {
  assert.equal(
    activityTitle({ Read: 12, Bash: 34, Grep: 9, Edit: 1 }),
    "Bash ×34 · Read ×12 · Grep ×9",
  );
  // Ties break on name so the label is stable between reads.
  assert.equal(activityTitle({ Zed: 5, Ack: 5 }, 2), "Ack ×5 · Zed ×5");
  // Nothing to say is still nothing to say — no invented placeholder.
  assert.equal(activityTitle({}), "");
  assert.equal(activityTitle({ Bash: 0 }), "");
  assert.equal(activityTitle(undefined), "");
});
