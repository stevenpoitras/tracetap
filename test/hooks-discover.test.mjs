import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runHooksInstall } from "../dist/hooks/cli.js";
import { trackInject, uninstallTracking } from "../dist/hooks/configure.js";
import { MARKER, discoverHooks, unwrapCommand, wrapCommand } from "../dist/hooks/discover.js";

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

test("wrapCommand carries --full only on request", () => {
  const opts = { name: "done-gate", event: "Stop" };
  assert.ok(!wrapCommand("node x.mjs", opts).includes("--full"));
  const full = wrapCommand("node x.mjs", { ...opts, full: true });
  assert.match(full, /^tracetap hooks tap --name done-gate --event Stop --full -- node x\.mjs$/);
});

test("trackInject threads --full into the injected wrapper", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-track-full-"));
  try {
    const hooksFile = path.join(root, "hooks", "hooks.json");
    fs.mkdirSync(path.dirname(hooksFile));
    fs.writeFileSync(
      hooksFile,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "node done-gate.mjs" }] }],
        },
      }),
      "utf-8",
    );
    const res = trackInject(discoverHooks(root).hooks, "tracetap", { full: true });
    assert.equal(res.tracked, 1);
    const cmd = JSON.parse(fs.readFileSync(hooksFile, "utf-8")).hooks.Stop[0].hooks[0].command;
    assert.match(cmd, /--full -- node done-gate\.mjs$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  withTmpHome(() => {
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
});

// Point os.homedir() (which reads $HOME on POSIX) at a scratch dir so tests
// never touch the real ~/.claude/settings.json.
function withTmpHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-home-"));
  const prevHome = process.env.HOME;
  const prevFull = process.env.TRACETAP_HOOK_FULL;
  process.env.HOME = home;
  delete process.env.TRACETAP_HOOK_FULL;
  try {
    return fn(home);
  } finally {
    process.env.HOME = prevHome;
    if (prevFull !== undefined) process.env.TRACETAP_HOOK_FULL = prevFull;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("wrapCommand routes shell-syntax commands through sh -c", () => {
  const opts = { name: "guard", event: "PreToolUse" };
  // Env-assignment prefix: spawnSync(shell:false) would ENOENT on "HOOK_ENV=1".
  assert.match(
    wrapCommand("HOOK_ENV=1 node check.mjs", opts),
    /-- sh -c 'HOOK_ENV=1 node check\.mjs'$/,
  );
  // Builtin + && chain: outer shell would split it and wrap only `cd`.
  assert.match(
    wrapCommand("cd ${CLAUDE_PLUGIN_ROOT} && node hook.js", opts),
    /-- sh -c 'cd \$\{CLAUDE_PLUGIN_ROOT\} && node hook\.js'$/,
  );
  // Pipe: the tap must wrap the whole pipeline so parseDecision sees the
  // final stage's stdout, exactly what Claude Code would see.
  assert.ok(wrapCommand("node gate.mjs | tail -1", opts).includes("sh -c 'node gate.mjs | tail -1'"));
  // Single quotes in the original survive the sh -c quoting.
  assert.equal(
    wrapCommand("echo 'hi' && true", opts),
    `tracetap hooks tap --name guard --event PreToolUse -- sh -c 'echo '\\''hi'\\'' && true'`,
  );
  // Plain argv commands keep the direct (no sh -c) form.
  assert.match(wrapCommand("node x.mjs", opts), /-- node x\.mjs$/);
});

test("unwrapCommand inverts wrapCommand for both forms", () => {
  const opts = { name: "guard", event: "Stop" };
  for (const original of [
    "node x.mjs",
    "HOOK_ENV=1 node check.mjs && echo 'done'",
    "cd ${CLAUDE_PLUGIN_ROOT} && node hook.js | tail -1",
  ]) {
    assert.equal(unwrapCommand(wrapCommand(original, opts)), original);
  }
  assert.equal(unwrapCommand("node x.mjs"), null);
});

test("resolveCommand shell-quotes a plugin root with metacharacters", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-evil-"));
  try {
    // A cloned directory name carrying shell metacharacters must not splice
    // raw into the wrapped command (breakage/injection).
    const root = path.join(tmp, 'evil";touch pwned;"');
    fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/run.sh" }] }],
        },
      }),
      "utf-8",
    );
    const hook = discoverHooks(root).hooks[0];
    assert.equal(hook.resolvedCommand, `'${root}'/hooks/run.sh`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("uninstall restores settings and cursor backups created by trackInject", () => {
  withTmpHome(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-restore-"));
    try {
      const settingsFile = path.join(root, ".claude", "settings.json");
      const cursorFile = path.join(root, ".cursor", "hooks.json");
      const settingsOrig = JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "node done-gate.mjs" }] }] },
      });
      const cursorOrig = JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "node guard.mjs" }] }] },
      });
      fs.mkdirSync(path.dirname(settingsFile));
      fs.mkdirSync(path.dirname(cursorFile));
      fs.writeFileSync(settingsFile, settingsOrig, "utf-8");
      fs.writeFileSync(cursorFile, cursorOrig, "utf-8");

      const res = trackInject(discoverHooks(root).hooks);
      assert.equal(res.tracked, 2);
      assert.ok(fs.existsSync(settingsFile + ".tracetap.bak"));
      assert.ok(fs.existsSync(cursorFile + ".tracetap.bak"));
      assert.ok(fs.readFileSync(settingsFile, "utf-8").includes(MARKER));

      const un = uninstallTracking({ restoreBackupsUnder: root });
      assert.ok(un.filesRestored.includes(settingsFile));
      assert.ok(un.filesRestored.includes(cursorFile));
      assert.equal(fs.readFileSync(settingsFile, "utf-8"), settingsOrig);
      assert.equal(fs.readFileSync(cursorFile, "utf-8"), cursorOrig);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test("uninstall unwraps injected commands when the backup is gone", () => {
  withTmpHome(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-unwrap-"));
    try {
      const settingsFile = path.join(root, ".claude", "settings.local.json");
      fs.mkdirSync(path.dirname(settingsFile));
      fs.writeFileSync(
        settingsFile,
        JSON.stringify({
          hooks: { Stop: [{ hooks: [{ type: "command", command: "FOO=1 node done-gate.mjs" }] }] },
        }),
        "utf-8",
      );
      assert.equal(trackInject(discoverHooks(root).hooks).tracked, 1);
      fs.rmSync(settingsFile + ".tracetap.bak");

      const un = uninstallTracking({ restoreBackupsUnder: root });
      assert.equal(un.removedCommands, 1);
      const after = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
      // The wrapper is stripped but the user's hook survives.
      assert.equal(after.hooks.Stop[0].hooks[0].command, "FOO=1 node done-gate.mjs");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test("uninstall surfaces settings.json parse errors instead of swallowing them", () => {
  withTmpHome((home) => {
    const sp = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(sp));
    fs.writeFileSync(sp, "{not json", "utf-8");
    const res = uninstallTracking();
    assert.equal(res.settingsCleared, false);
    assert.equal(res.errors.length, 1);
    assert.ok(res.errors[0].includes(sp));
    // The broken file is left alone.
    assert.equal(fs.readFileSync(sp, "utf-8"), "{not json");
  });
});

test("install merges missing tap events into an existing install", () => {
  withTmpHome((home) => {
    const sp = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(sp));
    // A pre-PreCompact-era install: some events tapped, plus the marker string
    // in a permissions entry — neither may block the merge.
    fs.writeFileSync(
      sp,
      JSON.stringify({
        permissions: { allow: ["Bash(tracetap hooks tap:*)"] },
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: "tracetap hooks tap --name posture-observe --event UserPromptSubmit -- true",
                },
              ],
            },
          ],
        },
      }),
      "utf-8",
    );
    runHooksInstall({});
    const after = JSON.parse(fs.readFileSync(sp, "utf-8"));
    // New taps merged per event…
    for (const event of ["PreToolUse", "PostToolUse", "Stop", "PreCompact", "PostCompact"]) {
      assert.ok(JSON.stringify(after.hooks[event]).includes(MARKER), `missing tap for ${event}`);
    }
    // …already-tapped events are not duplicated, and the rest of the file survives.
    assert.equal(after.hooks.UserPromptSubmit.length, 1);
    assert.deepEqual(after.permissions, { allow: ["Bash(tracetap hooks tap:*)"] });
    // A second run is a no-op.
    const snapshot = fs.readFileSync(sp, "utf-8");
    runHooksInstall({});
    assert.equal(fs.readFileSync(sp, "utf-8"), snapshot);
  });
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
