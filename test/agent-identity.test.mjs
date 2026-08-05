import assert from "node:assert/strict";
import { test } from "node:test";

import {
  billingHeader,
  identifyRequest,
  isSubagentCall,
  normalizePrompt,
  spawnIndex,
  spawnsIn,
  userText,
} from "../dist/trajectory/agent-identity.js";

/**
 * Agent identity: which conversation a wire call belongs to.
 *
 * A session that spawns a fleet writes every agent into one log under one
 * session id, so anything that diffs neighbouring requests was comparing
 * across unrelated conversations. Both signals used here were verified against
 * a live 738-call capture; the two regression tests at the bottom encode
 * mistakes that capture exposed.
 */

const sys = (text) => ({ request: { body: { system: text, messages: [] } } });

const call = (systemText, userBlocks) => ({
  request: {
    body: {
      system: systemText,
      messages: [{ role: "user", content: userBlocks.map((t) => ({ type: "text", text: t })) }],
    },
  },
});

const parentWithSpawns = (spawns) => ({
  request: {
    body: {
      system: "You are Claude Code.",
      messages: [
        {
          role: "assistant",
          content: spawns.map((s, i) => ({
            type: "tool_use",
            id: "toolu_" + i,
            name: "Agent",
            input: { description: s.d, subagent_type: s.t ?? "general-purpose", prompt: s.p },
          })),
        },
      ],
    },
  },
});

const BILLING = "x-anthropic-billing-header: cc_version=2.1.220.b9b; cc_entrypoint=cli; cc_is_subagent=true;";
const BILLING_MAIN = "x-anthropic-billing-header: cc_version=2.1.220.3fc; cc_entrypoint=cli;";

// -- the subagent marking -------------------------------------------------

test("reads the billing header Claude Code embeds in the system prompt", () => {
  const h = billingHeader(sys(BILLING + "\nYou are a subagent."));
  assert.equal(h.cc_is_subagent, "true");
  assert.equal(h.cc_entrypoint, "cli");
  assert.equal(h.cc_version, "2.1.220.b9b");
});

test("main-thread calls omit cc_is_subagent entirely", () => {
  assert.equal(isSubagentCall(sys(BILLING_MAIN)), false);
  assert.equal(isSubagentCall(sys(BILLING)), true);
});

test("a system prompt sent as content blocks is still parsed", () => {
  // The field is a string on some calls and an array on others; identity must
  // not depend on which shape a given request happened to use.
  const pair = { request: { body: { system: [{ type: "text", text: BILLING }] } } };
  assert.equal(isSubagentCall(pair), true);
});

test("no billing header at all is not a subagent, and does not throw", () => {
  assert.equal(isSubagentCall(sys("You are Claude Code.")), false);
  assert.equal(isSubagentCall({}), false);
  assert.deepEqual(billingHeader({}), {});
});

// -- the parent-side spawn record -----------------------------------------

test("spawns carry the human-readable description and the subagent type", () => {
  const s = spawnsIn(parentWithSpawns([{ d: "Survey open PRs", t: "general-purpose", p: "Look at the PRs." }]));
  assert.equal(s.length, 1);
  assert.equal(s[0].description, "Survey open PRs");
  assert.equal(s[0].subagentType, "general-purpose");
  assert.equal(s[0].prompt, "Look at the PRs.");
});

test("a spawn with no description is labelled, not dropped", () => {
  const s = spawnsIn(parentWithSpawns([{ d: "", p: "do a thing" }]));
  assert.equal(s[0].description, "(unnamed agent)");
});

// -- the join --------------------------------------------------------------

test("a subagent call is named from its parent's spawn record", () => {
  const index = spawnIndex([parentWithSpawns([{ d: "Survey open PRs", p: "Look at the open PRs and report." }])]);
  const child = call(BILLING, ["<system-reminder>project context</system-reminder>", "Look at the open PRs and report."]);
  const id = identifyRequest(child, index);
  assert.equal(id.isSubagent, true);
  assert.equal(id.label, "Survey open PRs");
  assert.equal(id.subagentType, "general-purpose");
});

test("a main-thread call is never given an agent label", () => {
  const index = spawnIndex([parentWithSpawns([{ d: "Survey open PRs", p: "Look at the open PRs." }])]);
  const id = identifyRequest(call(BILLING_MAIN, ["Look at the open PRs."]), index);
  assert.deepEqual(id, { isSubagent: false, label: null, subagentType: null });
});

test("an unmatched subagent stays subagent with a null label", () => {
  // Workflow-orchestrated agents are marked cc_is_subagent but were never
  // spawned through the Agent tool, so no parent record exists. On the live
  // capture that was 271 of 430 subagent calls. Reporting "subagent, unnamed"
  // is honest; inventing a name is not.
  const id = identifyRequest(call(BILLING, ["something nobody spawned"]), spawnIndex([]));
  assert.deepEqual(id, { isSubagent: true, label: null, subagentType: null });
});

// -- regressions the live capture exposed ----------------------------------

test("the prompt is found past the <system-reminder> preamble", () => {
  // Reading only the FIRST text block gave a 0% join rate on 738 real calls:
  // Claude Code prepends a system-reminder carrying CLAUDE.md, so a child's
  // first block is boilerplate every time.
  const index = spawnIndex([parentWithSpawns([{ d: "Audit env", p: "Audit the workspace." }])]);
  const child = call(BILLING, [
    "<system-reminder>As you answer, use the following context: # claudeMd …</system-reminder>",
    "Audit the workspace.",
  ]);
  assert.equal(identifyRequest(child, index).label, "Audit env");
  assert.ok(userText(child).includes("Audit the workspace."));
});

test("agents sharing a long preamble are told apart", () => {
  // "Survey design docs part 1" and "part 2" were byte-identical for their
  // first 200 characters. Keying on a prefix attributed every part-2 call to
  // part 1 — a wrong answer that looked entirely plausible.
  const preamble =
    "Read-only survey. Repo: /Users/sp/Documents/git/eMachina. Change NOTHING. " +
    "Survey these design doc directories and report what you find, in detail, " +
    "with paths and one-line summaries for every document you encounter. ";
  const index = spawnIndex([
    parentWithSpawns([
      { d: "Survey design docs part 1", p: preamble + "Directory: docs/a" },
      { d: "Survey design docs part 2", p: preamble + "Directory: docs/b" },
    ]),
  ]);
  assert.ok(preamble.length > 200, "preamble must exceed any prefix key to be a real test");
  assert.equal(identifyRequest(call(BILLING, [preamble + "Directory: docs/b"]), index).label, "Survey design docs part 2");
  assert.equal(identifyRequest(call(BILLING, [preamble + "Directory: docs/a"]), index).label, "Survey design docs part 1");
});

test("a longer spawn prompt wins over one that is its prefix", () => {
  const index = spawnIndex([
    parentWithSpawns([
      { d: "Short", p: "Do the thing." },
      { d: "Long", p: "Do the thing. Then do the other thing." },
    ]),
  ]);
  assert.equal(identifyRequest(call(BILLING, ["Do the thing. Then do the other thing."]), index).label, "Long");
});

test("normalizePrompt collapses whitespace on both sides of the join", () => {
  assert.equal(normalizePrompt("  a\n\n  b\tc  "), "a b c");
});
