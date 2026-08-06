import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { defaultHooksDir, ensureDir } from "./paths";
import { readStdinSync, runTap } from "./tap";
import { discoverHooks, MARKER } from "./discover";
import type { DiscoveredHook } from "./discover";
import { trackInject, trackSettings, uninstallTracking } from "./configure";

/**
 * CLI for `tracetap hooks …`:
 *   hooks tap | install | uninstall | status | discover | track | prune | help
 */

const HELP = `tracetap hooks <subcommand>

Capture Claude Code hook fires into ~/.tracetap/hooks/<session_id>.jsonl so the
observatory can show hook timing, decisions, and payloads next to turns.

SUBCOMMANDS:
  tap [--name <label>] [--event <name>] [--full] [--] <cmd> [args…]
                    Read hook stdin, run <cmd> with the same stdin, log a
                    HookEvent, then re-emit the command's stdout/stderr/exit.
                    --full stores the whole stdin payload on this tap (the
                    per-tap form of TRACETAP_HOOK_FULL=1).
                    <cmd> must be a real command: wrapping \`true\` records that
                    the event fired but captures no returned payload.

  discover [path] [--json]
                    Scan a repo for hooks.json / settings hooks and list them.

  track [path] [--all | --ids <id,id>] [--mode inject|settings] [--full] [--yes]
                    Wrap selected discovered hooks through \`tracetap hooks tap\`.
                    Default mode=inject rewrites the source hooks.json (single
                    fire, and the hook's full returned stdout is captured).
                    settings mode merges into ~/.claude/settings.json (can
                    double-fire with plugins). --full also records what each
                    hook was *given* — see \`install --full\` below.
                    Without --all/--ids/--yes, prompts interactively.

  install [--full]  Install generic observe-only taps into ~/.claude/settings.json
                    (events fire with empty allow — good baseline visibility).
                    --full adds --full to every installed tap, storing the whole
                    hook stdin (prompt text, tool inputs, file contents) in the
                    log. Off by default: that is the payload the observatory
                    shows, but it is also the most sensitive thing tracetap can
                    write to disk. Opt in when you need it.

  uninstall [--restore [path]]
                    Remove tracetap tap wrappers from ~/.claude/settings.json.
                    With --restore [path], also restore *.tracetap.bak hooks.json
                    under that repo (default: cwd).

  prune [--observe-only] [--dry-run] [--db <path>]
                    Drop observe-only tap events from the index. They wrap \`true\`
                    and can never carry a returned payload, so once installed they
                    crowd out the hooks that do. --dry-run counts without deleting.
                    This cleans the index only — run \`hooks uninstall\` to stop
                    generating them, or re-indexing a changed log restores them.

  status            Show hooks directory, recent logs, install state.

  help              Show this help

IMPORTANT:
  Stopping \`tracetap serve\` does NOT remove hooks. Hooks live in Claude Code
  settings / plugin hooks.json until you run \`tracetap hooks uninstall\`.

ENV:
  TRACETAP_HOOK_FULL=1   Include full stdin payload on each event. Global
                         equivalent of --full; set at install/track time it is
                         also baked into the commands they write, so capture
                         survives shells that never export it.
  TRACETAP_HOOKS_DIR     Override ~/.tracetap/hooks
`;

function hooksDir(): string {
  return process.env.TRACETAP_HOOKS_DIR?.trim() || defaultHooksDir();
}

/**
 * True when full-payload capture was asked for, by flag or by env.
 *
 * The env var already forces payload capture at tap runtime (see tap.ts), so a
 * writer that ignored it here would emit commands that behave one way in the
 * installing shell and another way under Claude Code. Folding it in keeps the
 * two spellings of the same request identical.
 */
function wantsFullPayload(flag: boolean): boolean {
  if (flag) return true;
  const env = process.env.TRACETAP_HOOK_FULL;
  return env === "1" || env === "true";
}

function settingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

/** Events installed by `hooks install`, with the tap label used for each. */
const INSTALL_TAPS: ReadonlyArray<{ event: string; name: string }> = [
  { event: "UserPromptSubmit", name: "posture-observe" },
  { event: "PreToolUse", name: "pre-tool-observe" },
  { event: "PostToolUse", name: "post-tool-observe" },
  { event: "Stop", name: "stop-observe" },
  // Compaction is the one context event the wire cannot explain on its own: the
  // request bodies show that items vanished, never why. PreCompact carries the
  // trigger (Claude Code matches it as `manual` vs `auto`), which is the
  // difference between "the user typed /compact" and "the harness hit a limit".
  { event: "PreCompact", name: "pre-compact-observe" },
  { event: "PostCompact", name: "post-compact-observe" },
];

