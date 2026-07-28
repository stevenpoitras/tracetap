import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { trackInject, uninstallTracking } from "../dist/hooks/configure.js";
import { MARKER, discoverHooks, wrapCommand } from "../dist/hooks/discover.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MORPHOS = path.resolve(HERE, "../../morphos");

test("wrapCommand prefixes tap once", () => {
  const once = wrapCommand('node "x.mjs"', {
    name: "done-gate",
    event: "Stop",
  });
  assert.ok(once.includes(MARKER));
  assert.ok(once.includes("--name done-gate"));
  assert.equal(wrapCommand(once, { name: "done-gate", event: "Stop" }), once);
});

test("discoverHooks finds fixture plugin hooks.json", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-disc-"));
  try {
    const hooksDir = path.join(root, "hooks");
    fs.mkdirSync(hooksDir);
    fs.writeFileSync(
      path.join(hooksDir, "hooks.json"),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: 'cat "${CLAUDE_PLUGIN_ROOT}/hooks/posture.txt"',
                  timeout: 10,
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/done-gate.mjs"',
                  timeout: 10,
                },
              ],
            },
          ],
        },
      }),
      "utf-8",
    );
    const result = discoverHooks(root);
    assert.equal(result.hooks.length, 2);
    assert.equal(result.hooks[0].event, "UserPromptSubmit");
    assert.equal(result.hooks[1].event, "Stop");
    assert.ok(result.hooks[1].resolvedCommand.includes(root));
    assert.equal(result.hooks[1].alreadyTracked, false);
    assert.ok(result.hooks[1].suggestedName.includes("done-gate"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("trackInject wraps selected commands and uninstall restores bak", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-track-"));
  try {
    const hooksFile = path.join(root, "hooks", "hooks.json");
    fs.mkdirSync(path.dirname(hooksFile));
    fs.writeFileSync(
      hooksFile,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                { type: "command", command: "node done-gate.mjs", timeout: 10 },
              ],
            },
          ],
        },
      }),
      "utf-8",
    );
    const discovered = discoverHooks(root);
    assert.equal(discovered.hooks.length, 1);
    const res = trackInject(discovered.hooks);
    assert.equal(res.tracked, 1);
    const after = JSON.parse(fs.readFileSync(hooksFile, "utf-8"));
    assert.ok(after.hooks.Stop[0].hooks[0].command.includes(MARKER));
    assert.ok(fs.existsSync(hooksFile + ".tracetap.bak"));

    const again = discoverHooks(root);
    assert.equal(again.hooks[0].alreadyTracked, true);
    const skip = trackInject(again.hooks);
    assert.equal(skip.tracked, 0);

    const un = uninstallTracking({ restoreBackupsUnder: root });
    assert.ok(un.filesRestored.includes(hooksFile));
    const restored = JSON.parse(fs.readFileSync(hooksFile, "utf-8"));
    assert.equal(restored.hooks.Stop[0].hooks[0].command, "node done-gate.mjs");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  "discoverHooks reads morphos hooks when present",
  { skip: !fs.existsSync(path.join(MORPHOS, "hooks", "hooks.json")) },
  () => {
    const result = discoverHooks(MORPHOS);
    assert.ok(
      result.hooks.length >= 2,
      `expected ≥2 morphos hooks, got ${result.hooks.length}`,
    );
    const events = new Set(result.hooks.map((h) => h.event));
    assert.ok(events.has("UserPromptSubmit"));
    assert.ok(events.has("Stop"));
    const stop = result.hooks.find((h) => h.event === "Stop");
    assert.ok(stop?.command.includes("done-gate"));
    assert.ok(stop?.resolvedCommand.includes("done-gate"));
  },
);
