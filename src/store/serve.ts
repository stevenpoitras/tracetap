import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { AddressInfo } from "net";
import { Store, defaultDbPath } from "./index";
import type {
  RequestRow,
  SearchFilters,
  SessionListFilters,
  ToolsetUsageRow,
  UsageEventFilters,
} from "./index";
import { computeToolsetTax } from "../context/tooltax";
import type { ToolsetTax } from "../context/tooltax";
import { costForMetrics, priceFor } from "../analytics";
import type { PriceTable } from "../analytics";
import { loadPrices } from "../pricing";
import { aggregateUsage, parseWhen } from "../usage";
import type { Granularity } from "../usage";
import { auditOneFilePath, reportFromScans } from "../audit";
import type { AuditFileScan, AuditReport } from "../audit";
import type { FlowGraph } from "../flow/derive";
import type { ContextTimeline } from "../context/timeline";
import { findCompactions as findCompactionPoints } from "../context/timeline";

/**
 * `tracetap serve` — the local observatory over the cross-session store.
 *
 * Reads (never writes) the SQLite index and serves a single self-contained
 * HTML dashboard: sessions, full-text search, per-session deep dive
 * (transcript + request waterfall + context lanes), usage/spend reports,
 * fleet analytics, and the system-prompt registry. An SSE endpoint notifies
 * the page when the index changes (e.g. `tracetap index` ran in another
 * terminal) so every view live-refreshes.
 *
 * Built on Node's stdlib `http.createServer` only — no express, no SPA
 * framework, no auth, no cloud. The page is composed at request time from
 * `frontend/serve/{app.html,app.css,app.js}` into ONE inline document (no
 * external script/style requests), preserving curl-ability and the
 * everything-local posture. Prices come from the on-disk cache (or built-ins);
 * serve itself never touches the network.
 */

const SERVE_HELP = `tracetap serve [options]

Start the local observatory over the cross-session index (SQLite + FTS5):
sessions, search, per-session waterfalls/transcripts, usage & spend,
fleet analytics, and the system-prompt registry. Read-only; no cloud.

OPTIONS:
  --port <n>        Port to listen on (default: 4000)
  --host <addr>     Address to bind (default: 127.0.0.1)
  --db <path>       Index database path (default: ~/.tracetap/index.db)
  --help, -h        Show this help
`;

export interface ServeOptions {
  port: number;
  host: string;
  dbPath: string;
}