export interface InstallOptions {
  /**
   * Emit `--full` on every installed tap so the whole hook stdin is stored.
   *
   * Opt-in, not default. These taps wrap the no-op `true`, so stdin is the only
   * payload they can record — but that stdin is prompt text, tool inputs and
   * file contents, written unredacted into a shared local store that outlives
   * `tracetap serve`. A baseline install anyone can run should not silently
   * start archiving that; the user asks for it with --full (or the env var).
   */
  full?: boolean;
}

/** Suggested observe-only tap wrappers (non-destructive install). */
export function installSnippet(tracetapBin = "tracetap", opts: InstallOptions = {}): object {
  const full = opts.full ? " --full" : "";
  const hooks: Record<string, unknown> = {};
  for (const { event, name } of INSTALL_TAPS) {
    hooks[event] = [
      {
        hooks: [
          {
            type: "command",
            command: `${tracetapBin} hooks tap --name ${name} --event ${event}${full} -- true`,
            timeout: 10,
          },
        ],
      },
    ];
  }
  return { hooks };
}

function deepMergeHooks(target: any, source: any): { merged: any; addedEvents: string[] } {
  const out = { ...(target || {}) };
  const th = { ...(out.hooks || {}) };
  const sh = source.hooks || {};
  const addedEvents: string[] = [];
  for (const [event, matchers] of Object.entries(sh)) {
    const existing = Array.isArray(th[event]) ? [...th[event]] : [];
    const incoming = Array.isArray(matchers) ? matchers : [];
    // Scoped to this event's own hook list: a tap on another event (or the
    // marker string in a permissions entry) must not block this one.
    const already = JSON.stringify(existing).includes(MARKER);
    if (!already) {
      existing.push(...incoming);
      addedEvents.push(event);
    }
    th[event] = existing;
  }
  out.hooks = th;
  return { merged: out, addedEvents };
}

