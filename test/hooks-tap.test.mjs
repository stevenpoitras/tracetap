import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { installSnippet } from "../dist/hooks/cli.js";
import {
    appendHookEvent,
    buildHookEvent,
    buildStdinPreview,
    buildStdoutPreview,
    outcomeFor,
    parseDecision,
    runTap,
    wrapsRealCommand,
    STDOUT_TEXT_CAP,
} from "../dist/hooks/tap.js";

const CLI = fileURLToPath(new URL("../dist/tracetap.js", import.meta.url));

test("buildStdinPreview keeps structural fields and drops large prompt body", () => {
  const preview = buildStdinPreview({
    session_id: "sess-1",
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: "/tmp/foo.txt", content: "x".repeat(500) },
    prompt: "hello world " + "y".repeat(200),
  });
  assert.equal(preview.session_id, "sess-1");
  assert.equal(preview.tool_name, "Read");
  assert.equal(preview.tool_input.file_path, "/tmp/foo.txt");
  assert.equal(preview.tool_input.content, undefined);
  assert.ok(preview.prompt_chars > 100);
  assert.ok(String(preview.prompt_preview).endsWith("…"));
});

test("buildHookEvent digests stdin and parses block decision", () => {
  const raw = JSON.stringify({
    session_id: "abc",
    hook_event_name: "Stop",
    stop_hook_active: false,
  });
  const ev = buildHookEvent({
    rawStdin: raw,
    hookName: "done-gate",
    stdout: JSON.stringify({ decision: "block", reason: "no verdict" }),
    exitCode: 0,
    durationMs: 12,
  });
  assert.equal(ev.v, 1);
  assert.equal(ev.session_id, "abc");
  assert.equal(ev.event, "Stop");
  assert.equal(ev.decision, "block");
  assert.equal(ev.outcome, "blocked");
  assert.equal(ev.duration_ms, 12);
  assert.match(ev.stdin_digest, /^[a-f0-9]{64}$/);
  assert.equal(ev.payload, undefined);
});

test("TRACETAP_HOOK_FULL includes payload", () => {
  const raw = JSON.stringify({
    session_id: "s",
    hook_event_name: "UserPromptSubmit",
  });
  const ev = buildHookEvent({ rawStdin: raw, includePayload: true });
  assert.deepEqual(ev.payload, {
    session_id: "s",
    hook_event_name: "UserPromptSubmit",
  });
});

test("parseDecision / outcomeFor cover exit conventions", () => {
  assert.equal(parseDecision('{"decision":"allow"}', 0), "allow");
  assert.equal(parseDecision("", 2), "block");
  assert.equal(outcomeFor("block", 0), "blocked");
  assert.equal(outcomeFor(null, 1), "error");
  assert.equal(outcomeFor(null, 0), "ok");
});

