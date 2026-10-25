import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Store } from "../dist/store/index.js";
import { conversationIdOf, groupPairs } from "../dist/trajectory/index.js";

/**
 * Two unrelated captures with no system prompt reduce to the same conversation
 * key (`claude:` + hash of {system, model}). The indexer used to delete by
 * session id before inserting, so whichever log was indexed last erased the
 * other — a 1170-call reconstructed session vanished behind a 1-call quota
 * probe. Both must survive, under ids that do not depend on index order.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const FIX = path.join(ROOT, "src", "store", "__fixtures__");
const A = path.join(FIX, "no-system-reconstructed.jsonl");
const B = path.join(FIX, "no-system-quota-probe.jsonl");
const STRONG = path.join(ROOT, "src", "trajectory", "__fixtures__", "claude-tooluse.jsonl");

function pairsOf(p) {
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function withStore(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-collide-"));
  const open = () => new Store(path.join(tmp, "index.db"));
  try {
    return fn(open, tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Index `files` in order into a fresh DB and return sourcePath → sessionId. */
function idsAfter(files) {
  return withStore((open) => {
    const store = open();
    try {
      for (const f of files) store.indexFile(f);
      return new Map(store.listSessions({}).map((s) => [s.sourcePath, s.sessionId]));
    } finally {
      store.close();
    }
  });
}

const KEY = conversationIdOf(pairsOf(A)[0]);

test("the fixtures really do collide on the adapter key, and it is weak", () => {
  assert.equal(conversationIdOf(pairsOf(B)[0]), KEY);
  assert.equal(groupPairs(pairsOf(A))[0].weakKey, true);
  assert.equal(groupPairs(pairsOf(B))[0].weakKey, true);
});

test("a key built from a system prompt is strong, so its URL stays bare", () => {
  const [g] = groupPairs(pairsOf(STRONG));
  assert.equal(g.weakKey, false);
  const ids = idsAfter([STRONG]);
  assert.equal(ids.get(STRONG), g.sessionId);
});

test("both colliding sessions survive with their own rows", () => {
  withStore((open) => {
    const store = open();
    try {
      store.indexFile(A);
      store.indexFile(B);
      const sessions = store.listSessions({});
      assert.equal(sessions.length, 2, "neither log may erase the other");
      const bySource = new Map(sessions.map((s) => [s.sourcePath, s]));
      for (const s of sessions) {
        assert.ok(s.sessionId.startsWith(KEY + "~"), "weak keys are always scoped by source");
        assert.equal(s.conversationKey, KEY);
      }
      assert.notEqual(bySource.get(A).sessionId, bySource.get(B).sessionId);
      assert.equal(store.listRequests(bySource.get(A).sessionId).length, 2);
      assert.equal(store.listRequests(bySource.get(B).sessionId).length, 1);
      // The body-reading path re-reads the log and filters on the conversation key.
      assert.ok(store.getRawPair(bySource.get(A).sessionId, 1));
    } finally {
      store.close();
    }
  });
});

test("ids are the same whatever the index order, and across a rebuild", () => {
  const ab = idsAfter([A, B]);
  const ba = idsAfter([B, A]);
  assert.deepEqual(ba, ab);
  // A rebuild (what a schema bump does) re-indexes from empty: same ids again.
  withStore((open) => {
    let store = open();
    store.indexFile(B);
    store.indexFile(A);
    store.close();
    store = open();
    try {
      store.db.prepare("DELETE FROM files").run();
      store.indexFile(A);
      store.indexFile(B);
      assert.deepEqual(new Map(store.listSessions({}).map((s) => [s.sourcePath, s.sessionId])), ab);
    } finally {
      store.close();
    }
  });
});

test("an id does not move when the other claimant's log changes or goes", () => {
  withStore((open, tmp) => {
    const a = path.join(tmp, "a.jsonl");
    const b = path.join(tmp, "b.jsonl");
    fs.copyFileSync(A, a);
    fs.copyFileSync(B, b);
    const store = open();
    try {
      store.indexFile(b);
      store.indexFile(a);
      const before = new Map(store.listSessions({}).map((s) => [s.sourcePath, s.sessionId]));
      // b stops producing the key (rewritten into a strong-key capture).
      fs.copyFileSync(STRONG, b);
      store.indexFile(b);
      fs.appendFileSync(a, pairsOf(A).map((p) => JSON.stringify(p)).slice(1).join("\n") + "\n");
      assert.equal(store.indexFile(a).skipped, false);
      const after = store.listSessions({}).find((s) => s.sourcePath === a);
      assert.equal(after.sessionId, before.get(a));
    } finally {
      store.close();
    }
  });
});

// The copy lives in the temp dir, which sorts after the fixture, so the
// original is canonical either way. Indexing the copy first exercises the
// takeover branch (the original evicts it); indexing it second, the skip branch.
for (const copyFirst of [false, true]) {
  test(`a byte-identical copy of a non-first collider counts once (copy indexed ${copyFirst ? "first" : "second"})`, () => {
    withStore((open, tmp) => {
      const copy = path.join(tmp, "copy-of-probe.jsonl");
      fs.copyFileSync(B, copy);
      assert.ok(B < copy, "fixture path must sort before the temp copy");
      const store = open();
      try {
        store.indexFile(A);
        if (copyFirst) {
          assert.equal(store.indexFile(copy).skipped, false);
          assert.equal(store.indexFile(B).skipped, false, "the canonical log takes over from its copy");
        } else {
          store.indexFile(B);
          assert.equal(store.indexFile(copy).duplicateOf, B);
        }
        // Re-indexing either again changes nothing.
        store.indexFile(copy);
        store.indexFile(B);
        const probe = store.listSessions({}).filter((s) => s.conversationKey === KEY);
        assert.deepEqual(probe.map((s) => s.sourcePath).sort(), [B, A].sort(), "A plus the probe, not its copy");
        const { n } = store.db.prepare("SELECT COUNT(*) AS n FROM usage_events").get();
        const { m } = store.db.prepare("SELECT COUNT(*) AS m FROM requests").get();
        assert.equal(m, 3, "2 calls from A + 1 from the probe, not 4");
        assert.equal(n, 3, "spend is not double-counted");
      } finally {
        store.close();
      }
    });
  });
}

test("a copy stops being skipped once its twin's content moves on", () => {
  withStore((open, tmp) => {
    const orig = path.join(tmp, "a.jsonl");
    const copy = path.join(tmp, "b.jsonl");
    fs.copyFileSync(B, orig);
    fs.copyFileSync(B, copy);
    const store = open();
    try {
      store.indexFile(orig);
      assert.equal(store.indexFile(copy).duplicateOf, orig);
      fs.appendFileSync(orig, fs.readFileSync(B, "utf8"));
      store.indexFile(orig);
      assert.equal(store.indexFile(copy).skipped, false, "no longer identical, so it is its own capture");
      assert.equal(store.listSessions({}).length, 2);
    } finally {
      store.close();
    }
  });
});
