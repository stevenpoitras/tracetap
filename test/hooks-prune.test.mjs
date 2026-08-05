import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Store } from "../dist/store/index.js";

/**
 * `hooks prune` drops observe-only taps from the index.
 *
 * The distinction under test is the one that matters in practice: an
 * observe-only tap wraps `true` and CANNOT produce a payload, while a wrapped
 * hook that returned nothing is a real result. Both have empty stdout, so
 * pruning must key on the stored `observeOnly` flag, never on emptiness.
 */

let tmp;
let store;

function hookLine(overrides) {
  return {
    v: 1,
    ts: "2023-11-14T22:13:19.000Z",
    session_id: "prune-sess",
    event: "PreToolUse",
    hook_name: "h",
    duration_ms: 3,
    decision: null,
    stdin_digest: "a".repeat(64),
    stdin_preview: { session_id: "prune-sess" },
    stdout_preview: {},
    outcome: "ok",
    exit_code: 0,
    ...overrides,
  };
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-prune-"));
  const hooksDir = path.join(tmp, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });

  const lines = [
    // 3 observe-only stubs — `hooks install` wrapping `true`.
    hookLine({
      hook_name: "pre-tool-observe",
      stdout_preview: { chars: 0, empty: true, observeOnly: true },
    }),
    hookLine({
      hook_name: "post-tool-observe",
      stdout_preview: { chars: 0, empty: true, observeOnly: true },
    }),
    hookLine({
      hook_name: "stop-observe",
      event: "Stop",
      stdout_preview: { chars: 0, empty: true, observeOnly: true },
    }),
    // A real wrapped hook that ran and returned nothing — must survive.
    hookLine({
      hook_name: "real_empty_hook",
      stdout_preview: { chars: 0, empty: true, observeOnly: false },
    }),
    // A real wrapped hook with a payload — must survive.
    hookLine({
      hook_name: "real_payload_hook",
      decision: "allow",
      stdout_preview: { chars: 12, text: '{"ok":true}', decision: "allow" },
    }),
    // Captured before the flag existed: unprovable, so must survive.
    hookLine({ hook_name: "legacy_hook", stdout_preview: { chars: 0 } }),
  ];
  fs.writeFileSync(
    path.join(hooksDir, "prune-sess.jsonl"),
    lines.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );

  store = new Store(path.join(tmp, "index.db"));
  store.indexHooks(hooksDir);
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function names() {
  return store
    .listHooksForSession("prune-sess")
    .map((h) => h.hookName)
    .sort();
}

test("indexes every event before pruning", () => {
  assert.equal(names().length, 6);
});

test("--dry-run reports the count and deletes nothing", () => {
  const res = store.pruneObserveOnlyHooks({ dryRun: true });
  assert.equal(res.matched, 3);
  assert.equal(res.deleted, 0);
  assert.equal(names().length, 6, "dry run must not mutate the index");
});

test("prune removes observe-only taps and only those", () => {
  const res = store.pruneObserveOnlyHooks();
  assert.equal(res.matched, 3);
  assert.equal(res.deleted, 3);
  assert.deepEqual(names(), [
    "legacy_hook",
    "real_empty_hook",
    "real_payload_hook",
  ]);
});

test("a real hook that returned nothing survives — empty stdout is not the key", () => {
  const kept = store
    .listHooksForSession("prune-sess")
    .find((h) => h.hookName === "real_empty_hook");
  assert.ok(kept, "wrapped hook with an empty allow must not be pruned");
  assert.equal(kept.stdoutPreview.observeOnly, false);
});

test("events predating the observeOnly flag are left alone", () => {
  const kept = store
    .listHooksForSession("prune-sess")
    .find((h) => h.hookName === "legacy_hook");
  assert.ok(kept, "unclassified events cannot be proven stubs");
  assert.equal(kept.stdoutPreview.observeOnly, undefined);
});

test("prune is idempotent", () => {
  const res = store.pruneObserveOnlyHooks();
  assert.equal(res.matched, 0);
  assert.equal(res.deleted, 0);
  assert.equal(names().length, 3);
});