export function runHooksInstall(opts: InstallOptions = {}): void {
  const full = wantsFullPayload(opts.full === true);
  const snippet = installSnippet("tracetap", { full });
  const sp = settingsPath();
  let existing: any = {};
  if (fs.existsSync(sp)) {
    try {
      existing = JSON.parse(fs.readFileSync(sp, "utf-8"));
    } catch (err) {
      console.error(`Could not parse ${sp}: ${(err as Error).message}`);
      console.log(JSON.stringify(snippet, null, 2));
      return;
    }
  }
  // Merge per event, never per file: a whole-file marker check would read a
  // tracked hook (or a permissions entry naming the tap) as "installed" and
  // silently skip everything — including taps added since the last install,
  // like PreCompact/PostCompact.
  const { merged, addedEvents } = deepMergeHooks(existing, snippet);
  if (!addedEvents.length) {
    console.log(`Already installed in ${sp} (every tap event carries "${MARKER}").`);
    const hasFull = /tracetap hooks tap[^"]*--full/.test(JSON.stringify(existing));
    if (full && !hasFull) {
      console.log(
        `Note: existing taps do not carry --full. Run \`tracetap hooks uninstall\` then \`tracetap hooks install --full\` to switch on payload capture.`,
      );
    }
    console.log(`Tip: run \`tracetap hooks discover\` then \`tracetap hooks track\` to wrap real repo hooks.`);
    return;
  }
  try {
    ensureDir(path.dirname(sp));
    if (fs.existsSync(sp) && !fs.existsSync(sp + ".tracetap.bak")) {
      fs.copyFileSync(sp, sp + ".tracetap.bak");
    }
    fs.writeFileSync(sp, JSON.stringify(merged, null, 2) + "\n", "utf-8");
    console.log(
      addedEvents.length === INSTALL_TAPS.length
        ? `Merged observe hooks into ${sp}`
        : `Merged observe hooks into ${sp} (added ${addedEvents.join(", ")}; other events already tapped)`,
    );
    console.log(`Hook events will append under ${hooksDir()}`);
    console.log(
      full
        ? `payload:   full stdin stored on every event (--full) — includes prompt text and tool inputs`
        : `payload:   metadata only — re-install with --full to store each hook's stdin`,
    );
    console.log(`These persist after \`tracetap serve\` stops — use \`tracetap hooks uninstall\` to remove.`);
  } catch (err) {
    console.error(`Could not write ${sp}: ${(err as Error).message}`);
    console.log("Paste this into your Claude Code settings.json:");
    console.log(JSON.stringify(snippet, null, 2));
  }
}

export function runHooksStatus(): void {
  const dir = hooksDir();
  const sp = settingsPath();
  console.log(`hooks dir: ${dir}`);
  console.log(`exists:    ${fs.existsSync(dir) ? "yes" : "no"}`);
  if (fs.existsSync(dir)) {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { f, mtime: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.mtime - a.mtime);
    console.log(`log files: ${files.length}`);
    for (const row of files.slice(0, 8)) {
      console.log(`  ${row.f}  ${row.size}B  ${new Date(row.mtime).toISOString()}`);
    }
  }
  let settingsHit = false;
  if (fs.existsSync(sp)) {
    try {
      // Scoped to the hooks section: the marker can also appear elsewhere in
      // settings.json (e.g. a permissions allowlist entry), which is not an install.
      const parsed = JSON.parse(fs.readFileSync(sp, "utf-8"));
      settingsHit = JSON.stringify(parsed?.hooks ?? {}).includes(MARKER);
    } catch {
      /* ignore */
    }
  }
  console.log(`settings:  ${sp}`);
  console.log(`installed: ${settingsHit ? "yes (persists after serve stops)" : "no"}`);
  console.log(`cleanup:   tracetap hooks uninstall [--restore]`);
}

function printDiscoverTable(hooks: DiscoveredHook[]): void {
  if (!hooks.length) {
    console.log("No hooks found.");
    return;
  }
  hooks.forEach((h, i) => {
    const flag = h.alreadyTracked ? " [tracked]" : "";
    console.log(
      `  [${i}] ${h.id}${flag}\n      ${h.event}${h.matcher ? ` matcher=${h.matcher}` : ""}  ${h.sourceKind}\n      ${h.command}`,
    );
  });
}

async function promptSelect(hooks: DiscoveredHook[]): Promise<DiscoveredHook[]> {
  if (!process.stdin.isTTY) {
    throw new Error("No TTY — pass --all or --ids <id,id> (or --yes --all).");
  }
  printDiscoverTable(hooks);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(
      `\nTrack which hooks? (comma indices, 'all', or 'none') [${hooks.length} found]: `,
      resolve,
    );
  });
  rl.close();
  const a = answer.trim().toLowerCase();
  if (!a || a === "none") return [];
  if (a === "all" || a === "*") return hooks.filter((h) => !h.alreadyTracked);
  const idxs = a.split(/[,\s]+/).map((x) => Number(x)).filter((n) => Number.isFinite(n));
  return idxs.map((i) => hooks[i]).filter(Boolean);
}

