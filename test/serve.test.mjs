import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Store } from "../dist/store/index.js";
import {
    auditIndexedFiles,
    clearAuditMemo,
    handleRequest,
    parseServeArgs,
    reportPathFor,
} from "../dist/store/serve.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const TRAJ_FIX = path.join(ROOT, "src", "trajectory", "__fixtures__");

let tmp;
let store;
let server;
let baseUrl;
let claudeSource; // resolved source_path of the claude session (for the report file)

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-serve-"));
  const claudeDir = path.join(tmp, "proj", ".claude-trace");
  const codexDir = path.join(tmp, "proj", ".codex-trace");
  const hooksDir = path.join(tmp, "hooks");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(hooksDir, { recursive: true });
  claudeSource = path.join(claudeDir, "claude.jsonl");
  fs.copyFileSync(path.join(TRAJ_FIX, "claude-tooluse.jsonl"), claudeSource);
  fs.copyFileSync(
    path.join(TRAJ_FIX, "codex-tooluse.jsonl"),
    path.join(codexDir, "codex.jsonl"),
  );

  // Hook events timed to overlap the claude fixture (timestamps ~1700000000).
  const hookLines = [
    {
      v: 1,
      ts: "2023-11-14T22:13:19.000Z",
      session_id: "hook-sess-demo",
      event: "UserPromptSubmit",
      hook_name: "posture",
      duration_ms: 3,
      decision: null,
      stdin_digest: "a".repeat(64),
      stdin_preview: {
        session_id: "hook-sess-demo",
        hook_event_name: "UserPromptSubmit",
      },
      stdout_preview: { chars: 0 },
      outcome: "ok",
      exit_code: 0,
    },
    {
      v: 1,
      ts: "2023-11-14T22:13:21.000Z",
      session_id: "hook-sess-demo",
      event: "PreToolUse",
      hook_name: "pre-tool",
      duration_ms: 5,
      decision: "allow",
      stdin_digest: "b".repeat(64),
      stdin_preview: { tool_name: "Read", session_id: "hook-sess-demo" },
      stdout_preview: { decision: "allow" },
      outcome: "ok",
      exit_code: 0,
    },
  ];
  fs.writeFileSync(
    path.join(hooksDir, "hook-sess-demo.jsonl"),
    hookLines.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );

  // Synthetic session with a DEAD tool: declares Read + SleeperTool, only ever
  // calls Read. Its own system prompt gives it a distinct conversation key so
  // it cannot merge with the claude fixture session.
  const deadToolBody = {
    model: "claude-opus-4",
    system: "Dead tool tax test system.",
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    tools: [
      { name: "Read", description: "Read a file", input_schema: {} },
      {
        name: "SleeperTool",
        description: "x".repeat(400),
        input_schema: { type: "object", properties: {} },
      },
    ],
  };
  const deadToolPair = (ts) => ({
    request: {
      timestamp: ts,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: { "content-type": "application/json" },
      body: deadToolBody,
    },
    response: {
      timestamp: ts + 1,
      status_code: 200,
      body: {
        model: "claude-opus-4",
        content: [
          { type: "text", text: "reading" },
          { type: "tool_use", id: "tu1", name: "Read", input: { path: "f" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    },
  });
  fs.writeFileSync(
    path.join(claudeDir, "deadtool.jsonl"),
    [deadToolPair(1700000100), deadToolPair(1700000200)]
      .map((p) => JSON.stringify(p))
      .join("\n") + "\n",
  );

  // Session whose toolset CHANGES mid-flight: request 1 declares [Read] and the
  // response calls Read; request 2 declares [Read, Bash, VariantOnlyTool] and
  // calls nothing. Call counts must stay scoped to the declaring requests —
  // Read is alive under variant A but dead under variant B.
  const variantPair = (ts, tools, callRead) => ({
    request: {
      timestamp: ts,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: { "content-type": "application/json" },
      body: {
        model: "claude-opus-4",
        system: "Toolset variant test system.",
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
        tools,
      },
    },
    response: {
      timestamp: ts + 1,
      status_code: 200,
      body: {
        model: "claude-opus-4",
        content: callRead
          ? [
              { type: "text", text: "reading" },
              { type: "tool_use", id: "tv1", name: "Read", input: { path: "f" } },
            ]
          : [{ type: "text", text: "done" }],
        stop_reason: callRead ? "tool_use" : "end_turn",
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    },
  });
  const readTool = { name: "Read", description: "Read a file", input_schema: {} };
  fs.writeFileSync(
    path.join(claudeDir, "variant.jsonl"),
    [
      variantPair(1700000300, [readTool], true),
      variantPair(1700000400, [
        readTool,
        { name: "Bash", description: "Run a command", input_schema: {} },
        { name: "VariantOnlyTool", description: "y".repeat(200), input_schema: {} },
      ], false),
    ]
      .map((p) => JSON.stringify(p))
      .join("\n") + "\n",
  );

  const dbPath = path.join(tmp, "index.db");
  store = new Store(dbPath);
  store.indexPaths([path.join(tmp, "proj")]);
  store.indexHooks(hooksDir);

  // Write a sibling HTML report for the claude session so the report route
  // can serve real bytes for a known session.
  fs.writeFileSync(
    reportPathFor(path.resolve(claudeSource)),
    "<html><body>claude report</body></html>",
  );

  server = http.createServer((req, res) => handleRequest(store, req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try {
    store.close();
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function get(p) {
  const res = await fetch(baseUrl + p);
  const text = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get("content-type") || "",
    text,
  };
}

test("parseServeArgs parses port/host/db and rejects junk", () => {
  const o = parseServeArgs([
    "--port",
    "4123",
    "--host",
    "0.0.0.0",
    "--db",
    "/tmp/x.db",
  ]);
  assert.equal(o.port, 4123);
  assert.equal(o.host, "0.0.0.0");
  assert.equal(o.dbPath, "/tmp/x.db");

  const d = parseServeArgs([]);
  assert.equal(d.port, 4000);
  assert.equal(d.host, "127.0.0.1");

  assert.throws(() => parseServeArgs(["--port", "notaport"]), /valid port/);
  assert.throws(() => parseServeArgs(["--bogus"]), /Unknown option/);
});

test("reportPathFor maps foo.jsonl -> foo.html", () => {
  assert.equal(reportPathFor("/a/b/foo.jsonl"), "/a/b/foo.html");
  assert.equal(reportPathFor("/a/b/foo.JSONL"), "/a/b/foo.html");
});

test("GET / returns a self-contained HTML page", async () => {
  const r = await get("/");
  assert.equal(r.status, 200);
  assert.match(r.contentType, /text\/html/);
  assert.match(r.text, /<!doctype html>/i);
  assert.match(r.text, /tracetap/);
  // Self-contained where it matters: inline styles + scripts. (Font <link>s
  // are progressive enhancement with ui-monospace fallbacks — page works offline.)
  assert.match(r.text, /<style>/);
  assert.match(r.text, /\/api\/sessions/);
  assert.ok(
    !/<script[^>]+src=/.test(r.text),
    "page must not load external scripts",
  );
});

test("GET /api/sessions returns the seeded sessions", async () => {
  const r = await get("/api/sessions");
  assert.equal(r.status, 200);
  assert.match(r.contentType, /application\/json/);
  const body = JSON.parse(r.text);
  assert.equal(body.count, 4);
  assert.equal(body.sessions.length, 4);
  const agents = body.sessions.map((s) => s.agent).sort();
  assert.deepEqual(agents, ["claude", "claude", "claude", "codex"]);
  // documented shape
  for (const key of [
    "sessionId",
    "agent",
    "model",
    "startedAt",
    "durationMs",
    "totalInTokens",
    "totalOutTokens",
    "costUsd",
    "toolHistogram",
    "sourcePath",
  ]) {
    assert.ok(key in body.sessions[0], `session should expose '${key}'`);
  }
});

test("GET /api/sessions honors substring filters", async () => {
  const r = await get("/api/sessions?agent=codex");
  const body = JSON.parse(r.text);
  assert.equal(body.count, 1);
  assert.equal(body.sessions[0].agent, "codex");

  const none = JSON.parse((await get("/api/sessions?agent=doesnotexist")).text);
  assert.equal(none.count, 0);
});

test("GET /api/search returns a hit for a known term", async () => {
  const r = await get("/api/search?q=foo.txt");
  assert.equal(r.status, 200);
  assert.match(r.contentType, /application\/json/);
  const body = JSON.parse(r.text);
  assert.equal(body.query, "foo.txt");
  assert.ok(body.count >= 1, "expected at least one hit for foo.txt");
  assert.ok(body.hits[0].sessionId);
  assert.match(
    body.hits[0].snippet,
    /\[/,
    "snippet should carry highlight markers",
  );

  // empty query -> empty result, no error.
  const empty = JSON.parse((await get("/api/search?q=")).text);
  assert.equal(empty.count, 0);
});

test("report route serves the sibling HTML for a known session", async () => {
  const list = JSON.parse((await get("/api/sessions?agent=claude")).text);
  // Two claude sessions exist (fixture + dead-tool synthetic); only the
  // fixture's source log has a sibling .html report.
  const id = list.sessions.find((s) =>
    s.sourcePath.endsWith("claude.jsonl"),
  ).sessionId;
  const r = await get("/report?session=" + encodeURIComponent(id));
  assert.equal(r.status, 200);
  assert.match(r.contentType, /text\/html/);
  assert.match(r.text, /claude report/);
});

test("report route 404s for an unknown session id", async () => {
  const r = await get("/report?session=no-such-session");
  assert.equal(r.status, 404);
  assert.match(r.text, /no-such-session/);
});

test("report route 404s gracefully when the HTML file is missing", async () => {
  // The codex session has no sibling .html report on disk.
  const list = JSON.parse((await get("/api/sessions?agent=codex")).text);
  const id = list.sessions[0].sessionId;
  const r = await get("/report?session=" + encodeURIComponent(id));
  assert.equal(r.status, 404);
  assert.match(r.text, /No HTML report found/);
});

test("unknown route 404s and non-GET is rejected", async () => {
  const r = await get("/nope");
  assert.equal(r.status, 404);

  const res = await fetch(baseUrl + "/api/sessions", { method: "POST" });
  assert.equal(res.status, 405);
});

// ---------------------------------------------------------------------------
// v2 observatory APIs
// ---------------------------------------------------------------------------

test("GET / carries the observatory shell (tabs + inlined assets)", async () => {
  const r = await get("/");
  assert.match(r.text, /id="tabs"/);
  assert.match(r.text, /#analytics/);
  assert.match(r.text, /data-tab="tooltax"/);
  assert.match(r.text, /\/api\/events/, "SSE client must be wired in");
});

test("GET /api/meta reports db counts and price source", async () => {
  const r = await get("/api/meta");
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text);
  assert.ok(body.counts.sessions >= 2);
  assert.ok(body.counts.requests >= 3, "wire-level request rows expected");
  assert.ok(body.counts.prompts >= 1);
  assert.ok(["litellm", "litellm-cache", "builtin"].includes(body.priceSource));
});

test("GET /api/session/<id> returns transcript, requests, hooks, flow, compactions", async () => {
  const list = JSON.parse((await get("/api/sessions?agent=claude")).text);
  const id = list.sessions[0].sessionId;
  const r = await get("/api/session/" + encodeURIComponent(id));
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text);
  assert.equal(body.session.sessionId, id);
  assert.ok(body.steps.length >= 3, "transcript steps expected");
  assert.ok(body.requests.length >= 2, "per-pair wire rows expected");
  assert.equal(body.requests[0].seq, 0);
  assert.ok(Array.isArray(body.compactions));
  assert.ok(Array.isArray(body.hooks), "hooks array expected");
  assert.ok(body.hooks.length >= 2, "time-correlated hook events expected");
  assert.ok(body.flow && Array.isArray(body.flow.nodes));
  assert.ok(body.flow.nodes.length >= 3);
  // The timeline is deliberately NOT here: building it can require reading every
  // request body in the session, so it moved to its own endpoint rather than
  // stalling all four panes.
  assert.equal(body.contextTimeline, undefined, "timeline must not block the session load");
  assert.equal(typeof body.reportAvailable, "boolean");

  const missing = await get("/api/session/nope");
  assert.equal(missing.status, 404);
});

test("GET /api/session/<id>/timeline serves the context timeline separately", async () => {
  const list = JSON.parse((await get("/api/sessions?agent=claude")).text);
  const id = list.sessions[0].sessionId;
  const r = await get("/api/session/" + encodeURIComponent(id) + "/timeline");
  assert.equal(r.status, 200);
  const tl = JSON.parse(r.text);
  assert.ok(Array.isArray(tl.points));
  assert.ok(tl.points.length >= 1);
  assert.equal(typeof tl.compactionCount, "number");
  assert.equal(typeof tl.peakContextTokens, "number");
  // Every point carries composition, whether precomputed at index time or
  // recovered by the fallback — the pane renders off these numbers.
  assert.ok(tl.points.every((p) => typeof p.approxTokens === "number"));

  const missing = await get("/api/session/nope/timeline");
  assert.equal(missing.status, 404);
});

test("flow node detail is previewed in the graph and fetched per node", async () => {
  const list = JSON.parse((await get("/api/sessions?agent=claude")).text);
  const id = list.sessions[0].sessionId;
  const body = JSON.parse((await get("/api/session/" + encodeURIComponent(id))).text);

  // Whatever the fixture's payload sizes, no node may carry both forms, and a
  // trimmed node must say how much was withheld so the UI can label it.
  for (const n of body.flow.nodes) {
    assert.ok(!(n.detail && n.detailPreview), "node " + n.id + " carries both detail and preview");
    if (n.detailPreview) {
      assert.equal(typeof n.detailChars, "number");
      assert.ok(n.detailChars > n.detailPreview.length);
    }
  }

  const withDetail = body.flow.nodes.find((n) => n.detail || n.detailPreview);
  if (withDetail) {
    const r = await get(
      "/api/session/" + encodeURIComponent(id) + "/flow/" + encodeURIComponent(withDetail.id),
    );
    assert.equal(r.status, 200);
    const full = JSON.parse(r.text);
    assert.equal(full.id, withDetail.id);
    assert.ok(full.detail, "per-node endpoint returns the untrimmed detail");
  }

  const missing = await get("/api/session/" + encodeURIComponent(id) + "/flow/no-such-node");
  assert.equal(missing.status, 404);
});

test("GET /api/session/<id>/context/<seq> returns Context X-Ray with delta", async () => {
  const list = JSON.parse((await get("/api/sessions?agent=claude")).text);
  const id = list.sessions[0].sessionId;
  const r0 = await get("/api/session/" + encodeURIComponent(id) + "/context/0");
  assert.equal(r0.status, 200);
  const x0 = JSON.parse(r0.text);
  assert.equal(x0.seq, 0);
  assert.ok(Array.isArray(x0.buckets));
  assert.ok(x0.buckets.length >= 1);
  assert.ok(Array.isArray(x0.segments));

  const r1 = await get("/api/session/" + encodeURIComponent(id) + "/context/1");
  assert.equal(r1.status, 200);
  const x1 = JSON.parse(r1.text);
  assert.equal(x1.seq, 1);
  assert.ok(x1.delta, "second call should include delta vs prior");
  assert.equal(x1.delta.prevSeq, 0);
  assert.ok(typeof x1.delta.newCount === "number");

  const missing = await get(
    "/api/session/" + encodeURIComponent(id) + "/context/99",
  );
  assert.equal(missing.status, 404);
});

test("GET /api/usage aggregates priced buckets", async () => {
  const r = await get("/api/usage?granularity=daily&timezone=UTC");
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text);
  assert.ok(body.rows.length >= 1);
  assert.equal(body.granularity, "daily");
  assert.ok(body.totals.events >= 2);
  assert.ok(body.totals.costUsd > 0, "fixture models are priced");

  const breakdown = JSON.parse(
    (await get("/api/usage?granularity=total&breakdown=1")).text,
  );
  assert.ok(breakdown.rows.length >= 2, "per-model rows expected");
  assert.ok(breakdown.rows.every((row) => row.group));
});

test("GET /api/analytics returns fleet rollups with wire metrics", async () => {
  const r = await get("/api/analytics");
  assert.equal(r.status, 200);
  const a = JSON.parse(r.text);
  assert.ok(a.totals.sessions >= 2);
  assert.ok(a.totals.requests >= 3);
  assert.ok(a.perModel.length >= 2);
  for (const m of a.perModel) {
    assert.ok(m.requests >= 1);
    assert.ok(m.errorRate >= 0 && m.errorRate <= 1);
  }
  assert.ok(a.perAgent.length >= 2);
  assert.ok(Array.isArray(a.topTools) && a.topTools.length >= 1);
  assert.ok(a.compactions.totalCompactions >= 0);
  assert.ok(a.topSessions.length >= 1);

  // UI feeds: project rollup + TTFT distribution bands.
  assert.ok(Array.isArray(a.perProject) && a.perProject.length >= 1);
  for (const p of a.perProject) {
    assert.equal(typeof p.project, "string");
    assert.ok(p.sessions >= 1 && p.events >= 1);
  }
  for (const m of a.perModel) {
    assert.equal(m.ttftPcts.length, 6);
    assert.equal(typeof m.ttftN, "number");
  }
});

test("GET /api/prompts + /api/prompt/<hash> expose the registry", async () => {
  const r = await get("/api/prompts");
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text);
  assert.ok(body.count >= 1);
  const first = body.prompts[0];
  assert.equal(first.promptHash.length, 64);
  assert.ok(first.requestCount >= 1);

  const detail = JSON.parse(
    (await get("/api/prompt/" + first.promptHash.slice(0, 10))).text,
  );
  assert.equal(detail.promptHash, first.promptHash);
  assert.ok(detail.content.length > 0);
  assert.ok(Array.isArray(detail.sessionIds) && detail.sessionIds.length >= 1);

  const missing = await get("/api/prompt/ffffffffffff");
  assert.equal(missing.status, 404);
});

test("GET /api/events is a live SSE stream", async () => {
  const ac = new AbortController();
  const res = await fetch(baseUrl + "/api/events", { signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  assert.match(text, /event: hello/);
  ac.abort();
});

test("GET /api/audit scans indexed source files (memoized)", async () => {
  const r = await get("/api/audit");
  assert.equal(r.status, 200);
  const report = JSON.parse(r.text);
  assert.ok(report.filesScanned >= 1);
  assert.ok(report.pairsScanned >= 3);
  assert.ok(Array.isArray(report.groups));
  assert.ok(report.redactCheck, "serve audit always includes redact-check");
  const strict = JSON.parse((await get("/api/audit?mode=strict")).text);
  assert.equal(strict.mode, "strict");
});

test("audit scans are cached per file and survive a new process", async () => {
  const baseline = JSON.parse((await get("/api/audit")).text);
  assert.ok(baseline.filesScanned >= 1);

  const cached = store.db
    .prepare("SELECT source_path, content_hash, mode FROM audit_scans WHERE mode = 'standard'")
    .all();
  assert.equal(
    cached.length,
    baseline.filesScanned,
    "one cached scan row per scanned file, not one per report",
  );
  const hashes = store.db
    .prepare("SELECT source_path AS p, content_hash AS h FROM files")
    .all();
  for (const row of cached) {
    const f = hashes.find((x) => x.p === row.source_path);
    assert.ok(f, "cached scan references an indexed file");
    assert.equal(row.content_hash, f.h, "cache is keyed on the file's indexed content hash");
  }

  // The point of persisting: a fresh process must not rescan. Prove it by
  // making the log unreadable — a rescan would silently drop it from the
  // report, a cache hit keeps it.
  const moved = claudeSource + ".moved";
  fs.renameSync(claudeSource, moved);
  clearAuditMemo(); // drop the in-process layer so SQLite is what answers
  try {
    const fresh = await auditIndexedFiles(store, "standard");
    assert.equal(
      fresh.filesScanned,
      baseline.filesScanned,
      "unreadable-but-cached file still counted — it was not rescanned",
    );
    assert.equal(fresh.pairsScanned, baseline.pairsScanned);
  } finally {
    fs.renameSync(moved, claudeSource);
  }
});

test("GET /api/tooltax reports the dead tool across the fleet", async () => {
  const r = await get("/api/tooltax");
  assert.equal(r.status, 200);
  const d = JSON.parse(r.text);
  assert.ok(d.totals.sessions >= 1);
  assert.ok(d.totals.cumulativeToolTokens > 0);

  const sleeper = d.tools.find((t) => t.name === "SleeperTool");
  assert.ok(sleeper, "SleeperTool missing from fleet tool table");
  assert.equal(sleeper.sessionsCalled, 0);
  assert.equal(sleeper.calls, 0);
  // Declared on 2 requests, never called: dead on both.
  assert.equal(sleeper.deadTokensCumulative, sleeper.approxTokens * 2);

  const read = d.tools.find((t) => t.name === "Read");
  assert.ok(read);
  assert.ok(read.sessionsCalled >= 1);

  const deadSession = d.sessions.find((s) => s.deadCount === 1);
  assert.ok(deadSession, "synthetic dead-tool session missing");
  assert.equal(deadSession.declaredCount, 2);
  assert.equal(deadSession.calledCount, 1);
  assert.equal(deadSession.requestCount, 2);
  assert.equal(deadSession.deadTokensPerRequest, sleeper.approxTokens);
});

test("GET /api/session/<id>/tools crosses toolset with histogram (and 404s)", async () => {
  const usage = store.listToolsetUsage().find((u) => u.toolCount === 2);
  assert.ok(usage, "synthetic toolset not indexed");
  // Content addressing: both requests share one toolsets row.
  assert.equal(usage.requestCount, 2);

  const r = await get(
    "/api/session/" + encodeURIComponent(usage.sessionId) + "/tools",
  );
  assert.equal(r.status, 200);
  const d = JSON.parse(r.text);
  assert.equal(d.sessionId, usage.sessionId);
  assert.equal(d.toolsets.length, 1);
  const ts = d.toolsets[0];
  assert.equal(ts.declaredCount, 2);
  assert.equal(ts.calledCount, 1);
  assert.equal(ts.deadCount, 1);
  const dead = ts.tools.find((t) => t.dead);
  assert.equal(dead.name, "SleeperTool");
  assert.equal(ts.deadTokensPerRequest, dead.approxTokens);
  assert.equal(ts.deadTokensCumulative, dead.approxTokens * 2);

  const missing = await get("/api/session/nope/tools");
  assert.equal(missing.status, 404);
});

test("toolset variants scope call counts to their own requests", async () => {
  // The variant session produced two distinct toolset hashes.
  const counts = new Map();
  for (const u of store.listToolsetUsage()) {
    counts.set(u.sessionId, (counts.get(u.sessionId) || 0) + 1);
  }
  const variantEntry = [...counts.entries()].find(([, n]) => n === 2);
  assert.ok(variantEntry, "variant session should carry two toolsets");
  const sessionId = variantEntry[0];

  const rows = store.listToolsetUsage(sessionId);
  const a = rows.find((u) => u.toolCount === 1);
  const b = rows.find((u) => u.toolCount === 3);
  assert.ok(a && b);
  // Read's call belongs to variant A's window only.
  assert.deepEqual(a.toolHistogram, { Read: 1 });
  assert.deepEqual(b.toolHistogram, {});

  const r = await get("/api/session/" + encodeURIComponent(sessionId) + "/tools");
  assert.equal(r.status, 200);
  const d = JSON.parse(r.text);
  const taxA = d.toolsets.find((t) => t.declaredCount === 1);
  const taxB = d.toolsets.find((t) => t.declaredCount === 3);
  assert.equal(taxA.deadCount, 0);
  // Under variant B nothing was called — Read included, despite its
  // session-wide call. The old session-wide histogram reported it alive here.
  assert.equal(taxB.deadCount, 3);
});
