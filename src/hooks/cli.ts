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
 *   hooks tap | install | uninstall | status | discover | track | help
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

  track [path] [--all | --ids <id,id>] [--mode inject|settings] [--yes]
                    Wrap selected discovered hooks through \`tracetap hooks tap\`.
                    Default mode=inject rewrites the source hooks.json (single
                    fire, full returned payload). settings mode merges into
                    ~/.claude/settings.json (can double-fire with plugins).
                    Without --all/--ids/--yes, prompts interactively.

  install           Install generic observe-only taps into ~/.claude/settings.json
                    (events fire with empty allow — good baseline visibility).

  uninstall [--restore [path]]
                    Remove tracetap tap wrappers from ~/.claude/settings.json.
                    With --restore [path], also restore *.tracetap.bak hooks.json
                    under that repo (default: cwd).

  status            Show hooks directory, recent logs, install state.

  help              Show this help

IMPORTANT:
  Stopping \`tracetap serve\` does NOT remove hooks. Hooks live in Claude Code
  settings / plugin hooks.json until you run \`tracetap hooks uninstall\`.

ENV:
  TRACETAP_HOOK_FULL=1   Include full stdin payload on each event
  TRACETAP_HOOKS_DIR     Override ~/.tracetap/hooks
`;

function hooksDir(): string {
  return process.env.TRACETAP_HOOKS_DIR?.trim() || defaultHooksDir();
}

function settingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

/** Suggested UserPromptSubmit + Stop tap wrappers (non-destructive install). */
export function installSnippet(tracetapBin = "tracetap"): object {
  return {
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: `${tracetapBin} hooks tap --name posture-observe --event UserPromptSubmit -- true`,
              timeout: 10,
            },
          ],
        },
      ],
      PreToolUse: [
        {
          hooks: [
            {
              type: "command",
              command: `${tracetapBin} hooks tap --name pre-tool-observe --event PreToolUse -- true`,
              timeout: 10,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            {
              type: "command",
              command: `${tracetapBin} hooks tap --name post-tool-observe --event PostToolUse -- true`,
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
              command: `${tracetapBin} hooks tap --name stop-observe --event Stop -- true`,
              timeout: 10,
            },
          ],
        },
      ],
    },
  };
}

function deepMergeHooks(target: any, source: any): any {
  const out = { ...(target || {}) };
  const th = { ...(out.hooks || {}) };
  const sh = source.hooks || {};
  for (const [event, matchers] of Object.entries(sh)) {
    const existing = Array.isArray(th[event]) ? [...th[event]] : [];
    const incoming = Array.isArray(matchers) ? matchers : [];
    const already = JSON.stringify(existing).includes(MARKER);
    if (!already) existing.push(...incoming);
    th[event] = existing;
  }
  out.hooks = th;
  return out;
}

export function runHooksInstall(): void {
  const snippet = installSnippet();
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
  if (JSON.stringify(existing).includes(MARKER)) {
    console.log(`Already installed in ${sp} (found "${MARKER}").`);
    console.log(`Tip: run \`tracetap hooks discover\` then \`tracetap hooks track\` to wrap real repo hooks.`);
    return;
  }
  const merged = deepMergeHooks(existing, snippet);
  try {
    ensureDir(path.dirname(sp));
    if (fs.existsSync(sp) && !fs.existsSync(sp + ".tracetap.bak")) {
      fs.copyFileSync(sp, sp + ".tracetap.bak");
    }
    fs.writeFileSync(sp, JSON.stringify(merged, null, 2) + "\n", "utf-8");
    console.log(`Merged observe hooks into ${sp}`);
    console.log(`Hook events will append under ${hooksDir()}`);
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
      settingsHit = fs.readFileSync(sp, "utf-8").includes(MARKER);
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
    runHooksInstall();
    return;
  }
  if (sub === "status") {
    runHooksStatus();
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
    let ids: string[] | null = null;
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--mode") {
        const m = argv[++i];
        if (m !== "inject" && m !== "settings") throw new Error("--mode must be inject|settings");
        mode = m;
      } else if (a === "--all") all = true;
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
    console.log(`Tracking ${selected.length} hook(s) via mode=${mode}…`);
    const res =
      mode === "inject" ? trackInject(selected) : trackSettings(selected);
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
