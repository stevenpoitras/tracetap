import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";

import { distBuildStamp } from "../dist/store/serve.js";

/**
 * Build-freshness detection.
 *
 * `composePage()` re-reads the frontend from disk on every request, so the page
 * is always current. Compiled server code is frozen at process start. When a
 * rebuild lands under a running server the two disagree, and the symptom is a
 * pane calling a route the process has never heard of — which reads as a data
 * bug, not a stale process. It hid a missing route for two days.
 *
 * A start-time check cannot catch this (at startup, process and disk agree by
 * definition), so what is tested here is that a stamp taken at load DIVERGES
 * when the tree changes underneath it.
 */

let tmp;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-build-"));
  fs.mkdirSync(path.join(tmp, "store"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "a.js"), "//a\n");
  fs.writeFileSync(path.join(tmp, "store", "b.js"), "//b\n");
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("stamps the newest .js mtime anywhere in the tree", () => {
  const before = distBuildStamp(tmp);
  assert.ok(before > 0, "a tree with .js files must produce a stamp");

  // Nested, so a walk that only reads the top level would miss it.
  const nested = path.join(tmp, "store", "b.js");
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(nested, future, future);

  const after = distBuildStamp(tmp);
  assert.ok(
    after > before,
    `rebuilding a nested file must move the stamp (${before} -> ${after})`,
  );
});

test("non-.js files do not move the stamp", () => {
  // Source maps and .d.ts land in dist too and are rewritten constantly; only
  // the code Node actually loads should count as a reason to restart.
  const before = distBuildStamp(tmp);
  const future = new Date(Date.now() + 120_000);
  const noise = path.join(tmp, "a.js.map");
  fs.writeFileSync(noise, "{}\n");
  fs.utimesSync(noise, future, future);
  assert.equal(distBuildStamp(tmp), before);
});

test("a missing or unreadable tree reports 0 rather than throwing", () => {
  // serve must never fail to answer /api/meta because the stamp walk tripped.
  assert.equal(distBuildStamp(path.join(tmp, "does-not-exist")), 0);
});

test("the running server's own dist tree stamps non-zero", () => {
  // Guards the default argument: if `__dirname/..` ever stops pointing at the
  // compiled tree, freshness silently becomes "never stale".
  assert.ok(distBuildStamp() > 0, "default root must resolve to the dist tree");
});