test("appendHookEvent creates owner-only dir and log file", { skip: process.platform === "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-mode-"));
  try {
    // Nested, not-yet-existing dir: creation-time modes are what's under test.
    const dir = path.join(root, "state", "hooks");
    const ev = buildHookEvent({
      rawStdin: JSON.stringify({
        session_id: "sess-mode",
        hook_event_name: "UserPromptSubmit",
        prompt: "sensitive",
      }),
      hookName: "tap",
    });
    const file = appendHookEvent(ev, dir);
    // Logs hold prompt/tool text, so no group/other bits on either.
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("appendHookEvent writes JSONL under hooks dir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-hooks-"));
  try {
    const ev = buildHookEvent({
      rawStdin: JSON.stringify({
        session_id: "sess-write",
        hook_event_name: "PreToolUse",
      }),
      hookName: "tap",
    });
    const file = appendHookEvent(ev, dir);
    assert.ok(fs.existsSync(file));
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.session_id, "sess-write");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runTap wraps a command and preserves exit/stdout", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-tap-"));
  try {
    const stdin = JSON.stringify({
      session_id: "wrap-1",
      hook_event_name: "Stop",
    });
    const result = runTap({
      rawStdin: stdin,
      wrappedCmd: [
        "node",
        "-e",
        "process.stdout.write(JSON.stringify({decision:'allow'}));",
      ],
      hookName: "unit",
      hooksDir: dir,
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /allow/);
    assert.equal(result.event.decision, "allow");
    assert.ok(fs.existsSync(result.logPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runTap survives a failed log write and keeps the wrapped result", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-nolog-"));
  try {
    // A regular file where the hooks dir should be: ensureDir throws EEXIST.
    const badDir = path.join(root, "not-a-dir");
    fs.writeFileSync(badDir, "occupied");
    const result = runTap({
      rawStdin: JSON.stringify({ session_id: "nolog-1", hook_event_name: "PreToolUse" }),
      wrappedCmd: [
        "node",
        "-e",
        "process.stdout.write(JSON.stringify({decision:'block'}));",
      ],
      hookName: "unit",
      hooksDir: badDir,
    });
    // Bookkeeping failed, but the hook's decision is intact for re-emit.
    assert.equal(result.logPath, "");
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /block/);
    assert.equal(result.event.decision, "block");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tap CLI re-emits the hook decision even when the log is unwritable", () => {
  // End to end: an unwritable hooks dir must not turn a guard's block into a
  // generic exit-1 error that Claude Code would treat as allow.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-nolog-cli-"));
  try {
    const badDir = path.join(root, "not-a-dir");
    fs.writeFileSync(badDir, "occupied");
    const res = spawnSync(
      process.execPath,
      [
        CLI,
        "hooks",
        "tap",
        "--name",
        "guard",
        "--",
        "node",
        "-e",
        "process.stdout.write(JSON.stringify({decision:'block'}));",
      ],
      {
        input: JSON.stringify({ session_id: "nolog-2", hook_event_name: "PreToolUse" }),
        encoding: "utf-8",
        env: { ...process.env, TRACETAP_HOOKS_DIR: badDir },
      },
    );
    assert.equal(res.status, 0);
    assert.match(res.stdout, /"decision":"block"/);
    assert.match(res.stderr, /hook log write failed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildStdoutPreview keeps returned text for expand/hover", () => {
  const empty = buildStdoutPreview("");
  assert.equal(empty.empty, true);

  const block = buildStdoutPreview(
    JSON.stringify({
      decision: "block",
      reason: "missing verdict",
      hookSpecificOutput: { additionalContext: "inject me ".repeat(20) },
    }),
  );
  assert.equal(block.decision, "block");
  assert.ok(block.text);
  assert.ok(block.additional_context);
  // Small JSON keeps the structured object as-is.
  assert.equal(block.returned.decision, "block");
  assert.equal(block.returned_truncated, undefined);
});

test("buildStdoutPreview caps `returned` like every other field", () => {
  // A hook can return up to spawnSync's 32MB maxBuffer of JSON; the preview
  // must not smuggle it into the JSONL/SQLite layers uncapped via `returned`.
  const big = buildStdoutPreview(
    JSON.stringify({
      decision: "block",
      hookSpecificOutput: { additionalContext: "x".repeat(STDOUT_TEXT_CAP + 120_000) },
    }),
  );
  assert.equal(big.decision, "block");
  assert.equal(big.returned_truncated, true);
  assert.equal(typeof big.returned, "string");
  // "…" is one char; the serialized form itself is held to the cap.
  assert.ok(big.returned.length <= STDOUT_TEXT_CAP + 1);
});

test("wrapsRealCommand treats shell no-ops as capturing nothing", () => {
  // `hooks install` emits `-- true` purely so the tap has something to exec.
  for (const noop of [["true"], [":"], ["/bin/true"], ["/usr/bin/true"]]) {
    assert.equal(wrapsRealCommand(noop), false, noop[0]);
  }
  assert.equal(wrapsRealCommand(undefined), false);
  assert.equal(wrapsRealCommand([]), false);
  assert.equal(wrapsRealCommand(["./posture.sh"]), true);
  // `true` as an argument to a real command is still a real command.
  assert.equal(wrapsRealCommand(["echo", "true"]), true);
});

test("empty stdout is classified in both directions, never left ambiguous", () => {
  // The UI shows three different messages off this one field, so an absent flag
  // must mean "captured before classification existed" and nothing else.
  assert.equal(buildStdoutPreview("", false).observeOnly, true);
  assert.equal(buildStdoutPreview("", true).observeOnly, false);
  assert.equal(buildStdoutPreview("  \n ", false).observeOnly, true);
  // Non-empty stdout needs no flag — there is a payload to show.
  assert.equal(buildStdoutPreview('{"decision":"allow"}').observeOnly, undefined);
});

test("runTap flags an observe-only tap distinctly from a silent real hook", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-observe-"));
  try {
    const rawStdin = JSON.stringify({
      session_id: "observe-1",
      hook_event_name: "UserPromptSubmit",
    });

    const noop = runTap({ rawStdin, wrappedCmd: ["true"], hooksDir: dir });
    assert.equal(noop.event.stdout_preview.observeOnly, true);
    assert.equal(noop.event.outcome, "ok");

    const silent = runTap({
      rawStdin,
      wrappedCmd: ["node", "-e", "process.exit(0)"],
      hooksDir: dir,
    });
    assert.equal(silent.event.stdout_preview.observeOnly, false);
    assert.equal(silent.event.outcome, "ok");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tap --full stores the payload without TRACETAP_HOOK_FULL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-full-"));
  try {
    const rawStdin = JSON.stringify({
      session_id: "full-1",
      hook_event_name: "UserPromptSubmit",
      prompt: "ship it",
    });
    // Through the real CLI: a parser unit test would not prove the flag is
    // actually threaded from argv into buildHookEvent's includePayload.
    const run = (args) =>
      spawnSync(process.execPath, [CLI, "hooks", "tap", ...args], {
        input: rawStdin,
        encoding: "utf-8",
        // Scrub the env override so the flag is the only thing under test.
        env: { ...process.env, TRACETAP_HOOKS_DIR: dir, TRACETAP_HOOK_FULL: "" },
      });

    assert.equal(run(["--name", "with-full", "--full", "--", "true"]).status, 0);
    assert.equal(run(["--name", "no-full", "--", "true"]).status, 0);

    const log = path.join(dir, "full-1.jsonl");
    assert.ok(fs.existsSync(log), "tap wrote to TRACETAP_HOOKS_DIR");
    const events = fs
      .readFileSync(log, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const byName = Object.fromEntries(events.map((e) => [e.hook_name, e]));

    assert.equal(byName["with-full"].payload.prompt, "ship it");
    assert.equal(byName["no-full"].payload, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Events `hooks install` is expected to tap. Asserted as a set rather than a
 * count so adding an event has to be a deliberate edit here, and so a wrong
 * event name cannot pass by keeping the total right.
 */
const INSTALLED_EVENTS = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "PreCompact",
  "PostCompact",
];

test("installSnippet taps every expected event, and only emits --full when asked", () => {
  const commands = (snippet) =>
    Object.values(snippet.hooks).map((m) => m[0].hooks[0].command);

  assert.deepEqual(Object.keys(installSnippet().hooks).sort(), [...INSTALLED_EVENTS].sort());

  const plain = commands(installSnippet());
  for (const cmd of plain) {
    assert.ok(!cmd.includes("--full"), `default install stayed metadata-only: ${cmd}`);
  }

  const full = commands(installSnippet("tracetap", { full: true }));
  assert.equal(full.length, INSTALLED_EVENTS.length);
  for (const cmd of full) {
    assert.match(cmd, /hooks tap .*--full -- true$/);
  }
});

test("hooks install --full writes taps that carry --full", () => {
  // Drive the real CLI against a throwaway HOME: settingsPath() resolves via
  // os.homedir(), so this proves argv → snippet → settings.json end to end
  // without going anywhere near the user's live settings.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-install-"));
  try {
    const settings = path.join(home, ".claude", "settings.json");
    const install = (args) =>
      spawnSync(process.execPath, [CLI, "hooks", "install", ...args], {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: home,
          TRACETAP_HOOKS_DIR: path.join(home, "hooks"),
          // The env var is a second spelling of --full; scrub it so the flag
          // (and its absence) is the only thing under test.
          TRACETAP_HOOK_FULL: "",
        },
      });
    const taps = () =>
      Object.values(JSON.parse(fs.readFileSync(settings, "utf-8")).hooks).flatMap((m) =>
        m.flatMap((entry) => entry.hooks.map((h) => h.command)),
      );

    assert.equal(install([]).status, 0);
    const plain = taps();
    assert.equal(plain.length, INSTALLED_EVENTS.length);
    for (const cmd of plain) assert.ok(!cmd.includes("--full"), cmd);

    // Fresh HOME: install is a no-op once the marker is already present.
    fs.rmSync(path.join(home, ".claude"), { recursive: true, force: true });

    assert.equal(install(["--full"]).status, 0);
    const full = taps();
    assert.equal(full.length, INSTALLED_EVENTS.length);
    for (const cmd of full) assert.match(cmd, /^tracetap hooks tap .*--full -- true$/);
    for (const event of INSTALLED_EVENTS) {
      assert.ok(
        full.some((c) => c.includes("--event " + event)),
        `install --full taps ${event}`,
      );
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("hooks install rejects unknown options", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-install-bad-"));
  try {
    const res = spawnSync(process.execPath, [CLI, "hooks", "install", "--ful"], {
      encoding: "utf-8",
      env: { ...process.env, HOME: home },
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr + res.stdout, /--ful/);
    assert.ok(!fs.existsSync(path.join(home, ".claude", "settings.json")));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("tap rejects unknown options instead of swallowing them as the command", () => {
  const res = spawnSync(process.execPath, [CLI, "hooks", "tap", "--ful", "--", "true"], {
    input: "{}",
    encoding: "utf-8",
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr + res.stdout, /--ful/);
});
