import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Store } from "../dist/store/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRAJ_FIX = path.join(__dirname, "..", "src", "trajectory", "__fixtures__");

/**
 * The hook time join is only reachable when a session has no `claude_session_id`
 * to join on, so these all use the plain fixture (no `x-claude-code-session-id`
 * header) rather than the identified one.
 */
function makeClaudeStore(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const claudeDir = path.join(dir, "proj", ".claude-trace");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.copyFileSync(path.join(TRAJ_FIX, "claude-tooluse.jsonl"), path.join(claudeDir, "claude.jsonl"));
  const s = new Store(path.join(dir, "index.db"));
  s.indexPaths([path.join(dir, "proj")]);
  return { dir, store: s, session: s.listSessions({ agent: "claude" })[0] };
}

/** One hook-tap JSONL event, timed inside the claude fixture's window. */
function hookEvent(overrides) {
  return {
    v: 1,
    ts: "2023-11-14T22:13:19.000Z",
    session_id: "hook-a",
    event: "UserPromptSubmit",
    hook_name: "h",
    duration_ms: 1,
    decision: null,
    stdin_digest: "c".repeat(64),
    stdin_preview: {},
    stdout_preview: { chars: 0 },
    outcome: "ok",
    exit_code: 0,
    ...overrides,
  };
}

function writeHookLog(dir, name, events) {
  fs.writeFileSync(path.join(dir, name), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

/** Seed a foreign hook that carries NO cwd, so only the window can exclude it. */
function seedForeignHook(dir, s) {
  const hooksDir = path.join(dir, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  writeHookLog(hooksDir, "foreign.jsonl", [
    hookEvent({ session_id: "hook-foreign", payload: { prompt: "FOREIGN-SECRET" } }),
  ]);
  s.indexHooks(hooksDir);
  return hooksDir;
}

function setWindow(s, sessionId, startedAt, endedAt) {
  s.db
    .prepare("UPDATE sessions SET started_at = ?, ended_at = ? WHERE session_id = ?")
    .run(startedAt, endedAt, sessionId);
}

/**
 * A degenerate window is not a window.
 *
 * The cwd fence is the only other thing filtering the time arm, and it passes a
 * hook with no recorded cwd by design (absence is not evidence of being
 * foreign). So when the window itself is meaningless, nothing is left holding
 * the line — the join reaches every hook ever captured. These pin the guard
 * that keeps the time arm from running at all in that case.
 */
test("a session with no window does not fall back to scanning every hook", () => {
  const { dir, store: s, session } = makeClaudeStore("tracetap-hookzero-");
  try {
    seedForeignHook(dir, s);
    // Baseline: with its real window intact, the cwd-less foreign hook IS served
    // — which is what makes the zero-window case a genuine leak and not a
    // no-op assertion.
    assert.ok(
      s.listHooksForSession(session.sessionId).length > 0,
      "the foreign hook is reachable while the window is real",
    );

    // What an un-reindexed or non-Claude capture looks like: no timestamps.
    setWindow(s, session.sessionId, 0, 0);

    const rows = s.listHooksForSession(session.sessionId);
    assert.equal(rows.length, 0, "0..MAX_SAFE_INTEGER is a table scan, not a time window");
    assert.ok(!JSON.stringify(rows).includes("FOREIGN-SECRET"));
  } finally {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an end before the start is treated as no window", () => {
  const { dir, store: s, session } = makeClaudeStore("tracetap-hookinv-");
  try {
    seedForeignHook(dir, s);
    const { startedAt } = s.getSession(session.sessionId);

    // Inverted bounds are corrupt data, not a time range.
    setWindow(s, session.sessionId, startedAt, startedAt - 60);
    assert.equal(s.listHooksForSession(session.sessionId).length, 0, "an inverted window is none");
  } finally {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a single-call session (start == end) still gets its hooks", () => {
  const { dir, store: s, session } = makeClaudeStore("tracetap-hookpoint-");
  try {
    seedForeignHook(dir, s);
    const { startedAt } = s.getSession(session.sessionId);

    // One API call stamps every step with the same time, so a one-call session
    // is always a point. Rejecting it emptied the Hooks pane for every such
    // session while the Stream grain still showed them.
    setWindow(s, session.sessionId, startedAt, startedAt);
    const rows = s.listHooksForSession(session.sessionId);
    assert.ok(rows.length > 0, "a point window must still match hooks within the slack");
    const flowHooks = s.sessionFlow(session.sessionId).nodes.filter((n) => n.kind === "hook");
    assert.equal(
      flowHooks.length > 0,
      rows.length > 0,
      "the Hooks pane and the Flow graph must agree on whether the session has hooks",
    );
  } finally {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The positive twins. A guard that just switched the time join off would pass
 * both tests above, so each rejection is paired with a case that must still
 * resolve.
 */
test("a real window still serves the hooks inside it", () => {
  const { dir, store: s, session } = makeClaudeStore("tracetap-hookreal-");
  try {
    const hooksDir = path.join(dir, "hooks");
    fs.mkdirSync(hooksDir);
    writeHookLog(hooksDir, "mine.jsonl", [
      hookEvent({ session_id: "hook-mine", payload: { prompt: "mine-full-payload" } }),
    ]);
    s.indexHooks(hooksDir);

    const rows = s.listHooksForSession(session.sessionId);
    assert.equal(rows.length, 1, "the time join still fires on a well-formed window");
    assert.equal(rows[0].payload.prompt, "mine-full-payload");
  } finally {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the window guard does not reach the identity join", () => {
  const { dir, store: s, session } = makeClaudeStore("tracetap-hookident-");
  try {
    const hooksDir = path.join(dir, "hooks");
    fs.mkdirSync(hooksDir);
    // Keyed by the wire session id: an exact identity match, which is evidence
    // independent of the clock.
    writeHookLog(hooksDir, "exact.jsonl", [
      hookEvent({ session_id: session.sessionId, payload: { prompt: "exact-full" } }),
    ]);
    s.indexHooks(hooksDir);

    // A broken window must not cost a session hooks it can prove are its own.
    setWindow(s, session.sessionId, 0, 0);

    const rows = s.listHooksForSession(session.sessionId);
    assert.equal(rows.length, 1, "identity is unaffected by a missing window");
    assert.equal(rows[0].payload.prompt, "exact-full");
  } finally {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * `fenceHookRows`' pass-through rule, asserted directly rather than as a
 * side effect of the ambiguity tests in serve.test.mjs. It is what makes the
 * window guard load-bearing: a cwd-less hook is never excluded by cwd.
 */
test("a hook with no recorded cwd is not fenced out by cwd", () => {
  const { dir, store: s, session } = makeClaudeStore("tracetap-hookcwdless-");
  try {
    const hooksDir = path.join(dir, "hooks");
    fs.mkdirSync(hooksDir);
    writeHookLog(hooksDir, "nocwd.jsonl", [
      hookEvent({ session_id: "hook-nocwd", stdin_preview: {} }),
    ]);
    s.indexHooks(hooksDir);

    assert.ok(s.getSession(session.sessionId).projectCwd, "session has a cwd to fence against");
    assert.equal(
      s.listHooksForSession(session.sessionId).length,
      1,
      "absence of a cwd is not evidence of being foreign",
    );
  } finally {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
