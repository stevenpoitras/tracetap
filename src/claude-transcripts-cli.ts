#!/usr/bin/env node

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { PriceTable } from "./analytics";
import {
  IMPORT_FORMAT_VERSION,
  TRANSCRIPT_TRACE_DIR,
  defaultClaudeProjectsDir,
  importTranscript,
  listTranscripts,
  ownershipFor,
  serializePairs,
  type TranscriptFileRef,
} from "./claude-transcripts/importer";

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

/** Default mirror dir: one central trace dir, discoverable by `tracetap index` (walks ~). */
export function defaultTranscriptOutDir(): string {
  return path.join(os.homedir(), TRANSCRIPT_TRACE_DIR);
}

function showHelp(): void {
  console.log(`
${colors.blue}tracetap claude-transcripts${colors.reset}
Import Claude Code's own local session transcripts into tracetap.

Sessions that were never run under \`tracetap claude\` — the Claude desktop app
above all, which can't be wrapped — still leave a transcript under
${colors.dim}~/.claude/projects/<project>/<session>.jsonl${colors.reset}. This command reads those files
(strictly read-only), rebuilds each session as tracetap JSONL and indexes it, so
\`serve\`, \`search\` and \`usage\` cover them too.

${colors.yellow}USAGE:${colors.reset}
  tracetap claude-transcripts import [OPTIONS]   Mirror transcripts → ${TRANSCRIPT_TRACE_DIR}/ + index
  tracetap claude-transcripts list [OPTIONS]     List transcripts found (no writes)

${colors.yellow}OPTIONS:${colors.reset}
  --session <uuid>     Import only this session (repeatable). Default: all
  --source <dir>       Claude projects dir (default: $CLAUDE_CONFIG_DIR/projects
                       or ~/.claude/projects)
  --out <dir>          Write the .jsonl mirrors into <dir> (default: ~/${TRANSCRIPT_TRACE_DIR})
  --here               Write into ./${TRANSCRIPT_TRACE_DIR} in the current directory
  --db <path>          Index into this store DB (default: ~/.tracetap/index.db)
  --no-index           Write the mirrors only; don't index them
  --force              Rebuild every mirror even when its transcript is unchanged
  --offline            Don't fetch the live price table (cache or built-ins)
  --quiet              Print the summary only
  --help, -h           Show this help

${colors.yellow}NOTES:${colors.reset}
  Re-running is incremental: unchanged transcripts are skipped, appended ones
  are rebuilt and re-indexed in place (no duplicate steps). When a session was
  ALSO captured on the wire by \`tracetap claude\`, the wire capture wins: the
  transcript copy's usage is not counted and it is hidden from lists/search.
  No HTML viewer is written — browse with \`tracetap serve\`.
`);
}

interface ParsedArgs {
  command: "import" | "list";
  sessions: string[];
  source?: string;
  out?: string;
  here: boolean;
  db?: string;
  index: boolean;
  force: boolean;
  offline: boolean;
  quiet: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: "import",
    sessions: [],
    here: false,
    index: true,
    force: false,
    offline: false,
    quiet: false,
    help: false,
  };
  let sawCommand = false;
  const value = (i: number, what: string): string | undefined => {
    const v = argv[i + 1];
    if (v && !v.startsWith("-")) return v;
    log(`${argv[i]} requires ${what}`, "yellow");
    return undefined;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") parsed.help = true;
    else if (a === "--session") {
      const v = value(i, "a session uuid");
      if (v) {
        parsed.sessions.push(v);
        i++;
      }
    } else if (a === "--source") {
      const v = value(i, "a directory");
      if (v) {
        parsed.source = v;
        i++;
      }
    } else if (a === "--out") {
      const v = value(i, "a directory");
      if (v) {
        parsed.out = v;
        i++;
      }
    } else if (a === "--db") {
      const v = value(i, "a path");
      if (v) {
        parsed.db = v;
        i++;
      }
    } else if (a === "--here") parsed.here = true;
    else if (a === "--no-index") parsed.index = false;
    else if (a === "--force") parsed.force = true;
    else if (a === "--offline") parsed.offline = true;
    else if (a === "--quiet" || a === "-q") parsed.quiet = true;
    else if (!a.startsWith("-")) {
      if (!sawCommand && (a === "list" || a === "import")) parsed.command = a;
      else parsed.sessions.push(a);
      sawCommand = true;
    }
  }
  return parsed;
}

