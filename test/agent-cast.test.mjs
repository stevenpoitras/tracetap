import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Store } from "../dist/store/index.js";

// The cast: which named agents ran in a session, and how many calls each made.
//
// Every rejection is paired with a positive twin. An empty cast is also what a
// store that never joins anything produces, so "unnamed stayed unnamed" only
// means something next to "named got named" from the same fixture.

let tmp;
let store;

const BILLING_SUB =
  "x-anthropic-billing-header: cc_client=claude_code; cc_is_subagent=true;";

function sse(outputTokens) {
  return (
    [
      `event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"claude-opus-4","content":[],"usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":${outputTokens}}}`,
      `event: message_stop\ndata: {"type":"message_stop"}`,
    ].join("\n\n") + "\n\n"
  );
}

function pair({ ts, system, messages }) {
  return {
    request: {
      timestamp: ts,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: { "content-type": "application/json" },
      body: { model: "claude-opus-4", system: [{ type: "text", text: system }], messages, stream: true },
    },
    response: {
      timestamp: ts + 1,
      status_code: 200,
      headers: { "content-type": "text/event-stream" },
      body_raw: sse(20),
    },
    logged_at: new Date(ts * 1000).toISOString(),
  };
}

/** A parent turn whose assistant content spawns `spawns` via the Agent tool. */
function parentPair(ts, spawns) {
  return pair({
    ts,
    system: "You are Claude Code. PARENT",
    messages: [
      { role: "user", content: [{ type: "text", text: "orchestrate the review" }] },
      {
        role: "assistant",
        content: spawns.map((s, i) => ({
          type: "tool_use",
          id: "tu_" + i,
          name: "Agent",
          input: { description: s.description, subagent_type: s.type, prompt: s.prompt },
        })),
      },
    ],
  });
}

/**
 * A child turn. The spawn prompt is NOT the first content block: Claude Code
 * prepends a `<system-reminder>`, and reading only the first block joined 0% of
 * a live 738-call log.
 */
function childPair(ts, promptText, { subagent = true } = {}) {
  return pair({
    ts,
    // One system prompt for every child, which is what makes them ONE session:
    // grouping is by system prompt, so a fan-out's agents land together.
    system: (subagent ? BILLING_SUB + "\n" : "") + "You are Claude Code. CHILD",
    messages: [
      { role: "user", content: [{ type: "text", text: "<system-reminder>\nCLAUDE.md…" }] },
      { role: "user", content: [{ type: "text", text: promptText }] },
    ],
  });
}

const CRITIC = {
  description: "Critique PR 366",
  type: "general-purpose",
  prompt: "Read PR 366 and report every blocking finding.",
};
const EXPLORER = {
  description: "Survey design docs",
  type: "Explore",
  prompt: "Find every design doc under docs/ and list what each one decides.",
};

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-cast-"));
  const dir = path.join(tmp, "proj", ".claude-trace");
  fs.mkdirSync(dir, { recursive: true });

  const pairs = [
    parentPair(1700200000, [CRITIC, EXPLORER]),
    // Two calls by the critic, one by the explorer — so "calls" cannot be
    // confused with "one row per agent".
    childPair(1700200010, CRITIC.prompt),
    childPair(1700200020, CRITIC.prompt),
    childPair(1700200030, EXPLORER.prompt),
    // Marked as a subagent, but its prompt was never spawned through the Agent
    // tool — a workflow-orchestrated agent. There is no name to be had.
    childPair(1700200040, "Do the thing the workflow asked for."),
  ];
  fs.writeFileSync(
    path.join(dir, "fanout.jsonl"),
    pairs.map((p) => JSON.stringify(p)).join("\n") + "\n",
  );

  store = new Store(path.join(tmp, "index.db"));
  store.indexPaths([path.join(tmp, "proj")]);
});

after(() => {
  try {
    store.close();
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The session holding the children — grouping is by system prompt. */
function childSession() {
  const s = store
    .listSessions()
    .find((x) => store.listRequests(x.sessionId).some((r) => r.isSubagent));
  assert.ok(s, "no session contains subagent calls");
  return s;
}

test("the cast names each agent and counts its calls, busiest first", () => {
  const cast = childSession().agentCast;
  assert.deepEqual(
    cast.map((a) => [a.label, a.type, a.calls]),
    [
      ["Critique PR 366", "general-purpose", 2],
      ["Survey design docs", "Explore", 1],
    ],
  );
});

test("a subagent with no captured spawn is counted, never named", () => {
  const s = childSession();
  assert.equal(s.unnamedAgentCalls, 1);
  // Twin: the same fixture DOES name the two that were spawned properly, so
  // this is a join that correctly missed and not a join that never ran.
  assert.equal(s.agentCast.length, 2);
});

test("a session with no subagent traffic has an empty cast, not a null one", () => {
  const parent = store
    .listSessions()
    .find((x) => store.listRequests(x.sessionId).every((r) => !r.isSubagent));
  assert.ok(parent, "the parent turn must be its own session");
  assert.deepEqual(parent.agentCast, []);
  assert.equal(parent.unnamedAgentCalls, 0);
});

test("the agent filter matches a subagent name, not just the harness family", () => {
  const byName = store.listSessions({ agent: "critique pr 366" });
  assert.deepEqual(byName.map((s) => s.sessionId), [childSession().sessionId]);

  // Twin 1: the type is searchable too, and picks the same session.
  assert.deepEqual(
    store.listSessions({ agent: "Explore" }).map((s) => s.sessionId),
    [childSession().sessionId],
  );
  // Twin 2: the harness family still matches everything, so the new clause
  // widened the filter rather than replacing what it used to do.
  assert.equal(store.listSessions({ agent: "claude" }).length, store.listSessions().length);
  // Twin 3: a name nobody used matches nothing — the LIKE is not matching all.
  assert.equal(store.listSessions({ agent: "Refactor the parser" }).length, 0);
});

test("getSession returns the same summary the list does", () => {
  const listed = childSession();
  const direct = store.getSession(listed.sessionId);
  assert.ok(direct);
  assert.deepEqual(direct.agentCast, listed.agentCast);
  assert.equal(direct.unnamedAgentCalls, listed.unnamedAgentCalls);
  // Twin: an id that does not exist is null rather than the first row, which
  // is the failure mode of filtering in SQL and forgetting the empty case.
  assert.equal(store.getSession("claude:nope"), null);
});