function parseTapArgs(argv: string[]): {
  name?: string;
  event?: string;
  full: boolean;
  cmd: string[];
} {
  let name: string | undefined;
  let event: string | undefined;
  let full = false;
  const cmd: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--") {
      cmd.push(...argv.slice(i + 1));
      break;
    }
    if (a === "--name") {
      name = argv[++i];
    } else if (a === "--event") {
      event = argv[++i];
    } else if (a === "--full") {
      full = true;
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown tap option '${a}'`);
    } else {
      cmd.push(...argv.slice(i));
      break;
    }
    i++;
  }
  return { name, event, full, cmd };
}

export async function runHooksCli(argv: string[]): Promise<void> {
  const sub = argv[0] || "help";
  if (sub === "help" || sub === "--help" || sub === "-h") {
    console.log(HELP);
    return;
  }
  if (sub === "install") {
    let full = false;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--full") full = true;
      else throw new Error(`Unknown install option '${argv[i]}'`);
    }
    runHooksInstall({ full });
    return;
  }
  if (sub === "status") {
    runHooksStatus();
    return;
  }
  if (sub === "prune") {
    let dryRun = false;
    let dbPath: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--dry-run" || a === "-n") dryRun = true;
      // Accepted explicitly so the command reads intentionally at a call site,
      // and so a future --errored/--all mode is not a breaking change.
      else if (a === "--observe-only") continue;
      else if (a === "--db") dbPath = argv[++i];
      else throw new Error(`Unknown prune option '${a}'`);
    }
    const { Store, defaultDbPath } = await import("../store/index");
    const store = new Store(dbPath || defaultDbPath());
    const res = store.pruneObserveOnlyHooks({ dryRun });
    if (dryRun) {
      console.log(`prune --dry-run: ${res.matched} observe-only event(s) would be removed`);
    } else {
      console.log(`prune: removed ${res.deleted} observe-only event(s)`);
    }
    console.log(`Stop generating them with: tracetap hooks uninstall`);
    return;
  }
  if (sub === "uninstall") {
    let restorePath: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--restore") {
        restorePath = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : process.cwd();
      }
    }
    const res = uninstallTracking({
      restoreBackupsUnder: restorePath,
    });
    console.log(
      `uninstall: removed ${res.removedCommands} tap command(s); settings cleared=${res.settingsCleared}`,
    );
    for (const e of res.errors) console.error(`  error: ${e} — taps may still be installed`);
    if (res.filesRestored.length) {
      console.log(`restored:`);
      for (const f of res.filesRestored) console.log(`  ${f}`);
    } else if (restorePath) {
      console.log(`no *.tracetap.bak hooks.json found under ${path.resolve(restorePath)}`);
    }
    console.log(`Note: this is what removes hooks — stopping tracetap serve does not.`);
    return;
  }
  if (sub === "discover") {
    let root = process.cwd();
    let json = false;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--json") json = true;
      else if (!argv[i].startsWith("-")) root = argv[i];
    }
    const result = discoverHooks(root);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`tracetap hooks discover → ${result.root}`);
    console.log(`sources: ${result.sources.length ? result.sources.join(", ") : "(none)"}`);
    printDiscoverTable(result.hooks);
    console.log(`\nNext: tracetap hooks track ${root === process.cwd() ? "" : root + " "}--mode inject`);
    return;
  }
  if (sub === "track") {
    let root = process.cwd();
    let mode: "inject" | "settings" = "inject";
    let all = false;
    let yes = false;
    let full = false;
    let ids: string[] | null = null;
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--mode") {
        const m = argv[++i];
        if (m !== "inject" && m !== "settings") throw new Error("--mode must be inject|settings");
        mode = m;
      } else if (a === "--full") full = true;
      else if (a === "--all") all = true;
      else if (a === "--yes" || a === "-y") yes = true;
      else if (a === "--ids") {
        ids = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
      } else if (!a.startsWith("-")) root = a;
      else throw new Error(`Unknown track option '${a}'`);
    }
    const result = discoverHooks(root);
    if (!result.hooks.length) {
      console.log(`No hooks found under ${result.root}`);
      return;
    }
    let selected: DiscoveredHook[];
    if (all || (yes && !ids)) {
      selected = result.hooks.filter((h) => !h.alreadyTracked);
    } else if (ids) {
      selected = result.hooks.filter((h) => ids!.includes(h.id));
      for (const id of ids) {
        const n = Number(id);
        if (Number.isFinite(n) && result.hooks[n]) selected.push(result.hooks[n]);
      }
      const seen = new Set<string>();
      selected = selected.filter((h) => (seen.has(h.id) ? false : (seen.add(h.id), true)));
    } else {
      selected = await promptSelect(result.hooks);
    }
    if (!selected.length) {
      console.log("Nothing selected.");
      return;
    }
    const trackFull = wantsFullPayload(full);
    console.log(
      `Tracking ${selected.length} hook(s) via mode=${mode}${trackFull ? " (--full: storing hook stdin)" : ""}…`,
    );
    const opts = { full: trackFull };
    const res =
      mode === "inject"
        ? trackInject(selected, "tracetap", opts)
        : trackSettings(selected, "tracetap", opts);
    console.log(`tracked=${res.tracked} skipped=${res.skipped}`);
    for (const f of res.files) console.log(`  wrote ${f}`);
    for (const w of res.warnings) console.log(`  warn: ${w}`);
    console.log(`Events → ${hooksDir()}/<session_id>.jsonl`);
    console.log(`Remove later with: tracetap hooks uninstall --restore ${root}`);
    return;
  }
  if (sub === "tap") {
    const { name, event, full, cmd } = parseTapArgs(argv.slice(1));
    const rawStdin = readStdinSync();
    const result = runTap({
      rawStdin,
      wrappedCmd: cmd.length ? cmd : undefined,
      hookName: name,
      eventName: event,
      hooksDir: hooksDir(),
      // `--full` is the per-tap equivalent of TRACETAP_HOOK_FULL=1. A flag can
      // live in the hooks.json entry itself; an env var has to be exported into
      // whatever spawns Claude Code, which is not always the user's shell.
      includePayload: full || undefined,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
    return;
  }
  throw new Error(`Unknown hooks subcommand '${sub}'. Run 'tracetap hooks help'.`);
}