function outDirFor(args: ParsedArgs): string {
  if (args.out) return path.resolve(args.out);
  if (args.here) return path.join(process.cwd(), TRANSCRIPT_TRACE_DIR);
  return defaultTranscriptOutDir();
}

/** Change signature of a transcript and its subagent files (size + mtime of each). */
function sourceSig(ref: TranscriptFileRef): string {
  return [ref, ...ref.subagents].map((f) => `${f.size}:${Math.round(f.mtimeMs)}`).join("|");
}

/**
 * Per-mirror import state, kept in the OUTPUT dir (never under ~/.claude):
 * what the transcript looked like when its mirror was built, which response
 * ids it counted, and which of those it ceded to another transcript.
 */
interface MirrorState {
  sig: string;
  /**
   * IMPORT_FORMAT_VERSION the mirror was written with. A mirror from another
   * version is rebuilt even when its transcript is unchanged; absent = 1.
   */
  fmt?: number;
  startedAt: number;
  /** Ids counted by a full (unskipped) import — the cross-file ownership input. */
  ids: string[];
  /** Ids whose usage was stripped from the mirror because another transcript owns them. */
  ceded: string[];
  empty?: boolean;
}
interface ImportState {
  v: 1;
  mirrors: Record<string, MirrorState>;
}
const STATE_FILE = ".import-state.json";

function loadState(outDir: string): ImportState {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(outDir, STATE_FILE), "utf8"));
    if (j && j.v === 1 && j.mirrors && typeof j.mirrors === "object") return j as ImportState;
  } catch {
    // missing or corrupt: rebuild
  }
  return { v: 1, mirrors: {} };
}

function saveState(outDir: string, state: ImportState): void {
  const p = path.join(outDir, STATE_FILE);
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, p);
}

