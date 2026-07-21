#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { spawn } from "child_process";
import { DevinHTMLGenerator } from "./devin-html-generator";
import {
  defaultDevinDbPath,
  getDevinSession,
  importAllDevinSessions,
  importDevinSession,
  listDevinSessions,
  openDevinDb,
  type DevinImportedSession,
  type DevinSessionMeta,
} from "./devin/importer";

const colors = {
  red: "\x1b[0;31m",
  green: "\x1b[0;32m",
  yellow: "\x1b[1;33m",
  blue: "\x1b[0;34m",
  magenta: "\x1b[0;35m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
} as const;
type ColorName = keyof typeof colors;

function log(message: string, color: ColorName = "reset"): void {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function showHelp(): void {
  console.log(`
${colors.blue}tracetap devin${colors.reset}
Import Devin CLI (Cognition) sessions from its local store into tracetap.

Devin talks to a proprietary cloud backend, so its LLM traffic can't be proxied
like Claude Code / Codex / Gemini. Instead it persists the full trajectory
locally (${colors.dim}~/.local/share/devin/cli/sessions.db${colors.reset}); this command reconstructs each
session into tracetap's JSONL + HTML viewer and indexes it into the store.

${colors.yellow}USAGE:${colors.reset}
  tracetap devin import [OPTIONS]        Reconstruct sessions → .devin-trace/ + index
  tracetap devin list [OPTIONS]          List sessions in the Devin store (no writes)

${colors.yellow}OPTIONS:${colors.reset}
  --session <id>            Import only this session (repeatable). Default: all
  --db <path>              Path to sessions.db (default: $DEVIN_SESSIONS_DB or the
                           standard install location)
  --out <dir>              Write all .jsonl/.html into <dir> instead of each
                           session's own working directory
  --here                   Write into ./.devin-trace in the current directory
  --no-index               Don't index the imported sessions into ~/.tracetap/index.db
  --no-html                Skip the HTML viewer (JSONL only)
  --no-open                Don't open the HTML report on a single-session import
  --generate-html <f.jsonl> [out.html]   Rebuild HTML from an existing devin JSONL, then exit
  --help, -h               Show this help

${colors.yellow}EXAMPLES:${colors.reset}
  tracetap devin list
  tracetap devin import
  tracetap devin import --session trail-bongo
  tracetap devin import --here --no-index
  tracetap devin import --db /path/to/sessions.db --out ./devin-runs

${colors.yellow}OUTPUT:${colors.reset}
  <workdir>/.devin-trace/<session-id>.{jsonl,html}  (or --out / --here)
  Then browse everything with: tracetap serve   ·   tracetap explore
`);
}

interface ParsedArgs {
  command: "import" | "list";
  sessions: string[];
  db?: string;
  out?: string;
  here: boolean;
  index: boolean;
  html: boolean;
  open: boolean;
  generateHtml?: { input: string; output?: string };
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: "import",
    sessions: [],
    here: false,
    index: true,
    html: true,
    open: true,
    help: false,
  };
  let sawCommand = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") parsed.help = true;
    else if (a === "--session") {
      // Guard value flags against swallowing a following flag as their value
      // (e.g. `--session --no-index` must not disable indexing silently).
      const v = argv[i + 1];
      if (v && !v.startsWith("-")) {
        parsed.sessions.push(v);
        i++;
      } else log("--session requires a session id", "yellow");
    } else if (a === "--db") {
      const v = argv[i + 1];
      if (v && !v.startsWith("-")) {
        parsed.db = v;
        i++;
      } else log("--db requires a path", "yellow");
    } else if (a === "--out") {
      const v = argv[i + 1];
      if (v && !v.startsWith("-")) {
        parsed.out = v;
        i++;
      } else log("--out requires a directory", "yellow");
    } else if (a === "--here") parsed.here = true;
    else if (a === "--no-index") parsed.index = false;
    else if (a === "--no-html") parsed.html = false;
    else if (a === "--no-open") parsed.open = false;
    else if (a === "--generate-html") {
      const input = argv[i + 1];
      let output: string | undefined;
      const next = argv[i + 2];
      i += 1;
      if (next && !next.startsWith("--")) {
        output = next;
        i += 1;
      }
      parsed.generateHtml = { input, output };
    } else if (!a.startsWith("-")) {
      // First bare token is the subcommand (or a session id if it isn't one);
      // subsequent bare tokens are positional session ids.
      if (!sawCommand) {
        if (a === "list" || a === "import") parsed.command = a;
        else parsed.sessions.push(a);
        sawCommand = true;
      } else {
        parsed.sessions.push(a);
      }
    }
    // Unknown flags are ignored (kept forgiving, like the other tracers).
  }
  return parsed;
}

