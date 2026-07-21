import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";

import {
  importDevinSession,
  listDevinSessions,
  getDevinSession,
  reconstructChain,
  openDevinDb,
} from "../dist/devin/importer.js";
import { buildTrajectories } from "../dist/trajectory/index.js";

let tmp;
let dbPath;
let db;

// Build a tiny Devin sessions.db: one session whose active chain is
// 0(sys) → 1(user) → 2(assistant+tool) → 3(tool result) → 4(assistant final),
// plus node 5, an ABANDONED regeneration branch (sibling of 3 under node 2)
// that must be excluded because main_chain_id points at leaf node 4.
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-devin-"));
  dbPath = path.join(tmp, "sessions.db");
  const d = new Database(dbPath);
  d.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL,
      model TEXT NOT NULL, agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL, title TEXT, main_chain_id INTEGER,
      hidden INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE message_nodes (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL,
      parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT);
  `);
  d.prepare(
    `INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, title, main_chain_id, hidden)
     VALUES (?,?,?,?,?,?,?,?,?,0)`,
  ).run("s1", tmp, "Windsurf", "adaptive", "normal", 1751932800000, 1751932810000, "Test session", 4);

  const node = (id, parent, chat) =>
    d.prepare(
      `INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?,?,?,?,?)`,
    ).run("s1", id, parent, JSON.stringify(chat), 1751932800000 + id * 1000);

  node(0, null, { role: "system", content: "You are Devin.\n<system_info>\nToday's date: 2026-07-08\n</system_info>" });
  node(1, 0, { role: "user", content: "hi" });
  node(2, 1, {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "t1", name: "exec", arguments: { command: "ls" }, index: 0, kind: "function" }],
    metadata: {
      generation_model: "claude-sonnet-4-6",
      finish_reason: "tool_calls",
      started_generation_at: "2026-07-08T00:00:01.000Z",
      created_at: "2026-07-08T00:00:03.000Z",
      metrics: { input_tokens: 3, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 20, ttft_ms: 500 },
    },
  });
  node(3, 2, { role: "tool", tool_call_id: "t1", content: "a.txt" });
  node(4, 3, {
    role: "assistant",
    content: "done: a.txt",
    metadata: {
      generation_model: "claude-sonnet-4-6",
      finish_reason: "stop",
      created_at: "2026-07-08T00:00:05.000Z",
      metrics: { input_tokens: 2, output_tokens: 5, cache_read_tokens: 20, cache_creation_tokens: 0 },
    },
  });
  // Abandoned regeneration branch (sibling of node 3): NOT on the main chain.
  node(5, 2, { role: "assistant", content: "abandoned regeneration", metadata: {} });
  d.close();

  db = openDevinDb(dbPath);
});

after(() => {
  try {
    db.close();
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("lists the session with normalized epoch-second timestamps", () => {
  const metas = listDevinSessions(db);
  assert.equal(metas.length, 1);
  assert.equal(metas[0].id, "s1");
  assert.equal(metas[0].model, "adaptive");
  assert.equal(metas[0].backendType, "Windsurf");
  assert.equal(metas[0].mainChainId, 4);
  assert.equal(metas[0].createdAt, 1751932800); // ms → s
});

test("reconstructChain follows main_chain_id and drops abandoned branches", () => {
  const meta = getDevinSession(db, "s1");
  const imported = importDevinSession(db, meta);
  assert.ok(imported);
  assert.equal(imported.turns, 2);
  assert.equal(imported.resolvedModel, "claude-sonnet-4-6");
  assert.equal(imported.pairs.length, 2);

  // Cumulative transcript grows: turn A sees [user]; turn B sees [user, assistant, tool].
  assert.equal(imported.pairs[0].request.body.transcript.length, 1);
  assert.equal(imported.pairs[0].request.body.transcript[0].role, "user");
  const reqB = imported.pairs[1].request.body.transcript;
  assert.equal(reqB.length, 3);
  assert.equal(reqB[2].role, "tool");
  assert.equal(reqB[2].tool_call_id, "t1");

  // Timing derived from the ISO metadata (started_generation_at → request ts).
  assert.equal(imported.pairs[0].request.timestamp, Date.parse("2026-07-08T00:00:01.000Z") / 1000);
  assert.equal(imported.pairs[0].response.timestamp, Date.parse("2026-07-08T00:00:03.000Z") / 1000);
});

test("imported pairs rebuild into a faithful trajectory", () => {
  const meta = getDevinSession(db, "s1");
  const imported = importDevinSession(db, meta);
  const t = buildTrajectories(imported.pairs)[0];

  assert.equal(t.agent.name, "devin");
  assert.equal(t.agent.model, "claude-sonnet-4-6");
  assert.deepEqual(t.steps.map((s) => s.role), ["user", "agent", "agent"]);

  assert.equal(t.steps[1].toolCalls[0].name, "exec");
  assert.deepEqual(t.steps[1].toolCalls[0].arguments, { command: "ls" });
  assert.equal(t.steps[1].observation.results[0].content, "a.txt");
  assert.equal(t.steps[2].message, "done: a.txt");

  // Abandoned branch is nowhere in the reconstructed trajectory.
  assert.ok(!JSON.stringify(t.steps).includes("abandoned"));

  // Metrics roll up across both turns.
  assert.equal(t.metrics.promptTokens, 5);
  assert.equal(t.metrics.completionTokens, 15);
  assert.equal(t.metrics.cacheReadTokens, 20);
  assert.equal(t.metrics.cacheCreationTokens, 20);
});

test("reconstructChain falls back to the newest leaf when main_chain_id is null", () => {
  const nodes = new Map([
    [0, { nodeId: 0, parentNodeId: null, createdAt: 1, chat: { role: "user", content: "a" } }],
    [1, { nodeId: 1, parentNodeId: 0, createdAt: 2, chat: { role: "assistant", content: "b" } }],
  ]);
  const chain = reconstructChain(nodes, null);
  assert.deepEqual(chain.map((n) => n.nodeId), [0, 1]);
});

test("openDevinDb throws a helpful error for a missing store", () => {
  assert.throws(() => openDevinDb(path.join(tmp, "nope.db")), /not found/);
});

// --- regression tests for review findings ---------------------------------

// Build a throwaway sessions.db from a list of {id, parent, chat, createdAt?}.
function makeSessionDb(nodes, mainChainId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-devin-x-"));
  const p = path.join(dir, "sessions.db");
  const d = new Database(p);
  d.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL,
      model TEXT NOT NULL, agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL, title TEXT, main_chain_id INTEGER, hidden INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE message_nodes (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL,
      parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT);
  `);
  d.prepare(
    `INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, title, main_chain_id, hidden)
     VALUES (?,?,?,?,?,?,?,?,?,0)`,
  ).run("s1", dir, "Windsurf", "adaptive", "normal", 1751932800000, 1751932810000, "T", mainChainId);
  const ins = d.prepare(
    `INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?,?,?,?,?)`,
  );
  for (const n of nodes) ins.run("s1", n.id, n.parent, JSON.stringify(n.chat), n.createdAt ?? 1751932800000 + n.id * 1000);
  d.close();
  return { dir, db: openDevinDb(p) };
}

