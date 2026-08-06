/**
 * `thread=main|subagent|any` — which side of a Claude fan-out gets listed.
 *
 * Kept in its own file with its own store rather than folded into
 * serve.test.mjs, because that suite asserts exact session counts and adding a
 * subagent fixture to its `before()` would shift every one of them.
 *
 * The fixture is `claude-subagent.jsonl`: two main-thread calls (cch=aaa111)
 * that spawn a Task, plus the child's own call (cch=bbb222) carrying
 * `cc_is_subagent=true` in its embedded billing header. The codex fixture rides
 * along to prove a harness that never emits the marker is not swept up by the
 * default.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Store } from "../dist/store/index.js";
import { handleRequest } from "../dist/store/serve.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRAJ_FIX = path.join(__dirname, "..", "src", "trajectory", "__fixtures__");

let tmp;
let store;
let server;
let baseUrl;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-thread-"));
  const claudeDir = path.join(tmp, "proj", ".claude-trace");
  const codexDir = path.join(tmp, "proj", ".codex-trace");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  fs.copyFileSync(
    path.join(TRAJ_FIX, "claude-subagent.jsonl"),
    path.join(claudeDir, "sub.jsonl"),
  );
  fs.copyFileSync(
    path.join(TRAJ_FIX, "codex-tooluse.jsonl"),
    path.join(codexDir, "cx.jsonl"),
  );

  store = new Store(path.join(tmp, "index.db"));
  store.indexPaths([tmp]);

  server = http.createServer((req, res) => handleRequest(store, req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  store?.close?.();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const titles = (rows) => rows.map((s) => s.title).sort();

async function getJson(p) {
  const res = await fetch(baseUrl + p);
  return { status: res.status, body: JSON.parse(await res.text()) };
}

// -- store ----------------------------------------------------------------

test("listSessions splits the fan-out into main and subagent", () => {
  assert.deepEqual(titles(store.listSessions({ thread: "main" })), [
    "Investigate the failing build",
    "List the files",
  ]);
  assert.deepEqual(titles(store.listSessions({ thread: "subagent" })), [
    "Find the failing test",
  ]);
  // The two halves partition the whole — nothing dropped, nothing double-counted.
  assert.equal(
    store.listSessions({ thread: "main" }).length +
      store.listSessions({ thread: "subagent" }).length,
    store.listSessions({ thread: "any" }).length,
  );
});

test("the store default is 'any' — narrowing belongs to the caller", () => {
  assert.deepEqual(
    titles(store.listSessions({})),
    titles(store.listSessions({ thread: "any" })),
  );
  assert.equal(store.listSessions({}).length, 3);
});

test("a harness that never emits the marker counts as main", () => {
  // Codex writes request rows like everyone else, all with is_subagent = 0, so
  // "no evidence of being a subagent" must not read as "is one".
  const main = store.listSessions({ thread: "main" });
  assert.ok(main.some((s) => s.agent === "codex"), "codex must survive thread=main");
  assert.ok(!store.listSessions({ thread: "subagent" }).some((s) => s.agent === "codex"));
});

test("getSession still reaches a subagent group under the default", () => {
  const sub = store.listSessions({ thread: "subagent" })[0];
  assert.ok(sub, "fixture must produce a subagent session");
  const detail = store.getSession(sub.sessionId);
  assert.ok(detail, "getSession must not inherit the sessions pane's narrowing");
  assert.equal(detail.sessionId, sub.sessionId);
});

// -- serve ----------------------------------------------------------------

test("GET /api/sessions defaults to every thread", async () => {
  const r = await getJson("/api/sessions");
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 3);
});

test("GET /api/sessions?thread=main hides subagent groups", async () => {
  const r = await getJson("/api/sessions?thread=main");
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 2);
  assert.deepEqual(titles(r.body.sessions), [
    "Investigate the failing build",
    "List the files",
  ]);
});

test("GET /api/sessions?thread=subagent keeps only the children", async () => {
  const r = await getJson("/api/sessions?thread=subagent");
  assert.equal(r.body.count, 1);
  assert.equal(r.body.sessions[0].title, "Find the failing test");
});

test("thread composes with the other filters instead of replacing them", async () => {
  const both = await getJson("/api/sessions?thread=main&agent=codex");
  assert.equal(both.body.count, 1);
  assert.equal(both.body.sessions[0].agent, "codex");

  const none = await getJson("/api/sessions?thread=subagent&agent=codex");
  assert.equal(none.body.count, 0);
});

test("an unrecognized thread value falls back to 'any' rather than erroring", async () => {
  const r = await getJson("/api/sessions?thread=parent");
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 3);
});
