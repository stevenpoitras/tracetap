// Claude Code local-transcript import: parsing, adapter isolation, usage
// dedupe, wire-vs-transcript no-double-count, incremental re-import, tolerance.
//
// Fixtures under src/claude-transcripts/__fixtures__/projects are SYNTHETIC,
// hand-built to the observed record shapes (no real prompts/paths/ids).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  importTranscript,
  listTranscripts,
  ownershipFor,
} = require("../dist/claude-transcripts/importer.js");
const { importTranscripts } = require("../dist/claude-transcripts-cli.js");
const { buildTrajectories, groupPairs } = require("../dist/trajectory/index.js");
const { Store, TRACE_DIRS } = require("../dist/store/index.js");

const FIXTURE_ROOT = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "src",
  "claude-transcripts",
  "__fixtures__",
  "projects",
);
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tracetap-ct-${tag}-`));
}

function copyDir(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
}

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = fs.statSync(p);
        out[p] = `${st.size}:${st.mtimeMs}:${fs.readFileSync(p, "utf8").length}`;
      }
    }
  };
  walk(dir);
  return out;
}

function importOne(root, id) {
  const refs = listTranscripts(root);
  const ref = refs.find((r) => r.sessionId === id);
  return importTranscript(ref, ownershipFor(refs));
}

function sumUsage(store) {
  return store.listUsageEvents().reduce(
    (a, e) => ({
      in: a.in + e.promptTokens,
      out: a.out + e.completionTokens,
      cr: a.cr + e.cacheRead,
      cc: a.cc + e.cacheCreation,
      n: a.n + 1,
    }),
    { in: 0, out: 0, cr: 0, cc: 0, n: 0 },
  );
}

test("TRACE_DIRS includes the transcript mirror dir", () => {
  assert.ok(TRACE_DIRS.includes(".claude-transcripts-trace"));
});

test("listTranscripts finds sessions and their subagent files", () => {
  const refs = listTranscripts(FIXTURE_ROOT);
  assert.deepEqual(refs.map((r) => r.sessionId).sort(), [A, B]);
  const a = refs.find((r) => r.sessionId === A);
  assert.equal(a.subagents.length, 1);
  assert.equal(a.subagents[0].agentId, "a0fixture1");
  assert.ok(a.subagents[0].metaPath);
});

test("parses metadata, responses, hooks; tolerates malformed and unknown records", () => {
  const imp = importOne(FIXTURE_ROOT, A);
  assert.ok(imp);
  assert.equal(imp.meta.entrypoint, "claude-desktop");
  assert.equal(imp.meta.cwd, "/tmp/demo-project");
  assert.equal(imp.meta.gitBranch, "main");
  assert.equal(imp.meta.version, "9.9.9");
  assert.equal(imp.meta.title, "Demo transcript session");
  assert.equal(imp.model, "claude-opus-5-5");
  assert.equal(imp.badLines, 1, "the cut-off line is counted, not fatal");
  // main: msg_0001 (2 block records), msg_0002, synthetic, msg_0003; sub: 1
  assert.equal(imp.responses, 5);
  assert.equal(imp.countedResponses, 4, "synthetic error placeholder is not billed");
  assert.equal(imp.hooks, 2, "one hook_success attachment + one stop_hook_summary");
  assert.ok(imp.startedAt > 0 && imp.endedAt >= imp.startedAt);
  // Every pair carries the strict marker and Claude's session uuid header.
  for (const p of imp.pairs) {
    assert.equal(p.request.body.provider, "claude-transcript");
    assert.equal(p.request.headers["x-claude-code-session-id"], A);
  }
  // Hook output text is never copied, only sizes.
  const hooks = imp.pairs.flatMap((p) => p.request.body.hooks ?? []);
  assert.equal(hooks.length, 2);
  assert.ok(!JSON.stringify(hooks).includes("--strict"), "command arguments are dropped");
  assert.equal(hooks[0].stdoutChars, 2);
});

test("builds steps: prompts, thinking, tool call stitched to its result, subagent group", () => {
  const imp = importOne(FIXTURE_ROOT, A);
  const trajs = buildTrajectories(imp.pairs);
  assert.equal(trajs.length, 2, "main thread + one subagent");
  const main = trajs.find((t) => !t.sessionId.includes(":agent-"));
  const sub = trajs.find((t) => t.sessionId.includes(":agent-"));
  assert.equal(main.agent.name, "claude");
  const roles = main.steps.map((s) => s.role).join(",");
  assert.equal(roles, "user,agent,agent,user,agent,agent");
  assert.equal(main.steps[0].message, "list the files");
  const toolStep = main.steps[1];
  assert.equal(toolStep.reasoningContent, "I should run ls.");
  assert.equal(toolStep.toolCalls[0].name, "Bash");
  assert.equal(toolStep.observation.results[0].content, "alpha.txt\nbeta.txt");
  assert.equal(main.steps[3].message, "thanks", "isMeta injection is not a prompt");
  assert.ok(!main.steps.some((s) => /Caveat/.test(s.message)));
  assert.equal(sub.steps[0].message, "look around the demo project");
  assert.equal(sub.metrics.completionTokens, 1);
});

test("usage dedupe: one response written as several block records counts once (final count)", () => {
  const imp = importOne(FIXTURE_ROOT, A);
  const trajs = buildTrajectories(imp.pairs);
  const main = trajs.find((t) => !t.sessionId.includes(":agent-"));
  // msg_0001 final out=40 (not 5+40), msg_0002 out=7, msg_0003 out=2, synthetic none
  assert.equal(main.metrics.completionTokens, 49);
  assert.equal(main.metrics.promptTokens, 2 + 10 + 3);
  assert.equal(main.metrics.cacheCreationTokens, 300 + 50);
  assert.equal(main.metrics.cacheReadTokens, 100 + 400);
  const ids = imp.pairs.map((p) => p.response.body.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, "one pair per response id");
});

test("resumed session: copied history and copied subagent files are not counted twice", () => {
  const imp = importOne(FIXTURE_ROOT, B);
  assert.equal(imp.responses, 1, "only B's own response");
  assert.equal(imp.meta.entrypoint, "cli");
  assert.equal(imp.meta.gitBranch, "feature-x");
  const trajs = buildTrajectories(imp.pairs);
  assert.equal(trajs.length, 1, "the copied subagent file belongs to A");
  assert.equal(trajs[0].metrics.completionTokens, 4);
  assert.deepEqual(
    trajs[0].steps.map((s) => s.message),
    ["continue from where we left off", "Continuing."],
  );
});

test("adapter order: transcript pairs claimed only by the transcript adapter, and it steals nothing", () => {
  const fx = path.join(FIXTURE_ROOT, "..", "..", "..", "trajectory", "__fixtures__");
  const readPairs = (f) =>
    fs
      .readFileSync(path.join(fx, f), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  const others = {
    "claude-tooluse.jsonl": "anthropic",
    "codex-tooluse.jsonl": "openai",
    "gemini-tooluse.jsonl": "gemini",
    "devin-tooluse.jsonl": "devin",
  };
  for (const [f, expected] of Object.entries(others)) {
    const names = new Set(groupPairs(readPairs(f)).map((g) => g.adapter.name));
    assert.deepEqual([...names], [expected], `${f} stays with ${expected}`);
  }
  const imp = importOne(FIXTURE_ROOT, A);
  const names = new Set(groupPairs(imp.pairs).map((g) => g.adapter.name));
  assert.deepEqual([...names], ["claude-transcript"]);
  // A transcript pair has no messages[] for the Anthropic adapter to match.
  assert.equal(imp.pairs[0].request.body.messages, undefined);
});

function wirePair({ uuid, out = 500, inp = 1000 }) {
  return {
    request: {
      timestamp: 1767348001,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: { "x-claude-code-session-id": uuid },
      body: {
        model: "claude-opus-5-5",
        system: "synthetic system prompt",
        messages: [{ role: "user", content: "list the files" }],
      },
    },
    response: {
      timestamp: 1767348003,
      status_code: 200,
      headers: {},
      body: {
        id: "msg_wire_1",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "wire reply" }],
        stop_reason: "end_turn",
        usage: { input_tokens: inp, output_tokens: out },
      },
    },
    logged_at: "2026-01-02T10:00:03.000Z",
  };
}

async function setup(tag) {
  const dir = tmpdir(tag);
  const source = path.join(dir, "projects");
  copyDir(FIXTURE_ROOT, source);
  const outDir = path.join(dir, "out", ".claude-transcripts-trace");
  const dbPath = path.join(dir, "index.db");
  return { dir, source, outDir, dbPath };
}

test("wire vs transcript: the same Claude session is counted once, wire wins (either index order)", async () => {
  for (const order of ["transcript-first", "wire-first"]) {
    const { dir, source, outDir, dbPath } = await setup("wire");
    const wireDir = path.join(dir, "proj", ".claude-trace");
    fs.mkdirSync(wireDir, { recursive: true });
    const wirePath = path.join(wireDir, "log-1.jsonl");
    fs.writeFileSync(wirePath, JSON.stringify(wirePair({ uuid: A })) + "\n");

    if (order === "wire-first") {
      const s = new Store(dbPath);
      s.indexFile(wirePath);
      s.close();
    }
    await importTranscripts({ source, outDir, sessions: [A], dbPath });
    if (order === "transcript-first") {
      const s = new Store(dbPath);
      s.indexFile(wirePath);
      s.close();
    }

    const store = new Store(dbPath);
    const u = sumUsage(store);
    assert.equal(u.out, 500, `${order}: only the wire usage counts`);
    assert.equal(u.in, 1000, `${order}`);
    const listed = store.listSessions();
    assert.equal(listed.length, 1, `${order}: transcript copies are hidden`);
    assert.equal(listed[0].origin, "wire");
    assert.equal(listed[0].hasTranscript, true, `${order}: wire row says a transcript exists`);
    const all = store.listSessions({ includeShadowed: true });
    const shadowed = all.filter((s) => s.origin === "transcript");
    assert.equal(shadowed.length, 2, "main + subagent transcript groups");
    for (const s of shadowed) {
      assert.equal(s.shadowedByWire, true);
      assert.equal(s.totalOutTokens, 0);
      assert.equal(s.costUsd, 0);
    }
    const reqTok = store.db
      .prepare(
        "SELECT COALESCE(SUM(completion_tokens),0) AS n FROM requests WHERE session_id IN (SELECT session_id FROM transcript_sessions)",
      )
      .get().n;
    assert.equal(reqTok, 0, "request rows zeroed too (dashboard spend views)");
    assert.equal(store.search("files").every((h) => !h.sessionId.includes("claude-transcript")), true);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("wire vs transcript: un-shadows when the wire log stops carrying the session", async () => {
  const { dir, source, outDir, dbPath } = await setup("unshadow");
  const wireDir = path.join(dir, "proj", ".claude-trace");
  fs.mkdirSync(wireDir, { recursive: true });
  const wirePath = path.join(wireDir, "log-1.jsonl");
  fs.writeFileSync(wirePath, JSON.stringify(wirePair({ uuid: A })) + "\n");
  await importTranscripts({ source, outDir, sessions: [A], dbPath });
  let s = new Store(dbPath);
  s.indexFile(wirePath);
  assert.equal(sumUsage(s).out, 500);
  // The wire log is rewritten for a different session.
  fs.writeFileSync(wirePath, JSON.stringify(wirePair({ uuid: B, out: 9 })) + "\n");
  s.indexFile(wirePath);
  assert.equal(sumUsage(s).out, 9 + 49 + 1, "transcript usage restored from disk");
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a transcript with no wire twin indexes its usage and metadata", async () => {
  const { dir, source, outDir, dbPath } = await setup("solo");
  const sum = await importTranscripts({ source, outDir, dbPath });
  assert.equal(sum.found, 2);
  assert.equal(sum.written, 2);
  assert.equal(sum.byEntrypoint["claude-desktop"], 1);
  assert.equal(sum.byEntrypoint.cli, 1);
  const s = new Store(dbPath);
  const u = sumUsage(s);
  assert.equal(u.out, 49 + 1 + 4, "A main + A subagent + B own; copies not counted");
  const rows = s.listSessions();
  const main = rows.find((r) => r.title === "Demo transcript session");
  assert.ok(main);
  assert.equal(main.origin, "transcript");
  assert.equal(main.entrypoint, "claude-desktop");
  assert.equal(main.projectCwd, "/tmp/demo-project");
  const sub = rows.find((r) => r.title.startsWith("Look around"));
  assert.ok(sub, "subagent group labelled from its meta.json");
  assert.deepEqual(
    s.listSessions({ thread: "subagent" }).map((r) => r.sessionId),
    [sub.sessionId],
  );
  // Hooks recovered from the transcript join on Claude's session uuid.
  const hooks = s.listHooksForSession(main.sessionId);
  assert.deepEqual(hooks.map((h) => h.event).sort(), ["PreToolUse", "Stop"]);
  assert.equal(hooks.find((h) => h.event === "Stop").hookName, "stop.js");
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("incremental re-import picks up appended lines without duplicating steps", async () => {
  const { dir, source, outDir, dbPath } = await setup("incr");
  await importTranscripts({ source, outDir, sessions: [B], dbPath });
  let s = new Store(dbPath);
  const sid = s.listSessions()[0].sessionId;
  assert.equal(s.listSteps(sid).length, 2);
  s.close();

  // Unchanged: nothing rewritten, index watermark skip.
  const again = await importTranscripts({ source, outDir, sessions: [B], dbPath });
  assert.equal(again.written, 0);
  assert.equal(again.unchanged, 1);
  assert.equal(again.indexed.skipped, 1);

  // The session keeps running: a prompt + a two-record response are appended,
  // and the last line is still being written (cut off).
  const file = path.join(source, "-tmp-demo-project", `${B}.jsonl`);
  const base = {
    isSidechain: false,
    userType: "external",
    entrypoint: "cli",
    cwd: "/tmp/demo-project",
    sessionId: B,
    version: "9.9.9",
    gitBranch: "feature-x",
  };
  const lines = [
    { ...base, type: "user", uuid: "u-b002", timestamp: "2026-01-03T09:01:00.000Z", message: { role: "user", content: "one more thing" } },
    { ...base, type: "assistant", uuid: "a-b002", timestamp: "2026-01-03T09:01:02.000Z", message: { model: "claude-sonnet-5-5", id: "msg_demo_b002", role: "assistant", content: [{ type: "text", text: "Sure." }], usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    { ...base, type: "assistant", uuid: "a-b003", timestamp: "2026-01-03T09:01:03.000Z", message: { model: "claude-sonnet-5-5", id: "msg_demo_b002", role: "assistant", content: [{ type: "text", text: " Done." }], usage: { input_tokens: 5, output_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
  ];
  // Bump mtime past the mirror's so the cheap check sees the change.
  fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n" + '{"type":"user","mess');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future);

  const third = await importTranscripts({ source, outDir, sessions: [B], dbPath });
  assert.equal(third.written, 1);
  assert.equal(third.badLines, 1, "half-written tail skipped, not fatal");
  s = new Store(dbPath);
  const sessions = s.listSessions();
  assert.equal(sessions.length, 1, "same session, re-indexed in place");
  const steps = s.listSteps(sessions[0].sessionId);
  assert.deepEqual(
    steps.map((x) => x.message),
    ["continue from where we left off", "Continuing.", "one more thing", "Sure. Done."],
  );
  assert.equal(sumUsage(s).out, 4 + 6, "appended response counted once with its final count");
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("strictly read-only on the source dir, and refuses to write inside it", async () => {
  const { dir, source, outDir, dbPath } = await setup("ro");
  const before = snapshot(source);
  await importTranscripts({ source, outDir, dbPath, force: true });
  assert.deepEqual(snapshot(source), before, "no source file changed (size, mtime, content)");
  await assert.rejects(
    importTranscripts({ source, outDir: path.join(source, "x"), dbPath, index: false }),
    /Refusing to write inside/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a transcript holding only unknown or malformed records imports as nothing", () => {
  const dir = tmpdir("junk");
  const proj = path.join(dir, "-tmp-junk");
  fs.mkdirSync(proj, { recursive: true });
  const id = "cccccccc-0000-4000-8000-000000000003";
  fs.writeFileSync(
    path.join(proj, `${id}.jsonl`),
    ['{"type":"queue-operation","sessionId":"x"}', "not json", '{"type":"brand-new","a":1}', "[1,2]", "null"].join("\n"),
  );
  const refs = listTranscripts(dir);
  assert.equal(refs.length, 1);
  assert.equal(importTranscript(refs[0], ownershipFor(refs)), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("usage dedupe: a response id that resumes after an interleaved tool_result counts once, at its final count", () => {
  const dir = tmpdir("interleave");
  const proj = path.join(dir, "-tmp-p");
  fs.mkdirSync(proj, { recursive: true });
  const id = "dddddddd-0000-4000-8000-000000000004";
  const base = { sessionId: id, cwd: "/tmp/p", entrypoint: "cli", version: "9.9.9", gitBranch: "main", isSidechain: false };
  const asst = (uuid, ts, block, out) => ({
    ...base, type: "assistant", uuid, timestamp: ts,
    message: { model: "claude-opus-5-5", id: "msg_par", role: "assistant", content: [block], usage: { input_tokens: 3, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  });
  const recs = [
    { ...base, type: "user", uuid: "u1", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "go" } },
    asst("a1", "2026-01-01T00:00:01.000Z", { type: "tool_use", id: "toolu_a", name: "Read", input: {} }, 10),
    { ...base, type: "user", uuid: "u2", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "A" }] } },
    asst("a2", "2026-01-01T00:00:03.000Z", { type: "tool_use", id: "toolu_b", name: "Read", input: {} }, 30),
    { ...base, type: "user", uuid: "u3", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_b", content: "B" }] } },
  ];
  fs.writeFileSync(path.join(proj, `${id}.jsonl`), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const refs = listTranscripts(dir);
  const imp = importTranscript(refs[0], ownershipFor(refs));
  assert.equal(imp.responses, 1, "one distinct API response");
  assert.equal(imp.countedResponses, 1);
  const [t] = buildTrajectories(imp.pairs);
  assert.equal(t.metrics.completionTokens, 30, "final output count, once");
  assert.equal(t.metrics.promptTokens, 3);
  const calls = t.steps.flatMap((s) => s.toolCalls.map((c) => c.id));
  assert.deepEqual(calls, ["toolu_a", "toolu_b"]);
  const obs = t.steps.flatMap((s) => (s.observation?.results ?? []).map((r) => r.content));
  assert.deepEqual(obs, ["A", "B"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the same session uuid under two project dirs gets two mirrors, not one overwritten", async () => {
  const dir = tmpdir("dupid");
  const source = path.join(dir, "projects");
  for (const slug of ["-tmp-one", "-tmp-two"]) {
    fs.mkdirSync(path.join(source, slug), { recursive: true });
    fs.copyFileSync(path.join(FIXTURE_ROOT, "-tmp-demo-project", `${B}.jsonl`), path.join(source, slug, `${B}.jsonl`));
  }
  const outDir = path.join(dir, "out");
  const dbPath = path.join(dir, "index.db");
  const sum = await importTranscripts({ source, outDir, dbPath });
  assert.equal(sum.written, 2);
  assert.equal(fs.readdirSync(outDir).filter((f) => f.endsWith(".jsonl")).length, 2);
  // Identical copies: the shared response is billed by one mirror only.
  const s = new Store(dbPath);
  // A is absent here, so its copied response (7) is kept — but in one mirror only.
  assert.equal(sumUsage(s).out, 4 + 7);
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a response copied into a later transcript under the NEW session id is billed once (earliest wins)", async () => {
  const dir = tmpdir("restamp");
  const source = path.join(dir, "projects");
  copyDir(FIXTURE_ROOT, source);
  // Session E re-uses one of A's responses verbatim but stamped with E's id
  // (same record uuid and timestamp), then adds one response of its own.
  const E = "eeeeeeee-0000-4000-8000-000000000005";
  const aLines = fs
    .readFileSync(path.join(source, "-tmp-demo-project", `${A}.jsonl`), "utf8")
    .split("\n")
    .filter((l) => l.includes('"msg_demo_0002"'));
  const copied = aLines.map((l) => l.replaceAll(A, E));
  const own = {
    type: "assistant", uuid: "a-e001", timestamp: "2026-02-01T00:00:00.000Z", sessionId: E, isSidechain: false,
    entrypoint: "sdk-cli", cwd: "/tmp/demo-project",
    message: { model: "claude-opus-5-5", id: "msg_demo_e001", role: "assistant", content: [{ type: "text", text: "E own" }], usage: { input_tokens: 1, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  };
  fs.writeFileSync(
    path.join(source, "-tmp-demo-project", `${E}.jsonl`),
    [...copied, JSON.stringify(own)].join("\n") + "\n",
  );
  const outDir = path.join(dir, "out");
  const dbPath = path.join(dir, "index.db");
  await importTranscripts({ source, outDir, dbPath });
  const s = new Store(dbPath);
  assert.equal(sumUsage(s).out, 49 + 1 + 4 + 3, "msg_demo_0002 (7 out) counted in A only");
  s.close();
  // A re-run with nothing changed keeps the same answer and rewrites nothing.
  const again = await importTranscripts({ source, outDir, dbPath });
  assert.equal(again.written, 0);
  const s2 = new Store(dbPath);
  assert.equal(sumUsage(s2).out, 49 + 1 + 4 + 3);
  s2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