test("trailing tool node after the last assistant is NOT dropped (mid-turn snapshot)", () => {
  // Chain leaf is a tool result (assistant's next generation not yet persisted).
  const { dir, db: d } = makeSessionDb(
    [
      { id: 0, parent: null, chat: { role: "system", content: "You are Devin." } },
      { id: 1, parent: 0, chat: { role: "user", content: "run it" } },
      {
        id: 2,
        parent: 1,
        chat: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "t1", name: "exec", arguments: { command: "ls" } }],
          metadata: { generation_model: "claude-sonnet-4-6", finish_reason: "tool_calls", metrics: { input_tokens: 1, output_tokens: 1 } },
        },
      },
      { id: 3, parent: 2, chat: { role: "tool", tool_call_id: "t1", content: "TRAILING-RESULT-XYZ" } },
    ],
    3, // leaf is the tool node
  );
  try {
    const imported = importDevinSession(d, getDevinSession(d, "s1"));
    const t = buildTrajectories(imported.pairs)[0];
    assert.deepEqual(t.steps.map((s) => s.role), ["user", "agent"]);
    // The trailing tool result is stitched as the observation for tool call t1.
    assert.equal(t.steps[1].observation.results[0].sourceCallId, "t1");
    assert.equal(t.steps[1].observation.results[0].content, "TRAILING-RESULT-XYZ");
    assert.ok(JSON.stringify(t.steps).includes("TRAILING-RESULT-XYZ"));
  } finally {
    d.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("trailing user follow-up after the last assistant becomes a final user step", () => {
  const { dir, db: d } = makeSessionDb(
    [
      { id: 0, parent: null, chat: { role: "system", content: "You are Devin." } },
      { id: 1, parent: 0, chat: { role: "user", content: "q1" } },
      { id: 2, parent: 1, chat: { role: "assistant", content: "a1", metadata: { generation_model: "claude-sonnet-4-6", metrics: { input_tokens: 1, output_tokens: 1 } } } },
      { id: 3, parent: 2, chat: { role: "user", content: "TRAILING-FOLLOWUP" } },
    ],
    3,
  );
  try {
    const imported = importDevinSession(d, getDevinSession(d, "s1"));
    const t = buildTrajectories(imported.pairs)[0];
    assert.deepEqual(t.steps.map((s) => s.role), ["user", "agent", "user"]);
    assert.equal(t.steps[2].message, "TRAILING-FOLLOWUP");
  } finally {
    d.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reconstructChain fallback prefers the latest childless leaf, not the max node id", () => {
  // Two sibling leaves under node 0: node 2 kept (latest), node 5 abandoned (earlier).
  const nodes = new Map([
    [0, { nodeId: 0, parentNodeId: null, createdAt: 1, chat: { role: "user", content: "x" } }],
    [2, { nodeId: 2, parentNodeId: 0, createdAt: 900, chat: { role: "assistant", content: "kept" } }],
    [5, { nodeId: 5, parentNodeId: 0, createdAt: 100, chat: { role: "assistant", content: "abandoned" } }],
  ]);
  const chain = reconstructChain(nodes, null);
  assert.deepEqual(chain.map((n) => n.nodeId), [0, 2]); // node 2 (latest leaf), not 5 (max id)
});

test("getDevinSession honors the hidden filter", () => {
  const { dir, db: d } = makeSessionDb(
    [{ id: 0, parent: null, chat: { role: "user", content: "x" } }],
    0,
  );
  d.close();
  // Reopen writable to flip hidden, then reopen read-only.
  const p = path.join(dir, "sessions.db");
  const w = new Database(p);
  w.prepare("UPDATE sessions SET hidden = 1 WHERE id = ?").run("s1");
  w.close();
  const ro = openDevinDb(p);
  try {
    assert.equal(getDevinSession(ro, "s1"), null); // hidden → not returned
    assert.equal(listDevinSessions(ro).length, 0); // list also omits it
  } finally {
    ro.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