/** Where a session's artifacts are written, honoring --out / --here / default. */
function outputDirFor(meta: DevinSessionMeta, args: ParsedArgs): { dir: string; fellBack: boolean } {
  if (args.out) return { dir: path.resolve(args.out), fellBack: false };
  if (args.here) return { dir: path.join(process.cwd(), ".devin-trace"), fellBack: false };
  const wd = meta.workingDirectory;
  if (wd && isExistingDir(wd)) return { dir: path.join(wd, ".devin-trace"), fellBack: false };
  return { dir: path.join(process.cwd(), ".devin-trace"), fellBack: true };
}

function isExistingDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function safeBase(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_") || "session";
}

async function generateHTMLFromCLI(input: string, output: string | undefined): Promise<void> {
  try {
    const out = await new DevinHTMLGenerator().generateHTMLFromJSONL(input, output);
    log(`Generated ${out}`, "green");
    process.exit(0);
  } catch (err) {
    log(`Error: ${(err as Error).message}`, "red");
    process.exit(1);
  }
}

export async function run(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    showHelp();
    process.exit(0);
  }
  if (args.generateHtml) {
    if (!args.generateHtml.input) {
      log("Missing input file for --generate-html", "red");
      process.exit(1);
    }
    await generateHTMLFromCLI(args.generateHtml.input, args.generateHtml.output);
    return;
  }

  const dbPath = args.db || defaultDevinDbPath();
  let db;
  try {
    db = openDevinDb(dbPath);
  } catch (err) {
    log((err as Error).message, "red");
    process.exit(1);
  }

  try {
    const metas = listDevinSessions(db);
    if (metas.length === 0) {
      log(`No Devin sessions found in ${dbPath}.`, "yellow");
      return;
    }

    if (args.command === "list") {
      printSessionList(metas, dbPath);
      return;
    }

    // --- import ---
    let selected: DevinImportedSession[];
    if (args.sessions.length > 0) {
      selected = [];
      for (const id of args.sessions) {
        const meta = getDevinSession(db, id);
        if (!meta) {
          log(`Session not found: ${id}`, "yellow");
          continue;
        }
        const s = importDevinSession(db, meta);
        if (s) selected.push(s);
        else log(`Session has no turns to import: ${id}`, "yellow");
      }
    } else {
      selected = importAllDevinSessions(db);
    }

    if (selected.length === 0) {
      log("Nothing to import.", "yellow");
      return;
    }

    // Fail fast on an --out that exists but isn't a directory, rather than
    // crashing mid-loop on the first mkdirSync.
    if (args.out) {
      const outDir = path.resolve(args.out);
      try {
        if (!fs.statSync(outDir).isDirectory()) {
          log(`--out path exists but is not a directory: ${outDir}`, "red");
          process.exit(1);
        }
      } catch {
        // Does not exist yet — mkdirSync will create it. Fine.
      }
    }

    log(`tracetap · devin import`, "magenta");
    log(`Source: ${dbPath}`, "dim");
    console.log("");

    const htmlGen = args.html ? new DevinHTMLGenerator() : null;
    const written: { meta: DevinSessionMeta; jsonl: string; html?: string; turns: number }[] = [];
    // Distinct session ids can collapse to the same safeBase() (e.g. "a/b" and
    // "a_b"); under --out/--here they'd share a path and clobber each other, so
    // disambiguate on collision with a short hash of the raw id.
    const usedBases = new Set<string>();

    for (const session of selected) {
      try {
        const { dir, fellBack } = outputDirFor(session.meta, args);
        fs.mkdirSync(dir, { recursive: true });
        let base = safeBase(session.meta.id);
        if (usedBases.has(base)) {
          base = `${base}-${crypto.createHash("sha1").update(session.meta.id).digest("hex").slice(0, 8)}`;
        }
        usedBases.add(base);
        const jsonlPath = path.join(dir, `${base}.jsonl`);
        fs.writeFileSync(jsonlPath, session.pairs.map((p) => JSON.stringify(p)).join("\n") + "\n");

        let htmlPath: string | undefined;
        if (htmlGen) {
          htmlPath = path.join(dir, `${base}.html`);
          await htmlGen.generateHTML(session.pairs, htmlPath, {
            title: session.meta.title || `Devin session ${session.meta.id}`,
            timestamp: new Date().toISOString().replace("T", " ").slice(0, -5),
          });
        }
        written.push({ meta: session.meta, jsonl: jsonlPath, html: htmlPath, turns: session.turns });

        const label = session.meta.title ? `${session.meta.id} — ${session.meta.title}` : session.meta.id;
        log(`  ✓ ${label}`, "green");
        log(`    ${session.turns} turns · ${session.resolvedModel} · ${session.pairs.length} pairs`, "dim");
        log(`    ${jsonlPath}${fellBack ? "  (workdir missing; wrote to cwd)" : ""}`, "dim");
      } catch (err) {
        log(`  ✗ ${session.meta.id}: ${(err as Error).message}`, "red");
      }
    }

    if (written.length === 0) {
      log("\nNo sessions were written.", "yellow");
      return;
    }

    // Index into the cross-session store unless opted out.
    if (args.index) {
      console.log("");
      try {
        const { Store } = await import("./store");
        const store = new Store();
        let sessions = 0;
        let steps = 0;
        for (const w of written) {
          // Attribute the session to Devin's real working directory (authoritative
          // from the store), not the path we happened to write the JSONL to.
          const res = store.indexFile(
            w.jsonl,
            w.meta.workingDirectory ? { projectCwd: w.meta.workingDirectory } : undefined,
          );
          sessions += res.sessions;
          steps += res.steps;
        }
        store.close();
        log(`Indexed ${sessions} session(s), ${steps} step(s) into the tracetap store.`, "green");
        log(`Explore with:  tracetap serve   ·   tracetap explore   ·   tracetap search "<q>" --agent devin`, "dim");
      } catch (err) {
        log(`Indexing skipped: ${(err as Error).message}`, "yellow");
      }
    }

    // Open the report only for a focused single-session import.
    if (args.open && htmlGen && written.length === 1 && written[0].html && fs.existsSync(written[0].html)) {
      try {
        spawn("open", [written[0].html], { detached: true, stdio: "ignore" }).unref();
        log(`\nOpened ${written[0].html}`, "green");
      } catch {
        // ignore
      }
    }
  } finally {
    db.close();
  }
}

function printSessionList(metas: DevinSessionMeta[], dbPath: string): void {
  log(`Devin sessions in ${dbPath}:`, "magenta");
  console.log("");
  for (const m of metas) {
    const when = m.lastActivityAt ? new Date(Math.round(m.lastActivityAt * 1000)).toISOString().slice(0, 16).replace("T", " ") : "—";
    const title = m.title || "(untitled)";
    log(`  ${m.id}`, "blue");
    log(`    ${title}`, "reset");
    log(`    ${m.model} · ${m.backendType} · ${m.agentMode} · ${when} · ${m.workingDirectory}`, "dim");
  }
  console.log("");
  log(`${metas.length} session(s). Import with: tracetap devin import [--session <id>]`, "dim");
}

// Allow direct invocation as well as dispatch from tracetap.ts.
if (require.main === module) {
  run(process.argv.slice(2)).catch((err) => {
    log(`Unexpected error: ${(err as Error).message}`, "red");
    process.exit(1);
  });
}
