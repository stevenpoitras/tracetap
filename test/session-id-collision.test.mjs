import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Store } from "../dist/store/index.js";
import { conversationIdOf } from "../dist/trajectory/index.js";

/**
 * Two unrelated captures with no system prompt reduce to the same conversation
 * key (`claude:` + hash of {system, model}). The indexer used to delete by
 * session id before inserting, so whichever log was indexed last erased the
 * other — a 1170-call reconstructed session vanished behind a 1-call quota
 * probe. Both must survive, and the first claimant keeps its URL.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, "..", "src", "store", "__fixtures__");
const A = path.join(FIX, "no-system-reconstructed.jsonl");
const B = path.join(FIX, "no-system-quota-probe.jsonl");

function firstPair(p) {
  return JSON.parse(fs.readFileSync(p, "utf8").split("\n")[0]);
}

function withStore(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-collide-"));
  const store = new Store(path.join(tmp, "index.db"));
  try {
    return fn(store, tmp);
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("the fixtures really do collide on the adapter key", () => {
  assert.equal(conversationIdOf(firstPair(A)), conversationIdOf(firstPair(B)));
});

for (const order of [[A, B], [B, A]]) {
  test(`both colliding sessions survive (indexed ${order.map((p) => path.basename(p)).join(" then ")})`, () => {
    withStore((store) => {
      for (const p of order) store.indexFile(p);
      const sessions = store.listSessions({});
      assert.equal(sessions.length, 2, "neither log may erase the other");
      const key = conversationIdOf(firstPair(A));
      const bySource = new Map(sessions.map((s) => [s.sourcePath, s]));
      const first = bySource.get(path.resolve(order[0]));
      const second = bySource.get(path.resolve(order[1]));
      assert.equal(first.sessionId, key, "the first claimant keeps the bare key, so its URL is unchanged");
      assert.notEqual(second.sessionId, key);
      assert.ok(second.sessionId.startsWith(key + "~"));
      for (const s of sessions) assert.equal(s.conversationKey, key);

      // Each session's rows stay its own.
      assert.equal(store.listRequests(bySource.get(A).sessionId).length, 2);
      assert.equal(store.listRequests(bySource.get(B).sessionId).length, 1);
      // And the body-reading path still finds the suffixed session's pairs.
      assert.ok(store.getRawPair(second.sessionId, 0), "re-reading the log filters on the conversation key");
    });
  });
}

test("re-indexing either log keeps both ids stable", () => {
  withStore((store, tmp) => {
    const a = path.join(tmp, "a.jsonl");
    const b = path.join(tmp, "b.jsonl");
    fs.copyFileSync(A, a);
    fs.copyFileSync(B, b);
    store.indexFile(a);
    store.indexFile(b);
    const before = new Map(store.listSessions({}).map((s) => [s.sourcePath, s.sessionId]));
    // Both grow (live captures) and are re-indexed, the suffixed one first.
    fs.appendFileSync(b, fs.readFileSync(B, "utf8"));
    assert.equal(store.indexFile(b).skipped, false);
    fs.appendFileSync(a, fs.readFileSync(A, "utf8").split("\n")[1] + "\n");
    assert.equal(store.indexFile(a).skipped, false);
    const after = new Map(store.listSessions({}).map((s) => [s.sourcePath, s.sessionId]));
    assert.deepEqual(after, before);
  });
});

test("a byte-identical copy of a log is still one session, not two", () => {
  withStore((store, tmp) => {
    const copy = path.join(tmp, "copy.jsonl");
    fs.copyFileSync(A, copy);
    store.indexFile(A);
    store.indexFile(copy);
    const sessions = store.listSessions({});
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sourcePath, copy);
  });
});