/** Parse `tracetap serve` argv into options (mirrors store/cli.ts style). */
export function parseServeArgs(argv: string[]): ServeOptions {
  const opts: ServeOptions = { port: 4000, host: "127.0.0.1", dbPath: defaultDbPath() };

  const need = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined) throw new Error(`${flag} requires a value`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") {
      const n = Math.floor(Number(need(++i, "--port")));
      if (!Number.isFinite(n) || n < 0 || n > 65535) {
        throw new Error(`--port must be a valid port number (0-65535).`);
      }
      opts.port = n;
    } else if (arg === "--host") {
      opts.host = need(++i, "--host");
    } else if (arg === "--db") {
      opts.dbPath = need(++i, "--db");
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option '${arg}'. Run 'tracetap serve --help'.`);
    } else {
      throw new Error(`Unexpected argument '${arg}'. Run 'tracetap serve --help'.`);
    }
  }
  return opts;
}

/** Map a session source log (`foo.jsonl`) to its sibling HTML report (`foo.html`). */
export function reportPathFor(sourcePath: string): string {
  return sourcePath.replace(/\.jsonl$/i, ".html");
}

// ---------------------------------------------------------------------------
// Page composition (frontend/serve/* → one self-contained document)
// ---------------------------------------------------------------------------

function assetDir(): string {
  // dist/store/serve.js → ../../frontend/serve (works from src/ in ts-node too).
  return path.join(__dirname, "..", "..", "frontend", "serve");
}

/**
 * Newest mtime across the compiled tree, or 0 if it cannot be read.
 *
 * `composePage()` re-reads the frontend from disk on EVERY request, so CSS and
 * client JS are always current. The compiled server is the opposite: it is
 * whatever Node loaded at startup, and a later `npm run build` changes nothing
 * until the process restarts. Nothing surfaced that asymmetry, and it hid a
 * missing API route for two days — the page offered a Tool Tax pane that the
 * running server had never heard of, so `/api/session/<id>/tools` fell through
 * to the catch-all handler and 404'd with the path fragment glued onto the
 * session id (`No indexed session 'claude:b5ba8662/tools'`).
 *
 * A start-time check cannot catch this: at startup, process and disk agree by
 * definition. The drift only appears afterwards, so the stamp has to be taken
 * once at load and re-compared while running.
 */
export function distBuildStamp(root: string = path.join(__dirname, "..")): number {
  const stack = [root];
  let newest = 0;
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // raced with a rebuild, or not a directory — not worth failing over
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith(".js")) {
        try {
          const m = fs.statSync(p).mtimeMs;
          if (m > newest) newest = m;
        } catch {
          /* file vanished mid-walk */
        }
      }
    }
  }
  return newest;
}

/** What was on disk when this process loaded — i.e. what Node actually ran. */
const LOADED_BUILD_STAMP = distBuildStamp();

// Re-walking dist on every /api/meta would be wasteful (the page polls it), and
// a few seconds of lag on a "you should restart" notice costs nothing.
const BUILD_STAMP_TTL_MS = 5000;
let buildStampMemo: { at: number; value: number } | null = null;

/**
 * @returns `{ loadedAt, builtAt, stale }` — `stale` means a newer build is on
 *   disk than the one this process is running.
 *
 * The one-second tolerance absorbs filesystem timestamp granularity; without
 * it a rebuild that lands in the same second as startup can read as drift.
 */
export function buildFreshness(): {
  loadedAt: number;
  builtAt: number;
  stale: boolean;
} {
  const now = Date.now();
  if (!buildStampMemo || now - buildStampMemo.at >= BUILD_STAMP_TTL_MS) {
    buildStampMemo = { at: now, value: distBuildStamp() };
  }
  const builtAt = buildStampMemo.value;
  return {
    loadedAt: LOADED_BUILD_STAMP,
    builtAt,
    stale: builtAt > LOADED_BUILD_STAMP + 1000,
  };
}

/**
 * Compose the dashboard page: app.html with the CSS and JS inlined. Read per
 * request (the files are small) so editing the assets needs no server restart.
 *
 * Note the asymmetry this creates with the compiled server — see
 * `distBuildStamp` for why that needs announcing rather than just documenting.
 */
export function composePage(): string {
  const dir = assetDir();
  const html = fs.readFileSync(path.join(dir, "app.html"), "utf-8");
  const css = fs.readFileSync(path.join(dir, "app.css"), "utf-8");
  const charts = fs.readFileSync(path.join(dir, "charts.js"), "utf-8");
  const js = fs.readFileSync(path.join(dir, "app.js"), "utf-8");
  return html
    .split("/*__TRACETAP_CSS__*/")
    .join(css)
    .split("/*__TRACETAP_CHARTS_JS__*/")
    .join(charts)
    .split("/*__TRACETAP_JS__*/")
    .join(js);
}

// ---------------------------------------------------------------------------
// Prices (cache/builtin only — serve never fetches)
// ---------------------------------------------------------------------------

let pricesMemo: { prices: PriceTable; source: string } | null = null;

async function getPrices(): Promise<{ prices: PriceTable; source: string }> {
  if (!pricesMemo) {
    const res = await loadPrices({ offline: true });
    pricesMemo = { prices: res.prices, source: res.source };
  }
  return pricesMemo;
}

// ---------------------------------------------------------------------------
// Derived analytics
// ---------------------------------------------------------------------------

function percentile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Compaction points for one session.
 *
 * Delegates to the timeline's definition rather than keeping a second copy.
 * The copy that used to live here tested transcript items only, so the session
 * summary card reported 85 compactions while the timeline — already fixed to
 * require an actual context drop — reported 54 on the same session. Two
 * implementations of one concept will always drift; the only reliable fix is
 * for there to be one.
 *
 * Sorting is this caller's job: `findCompactionPoints` diffs neighbours, so it
 * requires TIME order. Rows arrive here in seq order, and on a session that
 * runs a fleet those differ — which is itself one of the two things that made
 * the old count wrong.
 */
export function findCompactions(requests: RequestRow[]): { seq: number; from: number; to: number }[] {
  return findCompactionPoints([...requests].sort((a, b) => a.ts - b.ts || a.seq - b.seq));
}

/**
 * Scope filters for {@link fleetAnalytics}. Deliberately the same three the
 * usage report accepts (`since`/`until`/`agent`) so ONE control set in the
 * dashboard governs the whole analytics pane — the stat cards, the charts, the
 * breakdown tables and the bucketed time-series all answer for the same slice.
 */
export interface AnalyticsFilters {
  /** Inclusive unix-epoch-second lower bound. */
  since?: number;
  /** Inclusive unix-epoch-second upper bound. */
  until?: number;
  /** Exact (case-insensitive) agent name — matches `listUsageEvents` semantics. */
  agent?: string;
}

function fleetAnalytics(store: Store, prices: PriceTable, filters: AnalyticsFilters = {}) {
  const { since, until, agent } = filters;

  // Sessions carry no event timestamps, so bound them by start time. The agent
  // match is exact (not the substring `listSessions` does) so it lines up with
  // the usage events, which are the source of every cost figure below — one
  // filter must never mean two different things inside one pane.
  const sessionFilters: SessionListFilters = {};
  if (typeof since === "number") sessionFilters.since = since;
  if (typeof until === "number") sessionFilters.until = until;
  const scopedSessions = store.listSessions(sessionFilters);
  const sessions = agent
    ? scopedSessions.filter((s) => s.agent.toLowerCase() === agent.toLowerCase())
    : scopedSessions;

  const eventFilters: UsageEventFilters = {};
  if (typeof since === "number") eventFilters.since = since;
  if (typeof until === "number") eventFilters.until = until;
  if (agent) eventFilters.agent = agent;
  const events = store.listUsageEvents(eventFilters);

  // Requests predate usage events on old logs and can carry ts = 0/NULL, so
  // bound them by the owning session's start time rather than dropping them.
  const reqWhere: string[] = [];
  const reqParams: Record<string, unknown> = {};
  const reqTs = "COALESCE(NULLIF(r.ts, 0), s.started_at)";
  if (typeof since === "number") {
    reqWhere.push(`${reqTs} >= @since`);
    reqParams.since = since;
  }
  if (typeof until === "number") {
    reqWhere.push(`${reqTs} <= @until`);
    reqParams.until = until;
  }
  if (agent) {
    reqWhere.push("lower(s.agent) = lower(@agent)");
    reqParams.agent = agent;
  }
  const reqWhereSql = reqWhere.length ? `WHERE ${reqWhere.join(" AND ")}` : "";

  // Totals + per-agent + daily trend, re-priced from raw tokens.
  const totals = {
    sessions: sessions.length,
    requests: 0,
    erroredRequests: 0,
    events: events.length,
    costUsd: 0,
    hasUnpriced: false,
    promptTokens: 0,
    completionTokens: 0,
    cacheRead: 0,
    cacheCreation: 0,
    cacheHitRate: 0,
  };
  const perAgent = new Map<
    string,
    { agent: string; sessions: Set<string>; costUsd: number; promptTokens: number; completionTokens: number }
  >();
  const perProject = new Map<
    string,
    { project: string; sessions: Set<string>; costUsd: number; events: number; completionTokens: number }
  >();
  const trendByDay = new Map<string, { date: string; costUsd: number; events: number }>();

  for (const ev of events) {
    const price = ev.model ? priceFor(ev.model, prices) : null;
    const cost = price
      ? costForMetrics(
          {
            promptTokens: ev.promptTokens,
            completionTokens: ev.completionTokens,
            cacheCreationTokens: ev.cacheCreation,
            cacheReadTokens: ev.cacheRead,
          },
          price,
        )
      : ev.costUsd;
    if (cost == null) totals.hasUnpriced = true;
    else totals.costUsd += cost;
    totals.promptTokens += ev.promptTokens;
    totals.completionTokens += ev.completionTokens;
    totals.cacheRead += ev.cacheRead;
    totals.cacheCreation += ev.cacheCreation;

    let pa = perAgent.get(ev.agent);
    if (!pa) {
      pa = { agent: ev.agent, sessions: new Set(), costUsd: 0, promptTokens: 0, completionTokens: 0 };
      perAgent.set(ev.agent, pa);
    }
    pa.sessions.add(ev.sessionId);
    if (cost != null) pa.costUsd += cost;
    pa.promptTokens += ev.promptTokens;
    pa.completionTokens += ev.completionTokens;

    const projKey = ev.projectCwd || "(unknown)";
    let pp = perProject.get(projKey);
    if (!pp) {
      pp = { project: projKey, sessions: new Set(), costUsd: 0, events: 0, completionTokens: 0 };
      perProject.set(projKey, pp);
    }
    pp.sessions.add(ev.sessionId);
    if (cost != null) pp.costUsd += cost;
    pp.events += 1;
    pp.completionTokens += ev.completionTokens;

    if (ev.ts > 0) {
      const date = new Date(ev.ts * 1000).toISOString().slice(0, 10);
      let day = trendByDay.get(date);
      if (!day) {
        day = { date, costUsd: 0, events: 0 };
        trendByDay.set(date, day);
      }
      if (cost != null) day.costUsd += cost;
      day.events += 1;
    }
  }
  const inputSide = totals.promptTokens + totals.cacheCreation + totals.cacheRead;
  totals.cacheHitRate = inputSide > 0 ? totals.cacheRead / inputSide : 0;

  // Per-model wire metrics straight from the requests table, same scope.
  const reqRows = store.db
    .prepare(
      `SELECT r.model AS model, r.errored AS errored, r.ttft_ms AS ttft,
              r.duration_ms AS dur, r.completion_tokens AS outTok
       FROM requests r
       JOIN sessions s ON s.session_id = r.session_id
       ${reqWhereSql}`,
    )
    .all(reqParams) as { model: string; errored: number; ttft: number | null; dur: number | null; outTok: number }[];
  const perModelMap = new Map<
    string,
    { model: string; requests: number; errored: number; ttfts: number[]; durs: number[]; completionTokens: number }
  >();
  for (const r of reqRows) {
    totals.requests += 1;
    if (r.errored) totals.erroredRequests += 1;
    const key = r.model || "(unknown)";
    let pm = perModelMap.get(key);
    if (!pm) {
      pm = { model: key, requests: 0, errored: 0, ttfts: [], durs: [], completionTokens: 0 };
      perModelMap.set(key, pm);
    }
    pm.requests += 1;
    if (r.errored) pm.errored += 1;
    if (r.ttft != null) pm.ttfts.push(r.ttft);
    if (r.dur != null) pm.durs.push(r.dur);
    pm.completionTokens += r.outTok || 0;
  }
  const perModel = [...perModelMap.values()]
    .map((pm) => {
      pm.ttfts.sort((a, b) => a - b);
      pm.durs.sort((a, b) => a - b);
      return {
        model: pm.model,
        requests: pm.requests,
        errored: pm.errored,
        errorRate: pm.requests ? pm.errored / pm.requests : 0,
        ttftP50: percentile(pm.ttfts, 0.5),
        ttftP95: percentile(pm.ttfts, 0.95),
        // Distribution band for the strip chart: p10/p25/p50/p75/p90/p95.
        ttftPcts: [0.1, 0.25, 0.5, 0.75, 0.9, 0.95].map((q) => percentile(pm.ttfts, q)),
        ttftN: pm.ttfts.length,
        durP50: percentile(pm.durs, 0.5),
        completionTokens: pm.completionTokens,
      };
    })
    .sort((a, b) => b.requests - a.requests);

  // Per-NAMED-agent spend, same scope.
  //
  // The `perAgent` map above keys on `sessions.agent`, which is the harness
  // family and is "claude" on every row of a Claude Code install — so that
  // table rendered exactly one row saying "CLAUDE, 82 sessions, $398", which is
  // the totals card wearing a different hat. The names that actually divide the
  // spend are the ones each parent gave the agents it spawned, and they live on
  // `requests`, not on `usage_events`.
  //
  // Priced per row from the row's own model, with the same helpers the totals
  // use, so this table and the cost card can never drift apart.
  const agentRows = store.db
    .prepare(
      `SELECT COALESCE(NULLIF(r.agent_label, ''), '') AS label,
              COALESCE(r.agent_type, '') AS type,
              r.is_subagent AS sub, r.model AS model, r.session_id AS sessionId,
              r.prompt_tokens AS inTok, r.completion_tokens AS outTok,
              r.cache_read AS cr, r.cache_creation AS cc
       FROM requests r
       JOIN sessions s ON s.session_id = r.session_id
       ${reqWhereSql}`,
    )
    .all(reqParams) as {
    label: string;
    type: string;
    sub: number;
    model: string;
    sessionId: string;
    inTok: number;
    outTok: number;
    cr: number;
    cc: number;
  }[];
  const perNamedAgent = new Map<
    string,
    {
      label: string;
      type: string;
      named: boolean;
      calls: number;
      sessions: Set<string>;
      costUsd: number;
      promptTokens: number;
      completionTokens: number;
    }
  >();
  for (const r of agentRows) {
    // Three buckets, never merged: the main thread, each NAMED agent, and the
    // marked-but-unnamed calls whose spawn was never captured.
    const key = !r.sub ? "\u0000main" : r.label || "\u0001unnamed";
    let pa = perNamedAgent.get(key);
    if (!pa) {
      pa = {
        label: !r.sub ? "main thread" : r.label || "unnamed subagents",
        type: r.sub ? r.type : "",
        named: !!r.sub && !!r.label,
        calls: 0,
        sessions: new Set(),
        costUsd: 0,
        promptTokens: 0,
        completionTokens: 0,
      };
      perNamedAgent.set(key, pa);
    }
    const price = r.model ? priceFor(r.model, prices) : null;
    const cost = price
      ? costForMetrics(
          {
            promptTokens: r.inTok,
            completionTokens: r.outTok,
            cacheCreationTokens: r.cc,
            cacheReadTokens: r.cr,
          },
          price,
        )
      : null;
    pa.calls += 1;
    pa.sessions.add(r.sessionId);
    if (cost != null) pa.costUsd += cost;
    pa.promptTokens += r.inTok + r.cr + r.cc;
    pa.completionTokens += r.outTok;
  }

  // Fleet-wide tool histogram from the per-session rollups.
  const toolCounts = new Map<string, number>();
  for (const s of sessions) {
    for (const [name, count] of Object.entries(s.toolHistogram)) {
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + count);
    }
  }
  const topTools = [...toolCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  /** How many distinct tools exist, so the pane can say what the top 20 omits. */
  const toolsTotal = toolCounts.size;

  // Mid-task compactions, scoped to the filtered corpus.
  //
  // Two independent corrections meet here and BOTH are required. The context
  // delta (item drops alone swept up every hop between interleaved subagent
  // conversations, which on a fleet session is most adjacent pairs), and the
  // scope join (an unfiltered count beside filtered cards is two corpora on one
  // screen). The LAG runs over the scoped rows only, so a compaction straddling
  // the window edge is not counted — its predecessor is outside the scope the
  // user asked for.
  //
  // Ordered by ts then seq, not seq alone: seq is assignment order in the log
  // and concurrent calls finish out of order, so the seq predecessor is
  // routinely a LATER turn. Same defect `findCompactions` was fixed for; two
  // orderings of one concept would drift exactly as two definitions did.
  const compactionRow = store.db
    .prepare(
      `SELECT COUNT(*) AS total, COUNT(DISTINCT session_id) AS sessions FROM (
         SELECT r.session_id AS session_id,
                r.transcript_items - LAG(r.transcript_items)
                  OVER (PARTITION BY r.session_id ORDER BY r.ts, r.seq) AS item_delta,
                (r.prompt_tokens + r.cache_read + r.cache_creation)
                  - LAG(r.prompt_tokens + r.cache_read + r.cache_creation)
                  OVER (PARTITION BY r.session_id ORDER BY r.ts, r.seq) AS ctx_delta
         FROM requests r
         JOIN sessions s ON s.session_id = r.session_id
         ${reqWhereSql}
       ) WHERE item_delta < 0 AND ctx_delta < 0`,
    )
    .get(reqParams) as { total: number; sessions: number };

  const topSessions = [...sessions]
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
    .slice(0, 8)
    .map((s) => ({
      sessionId: s.sessionId,
      agent: s.agent,
      // What it WAS, not just what ran it: a "top sessions by cost" table whose
      // first column reads CLAUDE on all eight rows ranks anonymous things.
      title: s.title,
      model: s.model,
      projectCwd: s.projectCwd,
      startedAt: s.startedAt,
      durationMs: s.durationMs,
      costUsd: s.costUsd,
      turns: s.turns,
      errorCount: s.errorCount,
    }));

  // Every agent the index knows about, independent of the current scope — the
  // dashboard's agent picker must not erase the option you just filtered away.
  const agentOptions = (
    store.db.prepare("SELECT DISTINCT agent FROM sessions WHERE agent <> '' ORDER BY agent").all() as {
      agent: string;
    }[]
  ).map((r) => r.agent);

  return {
    filters: {
      since: since ?? null,
      until: until ?? null,
      agent: agent ?? "",
    },
    agentOptions,
    totals,
    perAgent: [...perAgent.values()]
      .map((pa) => ({
        agent: pa.agent,
        sessions: pa.sessions.size,
        costUsd: pa.costUsd,
        promptTokens: pa.promptTokens,
        completionTokens: pa.completionTokens,
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
    /**
     * Spend per named agent, dearest first, with the main thread pinned to the
     * top — it is the only row that is not a delegate, so it is a baseline
     * rather than a competitor in the ranking.
     */
    perNamedAgent: [...perNamedAgent.values()]
      .map((pa) => ({
        label: pa.label,
        type: pa.type,
        named: pa.named,
        calls: pa.calls,
        sessions: pa.sessions.size,
        costUsd: pa.costUsd,
        promptTokens: pa.promptTokens,
        completionTokens: pa.completionTokens,
      }))
      .sort((a, b) => {
        const aMain = a.label === "main thread" ? 1 : 0;
        const bMain = b.label === "main thread" ? 1 : 0;
        if (aMain !== bMain) return bMain - aMain;
        return b.costUsd - a.costUsd;
      }),
    perModel,
    perProject: [...perProject.values()]
      .map((pp) => ({
        project: pp.project,
        sessions: pp.sessions.size,
        costUsd: pp.costUsd,
        events: pp.events,
        completionTokens: pp.completionTokens,
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
    topTools,
    toolsTotal,
    // 26 weeks of daily buckets — feeds the calendar heatmap.
    trend: [...trendByDay.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-182),
    compactions: { totalCompactions: compactionRow.total, sessionsWithCompaction: compactionRow.sessions },
    topSessions,
  };
}

// ---------------------------------------------------------------------------
// Audit (memoized per file content hash)
// ---------------------------------------------------------------------------

const auditMemo = new Map<string, AuditReport>();

/**
 * Run the egress-secret audit over every source file the index knows about.
 *
 * Scanning is linear in log bytes, and wire logs are large — hundreds of MB is
 * ordinary. So the scan is cached PER FILE, in SQLite, keyed on that file's
 * content hash: capturing a new session rescans only the new log, not every
 * log. The in-process memo on top of that keeps repeat visits within a run
 * free; the SQLite layer is what survives a restart.
 *
 * Caching the aggregate report instead would not work — one new log changes the
 * combined key and invalidates everything, which is what made this a 40s+ wait
 * on every server start.
 */
export function clearAuditMemo(): void {
  // The in-process memo would mask the persistent layer underneath it, so tests
  // that assert on caching-across-processes need to drop it first.
  auditMemo.clear();
}

export async function auditIndexedFiles(
  store: Store,
  mode: "standard" | "strict",
): Promise<AuditReport> {
  const rows = store.db
    .prepare("SELECT source_path AS p, content_hash AS h FROM files ORDER BY source_path")
    .all() as { p: string; h: string }[];
  const memoKey = mode + "|" + rows.map((r) => r.p + ":" + r.h).join("|");
  const hit = auditMemo.get(memoKey);
  if (hit) return hit;

  const scans: AuditFileScan[] = [];
  for (const r of rows) {
    const cached = store.getAuditScan(r.p, r.h, mode, true);
    if (cached) {
      scans.push(cached);
      continue;
    }
    // Streamed line-by-line — wire logs can be GBs; never load them whole.
    const scan = await auditOneFilePath(r.p, { mode, redactCheck: true });
    if (!scan) continue; // moved or deleted since indexing
    store.putAuditScan(scan, r.h, mode, true);
    scans.push(scan);
  }

  const report = reportFromScans(scans, { mode, redactCheck: true });
  auditMemo.clear(); // only the latest index state is worth caching
  auditMemo.set(memoKey, report);
  return report;
}

/** Tax for one (session, toolset) row, priced at the model's cache-read rate. */
function taxForUsageRow(row: ToolsetUsageRow, prices: PriceTable): ToolsetTax {
  const price = row.model ? priceFor(row.model, prices) : null;
  return computeToolsetTax(
    row.toolsetHash,
    row.perTool,
    row.toolHistogram,
    row.requestCount,
    price ? price.cacheRead : null,
  );
}

/**
 * Fleet dead-tool-tax rollup: which declared tools cost tokens on every request
 * without ever being invoked, across all indexed sessions. Pure DB reads — the
 * declared side was persisted at index time (toolsets registry), the called
 * side is each session's tool histogram.
 */
export function fleetToolTax(store: Store, prices: PriceTable) {
  const rows = store.listToolsetUsage();

  interface ToolAgg {
    name: string;
    approxTokens: number;
    declaredSessions: Set<string>;
    calledSessions: Set<string>;
    callsBySession: Map<string, number>;
    cumulativeTokens: number;
    deadTokensCumulative: number;
    deadCostUsd: number;
    pricedDeadRows: number;
    deadRows: number;
  }
  const perTool = new Map<string, ToolAgg>();

  interface SessionAgg {
    sessionId: string;
    agent: string;
    model: string;
    projectCwd: string;
    requestCount: number;
    declaredCount: number;
    calledCount: number;
    deadCount: number;
    deadTokensPerRequest: number;
    deadTokensCumulative: number;
    cumulativeToolTokens: number;
    deadCostUsd: number | null;
    /** Requests behind the declared/dead counts (largest toolset row wins). */
    dominantRequests: number;
  }
  const perSession = new Map<string, SessionAgg>();

  let cumulativeToolTokens = 0;
  let deadTokensCumulative = 0;
  let deadCostUsd = 0;
  let pricedRows = 0;
  // Rows with real dead tokens but no price entry: their dollars are missing
  // from deadCostUsd, so the total must say so (same contract as
  // fleetAnalytics' hasUnpriced → fmtCost's "+" suffix).
  let unpricedDeadRows = 0;

  for (const row of rows) {
    const tax = taxForUsageRow(row, prices);
    const rowToolTokens = row.perTool.reduce((a, t) => a + t.approxTokens, 0) * row.requestCount;
    cumulativeToolTokens += rowToolTokens;
    deadTokensCumulative += tax.deadTokensCumulative;
    if (tax.deadCostUsd != null) {
      deadCostUsd += tax.deadCostUsd;
      pricedRows++;
    } else if (tax.deadTokensCumulative > 0) {
      unpricedDeadRows++;
    }

    let s = perSession.get(row.sessionId);
    if (!s) {
      s = {
        sessionId: row.sessionId,
        agent: row.agent,
        model: row.model,
        projectCwd: row.projectCwd,
        requestCount: 0,
        declaredCount: 0,
        calledCount: 0,
        deadCount: 0,
        deadTokensPerRequest: 0,
        deadTokensCumulative: 0,
        cumulativeToolTokens: 0,
        deadCostUsd: null,
        dominantRequests: -1,
      };
      perSession.set(row.sessionId, s);
    }
    s.requestCount += row.requestCount;
    s.deadTokensCumulative += tax.deadTokensCumulative;
    s.cumulativeToolTokens += rowToolTokens;
    if (tax.deadCostUsd != null) s.deadCostUsd = (s.deadCostUsd ?? 0) + tax.deadCostUsd;
    // Counts and per-request figures come from the session's dominant toolset
    // (the one most of its requests declared) — summing them across variant
    // sets would double-count tools shared by every variant.
    if (row.requestCount > s.dominantRequests) {
      s.dominantRequests = row.requestCount;
      s.declaredCount = tax.declaredCount;
      s.calledCount = tax.calledCount;
      s.deadCount = tax.deadCount;
      s.deadTokensPerRequest = tax.deadTokensPerRequest;
    }

    for (const t of tax.tools) {
      let agg = perTool.get(t.name);
      if (!agg) {
        agg = {
          name: t.name,
          approxTokens: 0,
          declaredSessions: new Set(),
          calledSessions: new Set(),
          callsBySession: new Map(),
          cumulativeTokens: 0,
          deadTokensCumulative: 0,
          deadCostUsd: 0,
          pricedDeadRows: 0,
          deadRows: 0,
        };
        perTool.set(t.name, agg);
      }
      agg.approxTokens = Math.max(agg.approxTokens, t.approxTokens);
      agg.declaredSessions.add(row.sessionId);
      if (t.calls > 0) agg.calledSessions.add(row.sessionId);
      // Histogram counts are session-wide; keep one figure per session so a
      // session with several toolset variants doesn't double-count calls.
      agg.callsBySession.set(row.sessionId, t.calls);
      agg.cumulativeTokens += t.cumulativeTokens;
      if (t.dead) {
        agg.deadTokensCumulative += t.cumulativeTokens;
        agg.deadRows++;
        const price = row.model ? priceFor(row.model, prices) : null;
        if (price) {
          agg.deadCostUsd += (t.cumulativeTokens * price.cacheRead) / 1_000_000;
          agg.pricedDeadRows++;
        }
      }
    }
  }

  const tools = [...perTool.values()]
    .map((a) => ({
      name: a.name,
      approxTokens: a.approxTokens,
      sessionsDeclared: a.declaredSessions.size,
      sessionsCalled: a.calledSessions.size,
      calls: [...a.callsBySession.values()].reduce((x, y) => x + y, 0),
      cumulativeTokens: a.cumulativeTokens,
      deadTokensCumulative: a.deadTokensCumulative,
      deadCostUsd: a.pricedDeadRows > 0 ? a.deadCostUsd : null,
      hasUnpriced: a.deadRows > a.pricedDeadRows,
    }))
    .sort((a, b) => b.deadTokensCumulative - a.deadTokensCumulative);

  const sessions = [...perSession.values()]
    .map(({ dominantRequests: _d, ...s }) => s)
    .sort((a, b) => b.deadTokensCumulative - a.deadTokensCumulative);

  return {
    totals: {
      sessions: sessions.length,
      tools: tools.length,
      cumulativeToolTokens,
      deadTokensCumulative,
      deadShare: cumulativeToolTokens > 0 ? deadTokensCumulative / cumulativeToolTokens : 0,
      deadCostUsd: pricedRows > 0 ? deadCostUsd : null,
      hasUnpriced: unpricedDeadRows > 0,
    },
    tools,
    sessions,
  };
}

/** Cached context timelines for the current index state (see timelineFor). */
const timelineMemo = new Map<string, ContextTimeline>();
let timelineMemoSig = "";

/**
 * A session's context timeline, memoized until the index changes.
 *
 * Normally this is a cheap read of composition recorded at index time. It falls
 * back to reading and segmenting request bodies for any call the index run
 * could not segment, and that fallback is what the memo protects: it is linear
 * in the session's wire traffic and would otherwise be repaid on every visit.
 *
 * Invalidated on the same db+WAL mtime signal the SSE poller already uses, so a
 * re-index refreshes the dashboard and this cache together.
 */
function timelineFor(store: Store, sessionId: string): ContextTimeline {
  const sig = dbMtimeSignature(store.dbPath);
  if (sig !== timelineMemoSig) {
    timelineMemo.clear(); // only the latest index state is worth caching
    timelineMemoSig = sig;
  }
  const hit = timelineMemo.get(sessionId);
  if (hit) return hit;
  const timeline = store.sessionContextTimeline(sessionId);
  timelineMemo.set(sessionId, timeline);
  return timeline;
}

/**
 * Node detail is the bulk of the flow payload — full message text on every one
 * of what can be hundreds of nodes, inlined into DOM attributes by the frontend.
 * Send a preview and let the detail pane fetch the rest for the one node the
 * user actually clicked.
 */
export const FLOW_DETAIL_PREVIEW_CHARS = 400;

export function trimFlowDetail(flow: FlowGraph): FlowGraph {
  return {
    ...flow,
    nodes: flow.nodes.map((n) => {
      const raw = n.detail == null ? "" : JSON.stringify(n.detail);
      if (raw.length <= FLOW_DETAIL_PREVIEW_CHARS) return n;
      // Drop `detail` entirely rather than blanking it: the frontend keys off
      // its presence to decide whether it must fetch.
      const { detail: _elided, ...rest } = n;
      return {
        ...rest,
        detailPreview: raw.slice(0, FLOW_DETAIL_PREVIEW_CHARS),
        detailChars: raw.length,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

/**
 * Evaluate one pane's data source in isolation.
 *
 * The session endpoint feeds four independent panes. Without this, a throw in
 * any single section (a malformed hook row, a flow graph cycle) returns a 500
 * and every pane goes blank — including the ones that never needed that data.
 * On failure the section is `null`, which the frontend already treats as its
 * empty state, and the reason is reported under `sectionErrors`.
 */
function paneSection<T>(
  errors: Record<string, string>,
  label: string,
  load: () => T,
): T | null {
  try {
    return load();
  } catch (err) {
    errors[label] = err instanceof Error ? err.message : String(err);
    return null;
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function firstParam(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Parse the `since` / `until` / `agent` scope shared by `/api/usage` and
 * `/api/analytics`. One parser means the merged analytics pane can send one
 * control set to both endpoints and get back two views of the SAME slice —
 * anything else and the page's filters would silently govern only half of it.
 * Returns `{ error }` (→ 400) instead of throwing on an unparseable date.
 */
function parseScope(q: URLSearchParams): { filters: AnalyticsFilters } | { error: string } {
  const filters: AnalyticsFilters = {};
  const since = firstParam(q.get("since") ?? undefined);
  const until = firstParam(q.get("until") ?? undefined);
  const agent = firstParam(q.get("agent") ?? undefined);
  try {
    if (since) filters.since = parseWhen(since);
    if (until) filters.until = parseWhen(until, { endOfDay: true });
  } catch (err) {
    return { error: (err as Error).message };
  }
  if (agent) filters.agent = agent;
  return { filters };
}

// SSE: notify connected dashboards when the index database changes on disk.
// Polling the file mtimes (db + WAL) is the simplest reliable signal — fs.watch
// misses WAL checkpoint writes on some platforms.
const SSE_POLL_MS = 1500;

function dbMtimeSignature(dbPath: string): string {
  let sig = "";
  for (const p of [dbPath, dbPath + "-wal"]) {
    try {
      const st = fs.statSync(p);
      sig += `${st.mtimeMs}:${st.size};`;
    } catch {
      sig += "x;";
    }
  }
  return sig;
}

function handleEvents(store: Store, res: http.ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write("retry: 2000\n\n");
  res.write(`event: hello\ndata: {"db":${JSON.stringify(store.dbPath)}}\n\n`);

  let last = dbMtimeSignature(store.dbPath);
  const timer = setInterval(() => {
    const sig = dbMtimeSignature(store.dbPath);
    if (sig !== last) {
      last = sig;
      res.write(`event: change\ndata: {"at":${Date.now()}}\n\n`);
    } else {
      res.write(": ping\n\n");
    }
  }, SSE_POLL_MS);
  res.on("close", () => clearInterval(timer));
}

/**
 * Route a single request against the store. Exported so tests can drive the
 * handler without binding a socket; {@link runServe} wraps it in an http server.
 */
export async function handleRequest(
  store: Store,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url || "/", "http://localhost");
  } catch {
    sendText(res, 400, "Bad request URL");
    return;
  }
  const pathname = url.pathname;
  const q = url.searchParams;

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(res, 405, "Method Not Allowed — this dashboard is read-only.");
    return;
  }

  try {
    if (pathname === "/" || pathname === "/index.html") {
      sendHtml(res, 200, composePage());
      return;
    }

    if (pathname === "/api/meta") {
      const counts = {
        sessions: (store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as any).n,
        requests: (store.db.prepare("SELECT COUNT(*) AS n FROM requests").get() as any).n,
        prompts: (store.db.prepare("SELECT COUNT(*) AS n FROM prompts").get() as any).n,
        events: (store.db.prepare("SELECT COUNT(*) AS n FROM usage_events").get() as any).n,
      };
      const { source } = await getPrices();
      sendJson(res, 200, {
        dbPath: store.dbPath,
        counts,
        priceSource: source,
        build: buildFreshness(),
      });
      return;
    }

    if (pathname === "/api/sessions") {
      const filters: SessionListFilters = {};
      const agent = firstParam(q.get("agent") ?? undefined);
      const model = firstParam(q.get("model") ?? undefined);
      const project = firstParam(q.get("project") ?? undefined);
      const tool = firstParam(q.get("tool") ?? undefined);
      const sort = firstParam(q.get("sort") ?? undefined);
      const order = firstParam(q.get("order") ?? undefined);
      const limit = firstParam(q.get("limit") ?? undefined);
      const since = firstParam(q.get("since") ?? undefined);
      const until = firstParam(q.get("until") ?? undefined);
      if (agent) filters.agent = agent;
      if (model) filters.model = model;
      if (project) filters.project = project;
      if (tool) filters.tool = tool;
      if (q.get("errored") === "1" || q.get("errored") === "true") filters.errored = true;
      if (sort) filters.sort = sort;
      if (order === "asc" || order === "desc") filters.order = order;
      if (limit && Number.isFinite(Number(limit))) filters.limit = Number(limit);
      if (since && Number.isFinite(Number(since))) filters.since = Number(since);
      if (until && Number.isFinite(Number(until))) filters.until = Number(until);
      const sessions = store.listSessions(filters);
      sendJson(res, 200, { count: sessions.length, sessions });
      return;
    }

    if (pathname === "/api/search") {
      const query = (q.get("q") ?? "").trim();
      if (!query) {
        sendJson(res, 200, { query: "", count: 0, hits: [] });
        return;
      }
      const filters: SearchFilters = {};
      const tool = q.get("tool");
      const model = q.get("model");
      const agent = q.get("agent");
      const project = q.get("project");
      const limit = q.get("limit");
      if (q.get("errored") === "1" || q.get("errored") === "true") filters.errored = true;
      if (tool) filters.tool = tool;
      if (model) filters.model = model;
      if (agent) filters.agent = agent;
      if (project) filters.project = project;
      if (limit && Number.isFinite(Number(limit))) {
        filters.limit = Math.max(1, Math.floor(Number(limit)));
      }
      const hits = store.search(query, filters);
      sendJson(res, 200, { query, count: hits.length, hits });
      return;
    }

    if (pathname.startsWith("/api/session/")) {
      // /api/session/<id>/context/<seq>
      const rest = decodeURIComponent(pathname.slice("/api/session/".length));
      const contextMatch = rest.match(/^(.*)\/context\/(\d+)$/);
      if (contextMatch) {
        const sessionId = contextMatch[1];
        const seq = Number(contextMatch[2]);
        const session = store.getSession(sessionId);
        if (!session) {
          sendJson(res, 404, { error: `No indexed session '${sessionId}'.` });
          return;
        }
        const xray = store.sessionContextXray(sessionId, seq);
        if (!xray) {
          sendJson(res, 404, { error: `No request body for session '${sessionId}' seq ${seq}.` });
          return;
        }
        sendJson(res, 200, xray);
        return;
      }

      // /api/session/<id>/timeline — fetched when the X-Ray pane opens, not on
      // every session load, so an un-precomputed session cannot stall the page.
      const timelineMatch = rest.match(/^(.*)\/timeline$/);
      if (timelineMatch) {
        const sessionId = timelineMatch[1];
        const session = store.getSession(sessionId);
        if (!session) {
          sendJson(res, 404, { error: `No indexed session '${sessionId}'.` });
          return;
        }
        sendJson(res, 200, timelineFor(store, sessionId));
        return;
      }

      // /api/session/<id>/tools — dead-tool-tax for one session: declared
      // toolsets (from the registry) crossed with the session's call histogram.
      const toolsMatch = rest.match(/^(.*)\/tools$/);
      if (toolsMatch) {
        const sessionId = toolsMatch[1];
        const session = store.getSession(sessionId);
        if (!session) {
          sendJson(res, 404, { error: `No indexed session '${sessionId}'.` });
          return;
        }
        const { prices, source } = await getPrices();
        const toolsets = store
          .listToolsetUsage(sessionId)
          .map((row) => taxForUsageRow(row, prices));
        sendJson(res, 200, { sessionId, toolsets, priceSource: source });
        return;
      }

      // /api/session/<id>/flow/<nodeId> — full detail for one node, since the
      // graph payload only carries previews.
      const flowMatch = rest.match(/^(.*)\/flow\/(.+)$/);
      if (flowMatch) {
        const sessionId = flowMatch[1];
        const nodeId = flowMatch[2];
        const session = store.getSession(sessionId);
        if (!session) {
          sendJson(res, 404, { error: `No indexed session '${sessionId}'.` });
          return;
        }
        const node = store.sessionFlow(sessionId).nodes.find((n) => n.id === nodeId);
        if (!node) {
          sendJson(res, 404, { error: `No flow node '${nodeId}' in session '${sessionId}'.` });
          return;
        }
        sendJson(res, 200, { id: node.id, kind: node.kind, label: node.label, detail: node.detail ?? null });
        return;
      }

      const sessionId = rest;
      const session = store.getSession(sessionId);
      if (!session) {
        sendJson(res, 404, { error: `No indexed session '${sessionId}'.` });
        return;
      }
      const steps = store.listSteps(sessionId);
      const requests = store.listRequests(sessionId);
      // Each of these backs exactly one pane. Isolate them: a throw in any one
      // degrades its own pane instead of 500-ing the endpoint and darkening all
      // four — Wire in particular needs none of them.
      const sectionErrors: Record<string, string> = {};
      const hooks = paneSection(sectionErrors, "hooks", () =>
        store.listHooksForSession(sessionId),
      );
      const flow = paneSection(sectionErrors, "flow", () =>
        trimFlowDetail(store.sessionFlow(sessionId)),
      );
      // contextTimeline is NOT here: it moved to /api/session/<id>/timeline so
      // the four panes render without waiting on it.
      sendJson(res, 200, {
        session,
        steps,
        requests,
        hooks,
        flow,
        // Compactions come in two provenances and the page says which. The
        // recorded set is Claude Code's own `compact_boundary` records, which
        // carry the trigger (auto vs /compact) and exact pre/post sizes; the
        // inferred set is our wire-side guess, kept as the fallback for agents
        // and captures that have no transcript. Never merged — a measurement
        // and a guess that disagree is information, and averaging them away
        // would be the worst of both.
        compactions: findCompactions(requests),
        recordedCompactions: paneSection(sectionErrors, "recordedCompactions", () =>
          store.recordedCompactions(sessionId),
        ),
        siblings: paneSection(sectionErrors, "siblings", () =>
          store.sessionsFromSameSource(sessionId),
        ),
        reportAvailable: fs.existsSync(reportPathFor(session.sourcePath)),
        ...(Object.keys(sectionErrors).length ? { sectionErrors } : {}),
      });
      return;
    }

    if (pathname === "/api/usage") {
      const g = firstParam(q.get("granularity") ?? undefined) ?? "daily";
      const granularity: Granularity =
        g === "weekly" || g === "monthly" || g === "total" ? g : "daily";
      const scope = parseScope(q);
      if ("error" in scope) {
        sendJson(res, 400, { error: scope.error });
        return;
      }
      const filters: { since?: number; until?: number; agent?: string; model?: string; project?: string } = {
        ...scope.filters,
      };
      const model = firstParam(q.get("model") ?? undefined);
      const project = firstParam(q.get("project") ?? undefined);
      if (model) filters.model = model;
      if (project) filters.project = project;
      const breakdown = q.get("breakdown") === "1" || q.get("breakdown") === "true";
      const timeZone = firstParam(q.get("timezone") ?? undefined);

      const { prices, source } = await getPrices();
      const events = store.listUsageEvents(filters);
      const report = aggregateUsage(events, { granularity, breakdown, timeZone, prices });
      report.priceSource = source;
      sendJson(res, 200, report);
      return;
    }

    if (pathname === "/api/analytics") {
      const scope = parseScope(q);
      if ("error" in scope) {
        sendJson(res, 400, { error: scope.error });
        return;
      }
      const { prices, source } = await getPrices();
      sendJson(res, 200, { ...fleetAnalytics(store, prices, scope.filters), priceSource: source });
      return;
    }

    if (pathname === "/api/tooltax") {
      const { prices, source } = await getPrices();
      sendJson(res, 200, { ...fleetToolTax(store, prices), priceSource: source });
      return;
    }

    if (pathname === "/api/prompts") {
      const agent = firstParam(q.get("agent") ?? undefined);
      const prompts = store.listPrompts(agent ? { agent } : {});
      sendJson(res, 200, { count: prompts.length, prompts });
      return;
    }

    if (pathname.startsWith("/api/prompt/")) {
      const hash = decodeURIComponent(pathname.slice("/api/prompt/".length));
      const prompt = store.getPrompt(hash);
      if (!prompt) {
        sendJson(res, 404, { error: `No prompt '${hash}'.` });
        return;
      }
      sendJson(res, 200, prompt);
      return;
    }

    if (pathname === "/api/audit") {
      const mode = q.get("mode") === "strict" ? "strict" : "standard";
      sendJson(res, 200, await auditIndexedFiles(store, mode));
      return;
    }

    if (pathname === "/api/events") {
      handleEvents(store, res);
      return;
    }

    if (pathname === "/report" || pathname.startsWith("/session/")) {
      const sessionId =
        pathname === "/report"
          ? firstParam(q.get("session") ?? undefined)
          : decodeURIComponent(pathname.slice("/session/".length));
      if (!sessionId) {
        sendText(res, 400, "Missing session id. Use /report?session=<id>.");
        return;
      }
      const session = store.getSession(sessionId);
      if (!session) {
        sendText(res, 404, `No indexed session '${sessionId}'.`);
        return;
      }
      const reportPath = reportPathFor(session.sourcePath);
      let size: number;
      try {
        size = fs.statSync(reportPath).size;
      } catch {
        sendText(
          res,
          404,
          `No HTML report found for session '${sessionId}'.\n` +
            `Expected it next to the source log at:\n  ${reportPath}\n` +
            `Re-run the trace (or --generate-html on the .jsonl) to create it.`,
        );
        return;
      }
      // Reports embed the whole wire log — stream, don't buffer.
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": size,
      });
      const stream = fs.createReadStream(reportPath);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
      return;
    }

    sendText(res, 404, "Not found.");
  } catch (err) {
    if (!res.headersSent) {
      sendText(res, 500, `Internal error: ${(err as Error).message}`);
    } else {
      res.end();
    }
  }
}

/** Entry point for `tracetap serve`. */
/** True when the request came from this machine over the loopback interface. */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("127.")
  );
}

/**
 * Re-exec the server so it picks up a newer build.
 *
 * The page reloads its own assets from disk on every request, so a browser
 * refresh always shows current HTML/CSS/JS — but compiled server code is frozen
 * at process start and CANNOT be reloaded in place. That asymmetry is what the
 * stale badge reports, and until now the badge was the end of the road: it told
 * you to act and gave you nothing to act with, so the reasonable response
 * ("refresh the page") could never work.
 *
 * Guards, in order:
 *  - POST only. Restarting is state-changing, and a GET would let any page that
 *    embeds an <img> pointed at this URL bounce the process.
 *  - Loopback only. `--host 0.0.0.0` is supported, and a restart reachable from
 *    the network is a denial-of-service primitive.
 *  - Stale only. This is an UPGRADE button, not a general restart: with nothing
 *    new on disk it answers 409 rather than pointlessly bouncing.
 *
 * The listener is closed before the replacement is spawned, so the child never
 * races the parent for the port. Open connections are dropped explicitly —
 * `server.close()` alone waits for them, and the SSE stream never ends.
 */
function handleRestart(
  server: http.Server,
  store: Store,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    sendJson(res, 405, { error: "Restart requires POST." });
    return;
  }
  if (!isLoopbackAddress(req.socket.remoteAddress ?? undefined)) {
    sendJson(res, 403, { error: "Restart is available only from this machine." });
    return;
  }
  const fresh = buildFreshness();
  if (!fresh.stale) {
    sendJson(res, 409, {
      error: "Already running the newest build on disk.",
      ...fresh,
    });
    return;
  }

  sendJson(res, 202, { restarting: true, ...fresh });

  const relaunch = () => {
    try {
      store.close();
    } catch {
      /* closing a store we are abandoning anyway */
    }
    const child = spawn(process.execPath, process.argv.slice(1), {
      cwd: process.cwd(),
      detached: true,
      stdio: "inherit",
    });
    child.unref();
    process.exit(0);
  };

  // Give the 202 a moment to flush, then stop accepting, drop what is open
  // (the SSE stream would otherwise hold `close` forever), and hand over.
  setTimeout(() => {
    server.close(relaunch);
    (server as any).closeAllConnections?.();
    // Belt and braces: if `close` never fires, hand over anyway rather than
    // leaving the user with a server that answered 202 and then did nothing.
    setTimeout(relaunch, 1500).unref?.();
  }, 100).unref?.();
}

export async function runServe(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(SERVE_HELP);
    return;
  }

  const opts = parseServeArgs(argv);
  const store = new Store(opts.dbPath);

  const server = http.createServer((req, res) => {
    // Handled here rather than in `handleRequest` because it needs the server
    // and the process, which the pure request handler deliberately does not.
    if ((req.url || "").split("?")[0] === "/api/restart") {
      handleRestart(server, store, req, res);
      return;
    }
    void handleRequest(store, req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      const addr = server.address() as AddressInfo;
      const host = opts.host === "0.0.0.0" || opts.host === "::" ? "localhost" : opts.host;
      console.log(`tracetap serve → http://${host}:${addr.port}  (db: ${store.dbPath})`);
      // Printed so a scrollback line can settle "is my fix in this process?"
      // without inferring it from `ls -l dist` and `ps -o lstart`.
      console.log(`build ${new Date(LOADED_BUILD_STAMP).toISOString()}`);
      console.log(`Press Ctrl+C to stop.`);
      resolve();
    });
  });

  /**
   * Stop accepting, drop what is open, exit.
   *
   * `server.close()` alone WAITS for in-flight connections, and `/api/events`
   * is a Server-Sent Events stream that by design never ends — so a page left
   * open in a browser made Ctrl+C and `kill` hang forever. The symptom is
   * silent: the signal is delivered, the process ignores it, and you accumulate
   * servers that survive every `pkill` and quietly hold their port. Eight of
   * them piled up in one session before the cause was found.
   *
   * The exit is forced after a grace period so a stuck socket cannot outvote a
   * shutdown request. Same reasoning as `handleRestart`, which hit this first.
   */
  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
    (server as any).closeAllConnections?.();
    setTimeout(() => process.exit(0), 2000).unref?.();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
