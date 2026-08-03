import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Store } from "../dist/store/index.js";
import { buildStdinPreview } from "../dist/hooks/tap.js";
import { AnthropicAdapter } from "../dist/trajectory/anthropic.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const TRAJ_FIX = path.join(ROOT, "src", "trajectory", "__fixtures__");

/**
 * Capture and attribution correctness.
 *
 * Three independent defects, all of which silently produced confident-looking
 * but wrong data:
 *   1. join keys discarded at capture time (unrecoverable by reindexing)
 *   2. hooks attributed to sessions by clock alone, across every project
 *   3. count_tokens sizing probes indexed as if they were model calls
 */

let tmp;
let store;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-attrib-"));
  const projDir = path.join(tmp, "proj", ".claude-trace");
  const hooksDir = path.join(tmp, "hooks");
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.copyFileSync(
    path.join(TRAJ_FIX, "claude-tooluse.jsonl"),
    path.join(projDir, "claude.jsonl"),
  );

  store = new Store(path.join(tmp, "index.db"));
  store.indexPaths([path.join(tmp, "proj")]);

  const sessions = store.listSessions({});
  const s = sessions[0];
  // Hooks straddling the session window: one from this project, one from a
  // different repo entirely, both well inside the +/-600s slack.
  const mid = s.startedAt + 1;
  const line = (o) => JSON.stringify(o);
  fs.writeFileSync(
    path.join(hooksDir, "cwd-test.jsonl"),
    [
      line({
        v: 1,
        ts: new Date(mid * 1000).toISOString(),
        session_id: "cwd-test",
        event: "PreToolUse",
        hook_name: "mine",
        duration_ms: 1,
        decision: null,
        stdin_digest: "a".repeat(64),
        stdin_preview: { cwd: s.projectCwd, tool_name: "Bash" },
        stdout_preview: { chars: 0 },
        outcome: "ok",
        exit_code: 0,
      }),
      line({
        v: 1,
        ts: new Date(mid * 1000).toISOString(),
        session_id: "cwd-test",
        event: "PreToolUse",
        hook_name: "foreign",
        duration_ms: 1,
        decision: null,
        stdin_digest: "b".repeat(64),
        stdin_preview: { cwd: "/somewhere/else/entirely", tool_name: "Bash" },
        stdout_preview: { chars: 0 },
        outcome: "ok",
        exit_code: 0,
      }),
      line({
        v: 1,
        ts: new Date(mid * 1000).toISOString(),
        session_id: "cwd-test",
        event: "PreToolUse",
        hook_name: "legacy",
        duration_ms: 1,
        decision: null,
        stdin_digest: "c".repeat(64),
        stdin_preview: { tool_name: "Bash" }, // captured before cwd was recorded
        stdout_preview: { chars: 0 },
        outcome: "ok",
        exit_code: 0,
      }),
    ].join("\n") + "\n",
  );
  store.indexHooks(hooksDir);
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// -- 1. join keys survive capture ------------------------------------------

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
  assert.equal(out.tool_use_id, "toolu_0147L55M7Tpku4zRqFLMvj3Z");
  assert.equal(out.prompt_id, "9828edff-d039-471a-bd55-1f39c48cf92e");
  assert.equal(out.agent_id, "a7c72e93914dfb111");
  assert.equal(out.agent_type, "general-purpose");
  assert.equal(out.source, "startup");
});

test("buildStdinPreview still drops bulk payload fields", () => {
  const out = buildStdinPreview({
    session_id: "s1",
    prompt: "x".repeat(500),
    last_assistant_message: "y".repeat(900),
    tool_response: "z".repeat(9000),
  });
  assert.equal(out.prompt, undefined, "raw prompt must not be copied verbatim");
  assert.equal(out.prompt_chars, 500);
  assert.equal(out.last_assistant_chars, 900);
  assert.equal(out.tool_response, undefined);
});

// -- 2. attribution --------------------------------------------------------

test("hooks from another project are not attributed to this session", () => {
  const s = store.listSessions({})[0];
  const names = store.listHooksForSession(s.sessionId).map((h) => h.hookName);
  assert.ok(names.includes("mine"), "same-cwd hook should attach");
  assert.ok(
    !names.includes("foreign"),
    "a hook fired in a different repo must never attach by time alone",
  );
});

test("a hook with no recorded cwd still attaches", () => {
  // Absence of cwd is not evidence of being foreign. Events captured before cwd
  // was recorded must keep showing up where they do today.
  const s = store.listSessions({})[0];
  const names = store.listHooksForSession(s.sessionId).map((h) => h.hookName);
  assert.ok(
    names.includes("legacy"),
    "unknown cwd must be treated as unproven, not excluded",
  );
});

test("a session with no real time span gets no time-window hooks", () => {
  // endedAt <= startedAt means the span is a single instant; +/-600s around an
  // instant swept up every concurrent session on the machine.
  const fake = {
    sessionId: "claude:instant",
    startedAt: 0,
    endedAt: 0,
    projectCwd: "/tmp/whatever",
  };
  const rows = store.listHooksForSession(fake.sessionId);
  assert.deepEqual(rows, [], "unknown/degenerate session must not match by time");
});

// -- 3. count_tokens probes are not model calls ----------------------------

test("count_tokens probes are rejected by the Anthropic adapter", () => {
  const a = new AnthropicAdapter();
  const probe = {
    request: {
      timestamp: 1,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages/count_tokens?beta=true",
      headers: {},
      body: { model: "claude-opus-5", messages: [{ role: "user", content: "hi" }] },
    },
    response: { timestamp: 2, status: 200, headers: {}, body: { input_tokens: 6062 } },
  };
  assert.equal(a.matches(probe), false, "sizing probe must not become a turn");
});

test("real /v1/messages calls still match", () => {
  const a = new AnthropicAdapter();
  const real = {
    request: {
      timestamp: 1,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: {},
      body: { model: "claude-opus-5", messages: [{ role: "user", content: "hi" }] },
    },
    response: { timestamp: 2, status: 200, headers: {}, body: {} },
  };
  assert.equal(a.matches(real), true);
});