function sameSet(a: string[], b: Set<string>): boolean {
  if (a.length !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

export interface ImportSummary {
  found: number;
  written: number;
  unchanged: number;
  empty: number;
  failed: number;
  byEntrypoint: Record<string, number>;
  responses: number;
  countedResponses: number;
  badLines: number;
  hooks: number;
  slowest: { sessionId: string; ms: number; bytes: number } | null;
  files: string[];
  indexed?: { sessions: number; steps: number; skipped: number };
}

/**
 * Mirror (and optionally index) transcripts. Exposed for tests; the CLI is a
 * thin wrapper. Never writes under the source dir.
 */
export async function importTranscripts(opts: {
  source?: string;
  outDir: string;
  sessions?: string[];
  force?: boolean;
  index?: boolean;
  dbPath?: string;
  /**
   * Price table for the index-time cost estimates (`sessions.cost_usd`). The
   * CLI passes the live table, as `tracetap index` does; without one the
   * store falls back to the built-in table, which lags new models — that was
   * why imported sessions showed no cost.
   */
  prices?: PriceTable;
  onSession?: (line: string) => void;
}): Promise<ImportSummary> {
  const source = path.resolve(opts.source || defaultClaudeProjectsDir());
  const outDir = path.resolve(opts.outDir);
  if (outDir === source || outDir.startsWith(source + path.sep)) {
    throw new Error(`Refusing to write inside the transcript source dir: ${outDir}`);
  }
  const all = listTranscripts(source);
  const ownership = ownershipFor(all);
  const wanted = opts.sessions && opts.sessions.length ? new Set(opts.sessions) : null;
  const refs = wanted ? all.filter((r) => wanted.has(r.sessionId)) : all;

  const summary: ImportSummary = {
    found: refs.length,
    written: 0,
    unchanged: 0,
    empty: 0,
    failed: 0,
    byEntrypoint: {},
    responses: 0,
    countedResponses: 0,
    badLines: 0,
    hooks: 0,
    slowest: null,
    files: [],
  };
  fs.mkdirSync(outDir, { recursive: true });

  // The same session uuid can sit under two project dirs (observed: a session
  // continued from a different cwd). Each gets its own mirror, so neither
  // overwrites the other; the suffix is a pure function of the slug.
  const perId = new Map<string, number>();
  for (const r of all) perId.set(r.sessionId, (perId.get(r.sessionId) ?? 0) + 1);
  const mirrorName = (ref: TranscriptFileRef) =>
    (perId.get(ref.sessionId) ?? 0) > 1
      ? `${ref.sessionId}~${crypto.createHash("sha1").update(ref.projectSlug).digest("hex").slice(0, 8)}.jsonl`
      : `${ref.sessionId}.jsonl`;

  const state = loadState(outDir);
  const changed = new Set<string>();
  const builtNow = new Set<string>();

  /** Import `ref`, write its mirror if the bytes differ. Returns null for an empty transcript. */
  const build = (ref: TranscriptFileRef, outPath: string, skipUsageIds?: Set<string>) => {
    const t0 = Date.now();
    const imported = importTranscript(ref, { ...ownership, ...(skipUsageIds ? { skipUsageIds } : {}) });
    const ms = Date.now() - t0;
    const bytes = ref.size + ref.subagents.reduce((n, s) => n + s.size, 0);
    if (!summary.slowest || ms > summary.slowest.ms) summary.slowest = { sessionId: ref.sessionId, ms, bytes };
    if (!imported) return null;
    const text = serializePairs(imported.pairs);
    let same = false;
    try {
      same = fs.readFileSync(outPath, "utf8") === text;
    } catch {
      same = false;
    }
    if (!same) {
      const tmp = `${outPath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, outPath);
      changed.add(outPath);
    }
    return { imported, ms, same };
  };

  // Phase 1: rebuild every mirror whose transcript changed (size/mtime of the
  // main file or any subagent file), with full usage.
  const live: { ref: TranscriptFileRef; name: string; outPath: string }[] = [];
  for (const ref of refs) {
    const name = mirrorName(ref);
    const outPath = path.join(outDir, name);
    const prev = state.mirrors[name];
    const sig = sourceSig(ref);
    try {
      const current = (prev?.fmt ?? 1) === IMPORT_FORMAT_VERSION;
      if (!opts.force && prev && current && prev.sig === sig && (prev.empty || fs.existsSync(outPath))) {
        if (prev.empty) summary.empty++;
        else live.push({ ref, name, outPath });
        continue;
      }
      const res = build(ref, outPath);
      if (!res) {
        state.mirrors[name] = { sig, fmt: IMPORT_FORMAT_VERSION, startedAt: 0, ids: [], ceded: [], empty: true };
        summary.empty++;
        continue;
      }
      const { imported, ms, same } = res;
      state.mirrors[name] = {
        sig,
        fmt: IMPORT_FORMAT_VERSION,
        startedAt: imported.startedAt,
        ids: imported.countedIds,
        ceded: [],
      };
      builtNow.add(name);
      summary.byEntrypoint[imported.meta.entrypoint] = (summary.byEntrypoint[imported.meta.entrypoint] ?? 0) + 1;
      summary.responses += imported.responses;
      summary.countedResponses += imported.countedResponses;
      summary.badLines += imported.badLines;
      summary.hooks += imported.hooks;
      live.push({ ref, name, outPath });
      opts.onSession?.(
        `  ${same ? "=" : "✓"} ${ref.sessionId}  ${imported.meta.entrypoint}  ${imported.responses} responses · ${imported.pairs.length} pairs · ${ms}ms`,
      );
    } catch (err) {
      summary.failed++;
      opts.onSession?.(`  ✗ ${ref.sessionId}: ${(err as Error).message}`);
    }
  }

  // Phase 2: a response id counted by more than one transcript (Claude Code
  // re-stamps some copied records with the new session's id) is owned by the
  // EARLIEST transcript; every other mirror cedes it. Decided over every mirror
  // in the state, not just this run's selection, so a partial import agrees
  // with a full one.
  const present = new Set(all.map(mirrorName));
  const owner = new Map<string, { name: string; startedAt: number }>();
  for (const [name, m] of Object.entries(state.mirrors)) {
    if (!present.has(name) || m.empty) continue;
    for (const id of m.ids) {
      const cur = owner.get(id);
      const better =
        !cur || m.startedAt < cur.startedAt || (m.startedAt === cur.startedAt && name < cur.name);
      if (better) owner.set(id, { name, startedAt: m.startedAt });
    }
  }
  for (const { ref, name, outPath } of live) {
    const m = state.mirrors[name];
    const ceded = new Set(m.ids.filter((id) => owner.get(id)?.name !== name));
    if (sameSet(m.ceded, ceded)) continue;
    try {
      const res = build(ref, outPath, ceded);
      if (res) {
        m.ceded = [...ceded];
        if (builtNow.has(name)) summary.countedResponses -= ceded.size;
      }
    } catch (err) {
      summary.failed++;
      opts.onSession?.(`  ✗ ${ref.sessionId}: ${(err as Error).message}`);
    }
  }
  for (const name of Object.keys(state.mirrors)) if (!present.has(name)) delete state.mirrors[name];
  saveState(outDir, state);

  for (const { outPath } of live) {
    summary.files.push(outPath);
    if (changed.has(outPath)) summary.written++;
    else summary.unchanged++;
  }

  if (opts.index !== false && summary.files.length) {
    const { Store } = await import("./store");
    const storeOpts = opts.prices ? { prices: opts.prices } : {};
    const store = opts.dbPath ? new Store(opts.dbPath, storeOpts) : new Store(undefined, storeOpts);
    try {
      let sessions = 0;
      let steps = 0;
      let skipped = 0;
      for (const f of summary.files) {
        const res = store.indexFile(f);
        sessions += res.sessions;
        steps += res.steps;
        if (res.skipped) skipped++;
      }
      summary.indexed = { sessions, steps, skipped };
    } finally {
      store.close();
    }
  }
  return summary;
}

export async function run(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    showHelp();
    process.exit(0);
  }
  const source = path.resolve(args.source || defaultClaudeProjectsDir());
  if (!fs.existsSync(source)) {
    log(`Claude projects dir not found: ${source}. Pass --source <dir>.`, "red");
    process.exit(1);
  }

  if (args.command === "list") {
    const refs = listTranscripts(source);
    log(`Claude Code transcripts in ${source}:`, "magenta");
    for (const r of refs) {
      const when = new Date(r.mtimeMs).toISOString().slice(0, 16).replace("T", " ");
      log(`  ${r.sessionId}  ${when}  ${(r.size / 1e6).toFixed(1)} MB  ${r.subagents.length} subagent(s)  ${r.projectSlug}`, "dim");
    }
    log(`${refs.length} transcript(s). Import with: tracetap claude-transcripts import`, "dim");
    return;
  }

  const outDir = outDirFor(args);
  log(`tracetap · claude-transcripts import`, "magenta");
  log(`Source: ${source} (read-only)`, "dim");
  log(`Output: ${outDir}`, "dim");
  let summary: ImportSummary;
  try {
    // Same price source as `tracetap index`: fresh cache → network → stale
    // cache → built-ins, never throwing. Skipped when nothing gets indexed.
    let prices: PriceTable | undefined;
    if (args.index) {
      const { loadPrices } = await import("./pricing");
      prices = (await loadPrices({ offline: args.offline })).prices;
    }
    summary = await importTranscripts({
      source,
      outDir,
      sessions: args.sessions,
      force: args.force,
      index: args.index,
      dbPath: args.db,
      prices,
      onSession: args.quiet ? undefined : (l) => log(l, "dim"),
    });
  } catch (err) {
    log((err as Error).message, "red");
    process.exit(1);
  }
  console.log("");
  log(
    `${summary.found} transcript(s): ${summary.written} written, ${summary.unchanged} unchanged, ` +
      `${summary.empty} empty, ${summary.failed} failed`,
    summary.failed ? "yellow" : "green",
  );
  const eps = Object.entries(summary.byEntrypoint)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ");
  if (eps) log(`Entrypoints (rebuilt this run): ${eps}`, "dim");
  log(
    `Responses ${summary.responses} (usage counted for ${summary.countedResponses}) · hooks ${summary.hooks} · malformed lines skipped ${summary.badLines}`,
    "dim",
  );
  if (summary.slowest) {
    log(`Slowest: ${summary.slowest.sessionId} ${summary.slowest.ms}ms (${(summary.slowest.bytes / 1e6).toFixed(1)} MB)`, "dim");
  }
  if (summary.indexed) {
    log(
      `Indexed ${summary.indexed.sessions} session group(s), ${summary.indexed.steps} step(s) ` +
        `(${summary.indexed.skipped} file(s) unchanged).`,
      "green",
    );
    log(`Explore with:  tracetap serve   ·   tracetap usage   ·   tracetap search "<q>"`, "dim");
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((err) => {
    log(`Unexpected error: ${(err as Error).message}`, "red");
    process.exit(1);
  });
}
