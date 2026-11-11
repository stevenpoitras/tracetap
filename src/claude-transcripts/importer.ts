import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import type { RawPair } from "../types";
import { eachLineWithHash } from "../jsonl";

/**
 * Claude Code local-transcript importer.
 *
 * Claude Code persists every session it runs — terminal, IDE, SDK and, most
 * usefully, the Claude desktop app, which `tracetap claude` cannot wrap — as an
 * append-only JSONL transcript under
 * `~/.claude/projects/<project-slug>/<session-uuid>.jsonl`, with subagents in
 * `<session-uuid>/subagents/agent-<id>.jsonl` (+ `agent-<id>.meta.json`).
 *
 * This module reads those files STRICTLY READ-ONLY and synthesizes canonical
 * {@link RawPair}s — one per Anthropic API response — so the same pipeline the
 * live tracers feed (trajectory → store → serve/search/usage) covers sessions
 * that were never proxied. The synthetic wire is recognized by the
 * `provider: "claude-transcript"` marker (see
 * {@link import("../trajectory/claude-transcript").ClaudeTranscriptAdapter}).
 *
 * The format is internal to Claude Code and undocumented, so everything here
 * is tolerant: malformed lines (including a half-written last line of a
 * session that is still running) and unknown record types are skipped.
 *
 * Shape of the synthetic wire (one pair per API response):
 *
 *   request.headers = { "x-claude-code-session-id": <session uuid> }
 *   request.body    = { provider, session_id, agent_id?, model, meta,
 *                       anchor?,   // last item of the previous response
 *                       delta[] }  // user prompts / tool results since then
 *   response.body   = { provider, id, model, content[], stop_reason, usage|null }
 *
 * Unlike the Devin importer the request carries only the DELTA since the
 * previous response, not the cumulative transcript: real sessions run to
 * thousands of calls and tens of MB, and a resent transcript would make the
 * output quadratic. The `anchor` lets the shared walker recognise which user
 * messages are new (see UserMessageTracker in trajectory/index.ts).
 *
 * Usage accounting:
 *   - Claude Code writes ONE record per content block, each repeating the
 *     response's `message.id` and `usage`, so usage is taken once per id
 *     (the record with the highest output_tokens, i.e. the final count).
 *   - A resumed/continued session's file starts with a COPY of the earlier
 *     session's records (still stamped with the earlier `sessionId`), and its
 *     `subagents/` dir can hold copies of the earlier session's subagent files.
 *     Those records belong to the other transcript and are skipped when that
 *     transcript exists, so a response is counted in exactly one file.
 *   - `<synthetic>` (client-side error placeholders) carry no billable usage.
 */

export const TRANSCRIPT_PROVIDER = "claude-transcript";
export const TRANSCRIPT_TRACE_DIR = ".claude-transcripts-trace";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TranscriptFileRef {
  /** Session uuid (the transcript's basename). */
  sessionId: string;
  /** `~/.claude/projects/<slug>` directory name. */
  projectSlug: string;
  path: string;
  size: number;
  mtimeMs: number;
  subagents: SubagentFileRef[];
}

export interface SubagentFileRef {
  agentId: string;
  path: string;
  metaPath: string | null;
  size: number;
  mtimeMs: number;
}

/** Session-level metadata, carried on every synthetic pair as `body.meta`. */
export interface TranscriptMeta {
  sessionId: string;
  projectSlug: string;
  cwd: string;
  gitBranch: string;
  /** `claude-desktop` / `cli` / `sdk-cli` / `claude-vscode` / … */
  entrypoint: string;
  version: string;
  title: string;
  /** Set on a subagent group's pairs only. */
  subagent?: { agentId: string; agentType: string | null; description: string | null };
}

export interface ImportedTranscript {
  ref: TranscriptFileRef;
  meta: TranscriptMeta;
  pairs: RawPair[];
  /** API responses (main + subagents) on this transcript's own records. */
  responses: number;
  /** Responses whose usage was counted (deduped, own records, non-synthetic). */
  countedResponses: number;
  /** Lines that failed to parse (malformed or half-written). */
  badLines: number;
  model: string;
  startedAt: number;
  endedAt: number;
  /** Hook summaries recovered from the transcript (see `body.hooks`). */
  hooks: number;
  /** Response ids whose usage this import counted (input to cross-file ownership). */
  countedIds: string[];
}

/** A hook fire recovered from the transcript, carried on `request.body.hooks`. */
export interface TranscriptHook {
  ts: number;
  event: string;
  hookName: string;
  durationMs: number | null;
  exitCode: number | null;
  outcome: "ok" | "error" | "blocked";
  toolUseId: string | null;
  /** Lengths only — hook output can carry anything, so its text is never copied. */
  stdoutChars: number;
  stderrChars: number;
  additionalContextChars: number;
  hookCount?: number;
}

// ---------------------------------------------------------------------------
// Paths / discovery
// ---------------------------------------------------------------------------

/** `$CLAUDE_CONFIG_DIR/projects` when set, else `~/.claude/projects`. */
export function defaultClaudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(base, "projects");
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Every `<slug>/<uuid>.jsonl` under `root`, newest first. Read-only (readdir/stat). */
export function listTranscripts(root: string = defaultClaudeProjectsDir()): TranscriptFileRef[] {
  const out: TranscriptFileRef[] = [];
  let projects: fs.Dirent[];
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const pd = path.join(root, p.name);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(pd, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      const sessionId = e.name.slice(0, -".jsonl".length);
      if (!UUID_RE.test(sessionId)) continue;
      const fp = path.join(pd, e.name);
      let st: fs.Stats;
      try {
        st = fs.statSync(fp);
      } catch {
        continue;
      }
      out.push({
        sessionId,
        projectSlug: p.name,
        path: fp,
        size: st.size,
        mtimeMs: st.mtimeMs,
        subagents: listSubagents(path.join(pd, sessionId, "subagents")),
      });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.sessionId.localeCompare(b.sessionId));
  return out;
}

function listSubagents(dir: string): SubagentFileRef[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: SubagentFileRef[] = [];
  for (const n of names.sort()) {
    if (!n.endsWith(".jsonl")) continue;
    const base = n.slice(0, -".jsonl".length);
    const fp = path.join(dir, n);
    let st: fs.Stats;
    try {
      st = fs.statSync(fp);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    const metaPath = path.join(dir, `${base}.meta.json`);
    out.push({
      agentId: base.replace(/^agent-/, ""),
      path: fp,
      metaPath: fs.existsSync(metaPath) ? metaPath : null,
      size: st.size,
      mtimeMs: st.mtimeMs,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Record parsing
// ---------------------------------------------------------------------------

/** Record types that carry anything this importer uses; the rest are dropped at parse. */
const KEEP_TYPES = new Set([
  "user",
  "assistant",
  "system",
  "attachment",
  "custom-title",
  "ai-title",
  "agent-name",
]);

type Rec = Record<string, any>;

function readRecords(file: string): { records: Rec[]; badLines: number } {
  const records: Rec[] = [];
  let badLines = 0;
  // A plain read-only fd, streamed line by line: nothing under ~/.claude is
  // written, renamed or locked. A half-written last line (a session still
  // running) fails to parse, is counted as bad, and is picked up next import.
  eachLineWithHash(file, (raw) => {
    const line = raw.trim();
    if (!line) return;
    let r: unknown;
    try {
      r = JSON.parse(line);
    } catch {
      badLines++;
      return;
    }
    if (r && typeof r === "object" && KEEP_TYPES.has(String((r as Rec).type))) records.push(r as Rec);
  });
  return { records, badLines };
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

interface OpenResponse {
  id: string;
  model: string;
  blocks: any[];
  usage: any | null;
  stopReason: string | undefined;
  status: number;
  firstTs: number;
  lastTs: number;
  reqTs: number;
  delta: DeltaItem[];
  anchor: AnchorItem | null;
  hooks: TranscriptHook[];
  counted: boolean;
}

type DeltaItem =
  | { kind: "user"; text: string }
  | { kind: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

type AnchorItem =
  | { kind: "tool_call"; id: string; name: string }
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string };

interface GroupContext {
  sessionId: string;
  agentId: string | null;
  meta: TranscriptMeta;
  /** True when a record's `sessionId` names another transcript that exists. */
  isForeign: (rec: Rec) => boolean;
  /**
   * Response ids already billed — shared across a transcript's groups, so a
   * response that appears in both the main file and a subagent file (fork
   * context) is counted once.
   */
  countedIds: Set<string>;
  /** Response ids another transcript owns (see `ImportOptions.skipUsageIds`). */
  skipUsageIds: Set<string>;
}

interface GroupResult {
  pairs: RawPair[];
  responses: number;
  counted: number;
  hooks: number;
  models: Map<string, number>;
  minTs: number;
  maxTs: number;
}

/**
 * Turn one transcript file's records (main thread or one subagent) into
 * synthetic pairs, one per API response, in file order.
 */
function synthesizeGroup(records: Rec[], ctx: GroupContext): GroupResult {
  const pairs: RawPair[] = [];
  const models = new Map<string, number>();
  const countedIds = ctx.countedIds;
  let pending: DeltaItem[] = [];
  let pendingHooks: TranscriptHook[] = [];
  let pendingTs = 0;
  let current: OpenResponse | null = null;
  let lastAnchor: AnchorItem | null = null;
  let responses = 0;
  let counted = 0;
  let hooks = 0;
  let minTs = Infinity;
  let maxTs = -Infinity;

  const seeTs = (ts: number) => {
    if (ts > 0) {
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }
  };

  const seenIds = new Set<string>();
  // Response bodies already emitted that carry an id's (counted) usage.
  const emittedUsage = new Map<string, any>();
  const bumpEmitted = (id: string, usage: unknown) => {
    const body = emittedUsage.get(id);
    if (body) body.usage = betterUsage(body.usage, usage);
  };

  const flush = () => {
    if (!current) return;
    const pair = toPair(current, ctx);
    pairs.push(pair);
    if (current.counted && current.id) emittedUsage.set(current.id, pair.response!.body);
    lastAnchor = anchorOf(current.blocks) ?? lastAnchor;
    current = null;
  };

  for (const rec of records) {
    if (ctx.isForeign(rec)) continue;
    const ts = isoToSec(rec.timestamp);
    const type = rec.type;

    if (type === "assistant") {
      const msg = rec.message;
      if (!msg || typeof msg !== "object") continue;
      seeTs(ts);
      const id = String(msg.id ?? rec.requestId ?? rec.uuid ?? "");
      const blocks = Array.isArray(msg.content) ? msg.content : typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : [];
      const model = typeof msg.model === "string" ? msg.model : "";
      const synthetic = model === "<synthetic>" || rec.isApiErrorMessage === true;
      if (current && current.id === id && id) {
        current.blocks.push(...blocks);
        current.lastTs = ts || current.lastTs;
        if (typeof msg.stop_reason === "string") current.stopReason = msg.stop_reason;
        if (current.counted) current.usage = betterUsage(current.usage, msg.usage);
        else bumpEmitted(id, msg.usage);
        continue;
      }
      flush();
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        responses++;
      }
      // An id that resumes after a tool_result landed between its block
      // records (parallel tool calls) is a new pair for step order, but its
      // usage stays on the pair that already counted it — raised to the final
      // count if this record carries a higher one.
      bumpEmitted(id, msg.usage);
      const count: boolean =
        !synthetic && !!id && !countedIds.has(id) && !ctx.skipUsageIds.has(id) && isUsage(msg.usage);
      if (count) {
        countedIds.add(id);
        counted++;
      }
      if (model && !synthetic) models.set(model, (models.get(model) ?? 0) + 1);
      current = {
        id,
        model: synthetic ? "" : model,
        blocks: [...blocks],
        usage: count ? pickUsage(msg.usage) : null,
        stopReason: typeof msg.stop_reason === "string" ? msg.stop_reason : undefined,
        status: rec.isApiErrorMessage === true ? num(rec.apiErrorStatus) || 500 : 200,
        firstTs: ts,
        lastTs: ts,
        reqTs: pendingTs || ts,
        delta: pending,
        anchor: lastAnchor,
        hooks: pendingHooks,
        counted: count,
      };
      pending = [];
      pendingHooks = [];
      pendingTs = 0;
      continue;
    }

    if (type === "user") {
      const msg = rec.message;
      if (!msg || typeof msg !== "object") continue;
      seeTs(ts);
      const items = userItems(msg.content, rec);
      if (!items.length) continue;
      // A user record ends the open response: whatever it carries goes into the
      // NEXT request, exactly as on the wire.
      flush();
      pending.push(...items);
      pendingTs = ts || pendingTs;
      continue;
    }

    if (type === "system" && rec.subtype === "stop_hook_summary") {
      seeTs(ts);
      const infos: any[] = Array.isArray(rec.hookInfos) ? rec.hookInfos : [];
      const errors: any[] = Array.isArray(rec.hookErrors) ? rec.hookErrors : [];
      const addl: any[] = Array.isArray(rec.hookAdditionalContext) ? rec.hookAdditionalContext : [];
      const outcome = rec.preventedContinuation ? "blocked" : errors.length ? "error" : "ok";
      const list = infos.length ? infos : [{}];
      for (const info of list) {
        pendingHooks.push({
          ts,
          event: "Stop",
          hookName: hookLabel(info?.command),
          durationMs: typeof info?.durationMs === "number" ? info.durationMs : null,
          exitCode: null,
          outcome,
          toolUseId: typeof rec.toolUseID === "string" ? rec.toolUseID : null,
          stdoutChars: 0,
          stderrChars: errors.reduce((n, e) => n + strLen(e), 0),
          additionalContextChars: addl.reduce((n, e) => n + strLen(e), 0),
          hookCount: num(rec.hookCount) || undefined,
        });
        hooks++;
      }
      continue;
    }

    if (type === "attachment" && rec.attachment && typeof rec.attachment === "object") {
      const a = rec.attachment;
      const at = String(a.type ?? "");
      if (at !== "hook_success" && at !== "hook_additional_context" && at !== "hook_non_blocking_error") continue;
      seeTs(ts);
      pendingHooks.push({
        ts,
        event: String(a.hookEvent ?? "unknown"),
        hookName: hookLabel(a.hookName ?? a.command),
        durationMs: typeof a.durationMs === "number" ? a.durationMs : null,
        exitCode: typeof a.exitCode === "number" ? a.exitCode : null,
        outcome: at === "hook_non_blocking_error" ? "error" : "ok",
        toolUseId: typeof a.toolUseID === "string" ? a.toolUseID : null,
        stdoutChars: strLen(a.stdout),
        stderrChars: strLen(a.stderr),
        additionalContextChars: at === "hook_additional_context" ? strLen(a.content) : 0,
      });
      hooks++;
      continue;
    }
    // Everything else (custom-title, queue-operation, api-request*, …) carries
    // nothing for the step model and is skipped silently.
  }
  flush();

  // Trailing user prompts / tool results / hooks after the last response: one
  // final pair with an EMPTY response, so the walker still emits the trailing
  // user step and stitches the trailing results, without a phantom agent turn.
  if (pending.length || pendingHooks.length) {
    const t = pendingTs || (Number.isFinite(maxTs) ? maxTs : 0);
    pairs.push({
      request: {
        timestamp: t,
        method: "POST",
        url: transcriptUrl(ctx),
        headers: { "x-claude-code-session-id": ctx.sessionId },
        body: {
          provider: TRANSCRIPT_PROVIDER,
          session_id: ctx.sessionId,
          ...(ctx.agentId ? { agent_id: ctx.agentId } : {}),
          model: "",
          meta: ctx.meta,
          ...(lastAnchor ? { anchor: lastAnchor } : {}),
          delta: pending,
          ...(pendingHooks.length ? { hooks: pendingHooks } : {}),
        },
      },
      response: {
        timestamp: t,
        status_code: 200,
        headers: {},
        body: { provider: TRANSCRIPT_PROVIDER, trailing: true },
      },
      logged_at: secToIso(t),
    });
  }

  return { pairs, responses, counted, hooks, models, minTs, maxTs };
}

function toPair(r: OpenResponse, ctx: GroupContext): RawPair {
  return {
    request: {
      timestamp: r.reqTs,
      method: "POST",
      url: transcriptUrl(ctx),
      headers: { "x-claude-code-session-id": ctx.sessionId },
      body: {
        provider: TRANSCRIPT_PROVIDER,
        session_id: ctx.sessionId,
        ...(ctx.agentId ? { agent_id: ctx.agentId } : {}),
        model: r.model,
        meta: ctx.meta,
        ...(r.anchor ? { anchor: r.anchor } : {}),
        delta: r.delta,
        ...(r.hooks.length ? { hooks: r.hooks } : {}),
      },
    },
    response: {
      timestamp: r.lastTs || r.reqTs,
      status_code: r.status,
      headers: {},
      body: {
        provider: TRANSCRIPT_PROVIDER,
        id: r.id,
        model: r.model,
        content: r.blocks,
        stop_reason: r.stopReason,
        // null = present on the transcript but NOT billed here (a repeat of an
        // id already counted, or a synthetic error placeholder).
        usage: r.usage,
      },
    },
    logged_at: secToIso(r.lastTs || r.reqTs),
  };
}

function transcriptUrl(ctx: GroupContext): string {
  return `claude-transcript://session/${ctx.sessionId}${ctx.agentId ? `/agent/${ctx.agentId}` : ""}`;
}

/** The last flattened item of a response — what the next request is anchored on. */
function anchorOf(blocks: any[]): AnchorItem | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (!b || typeof b !== "object") continue;
    if (b.type === "tool_use" && b.id) return { kind: "tool_call", id: String(b.id), name: String(b.name ?? "tool") };
    if (b.type === "text" && b.text) return { kind: "text", text: String(b.text) };
    if ((b.type === "thinking" || b.type === "redacted_thinking") && (b.thinking || b.data)) {
      return { kind: "reasoning", text: String(b.thinking ?? b.data) };
    }
  }
  return null;
}

/** A user record's prompt text / tool results. Meta and compact-summary injections are not prompts. */
function userItems(content: unknown, rec: Rec): DeltaItem[] {
  const items: DeltaItem[] = [];
  if (typeof content === "string") {
    if (rec.isMeta || rec.isCompactSummary) return items;
    if (content.trim()) items.push({ kind: "user", text: content });
    return items;
  }
  if (!Array.isArray(content)) return items;
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "tool_result") {
      items.push({
        kind: "tool_result",
        tool_use_id: String(b.tool_use_id ?? ""),
        content: toolResultText(b.content),
        ...(b.is_error ? { is_error: true } : {}),
      });
    } else if (b.type === "text" && !rec.isMeta && !rec.isCompactSummary) {
      const t = String(b.text ?? "");
      if (t.trim()) items.push({ kind: "user", text: t });
    }
  }
  return items;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") {
          if (typeof (p as any).text === "string") return (p as any).text;
          if ((p as any).type === "image") return "[image]";
        }
        return JSON.stringify(p);
      })
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

function isUsage(u: unknown): boolean {
  return !!u && typeof u === "object";
}

function pickUsage(u: any): any {
  return {
    input_tokens: num(u?.input_tokens),
    output_tokens: num(u?.output_tokens),
    cache_creation_input_tokens: num(u?.cache_creation_input_tokens),
    cache_read_input_tokens: num(u?.cache_read_input_tokens),
  };
}

/**
 * Claude Code writes the response's usage on every content-block record; the
 * earlier records can carry a partial (streaming) output count. Keep the record
 * with the highest output count — the final one.
 */
function betterUsage(prev: any | null, next: unknown): any | null {
  if (!isUsage(next)) return prev;
  const n = pickUsage(next);
  if (!prev) return n;
  return n.output_tokens >= prev.output_tokens ? n : prev;
}

/** A short, content-free hook label: the script's basename, not its arguments. */
function hookLabel(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return "";
  // `hookName` is already a label like "PreToolUse:Bash"; a command line is
  // reduced to its script's basename so arguments never leak.
  if (!/\s/.test(s) && !s.includes("/")) return s.slice(0, 80);
  const tokens = s.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ""));
  let pick = tokens[0] ?? "";
  // `node /x/hook.js --flag` → `hook.js`, not `node`.
  if (INTERPRETERS.has(path.basename(pick)) && tokens[1] && !tokens[1].startsWith("-")) pick = tokens[1];
  return path.basename(pick).slice(0, 80);
}

const INTERPRETERS = new Set(["node", "bun", "deno", "python", "python3", "bash", "sh", "zsh", "npx", "ruby", "perl"]);

function strLen(v: unknown): number {
  if (typeof v === "string") return v.length;
  if (v == null) return 0;
  try {
    return JSON.stringify(v).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Session import
// ---------------------------------------------------------------------------

export interface ImportOptions {
  /**
   * Session uuids whose own transcript exists. Records stamped with one of
   * these (other than the file's own) are copies and are skipped. Defaults to
   * every transcript next to this one's project root.
   */
  knownSessions?: Set<string>;
  /** Map of session uuid -> its subagent file names, to detect copied subagent files. */
  knownSubagents?: Map<string, Set<string>>;
  /**
   * Response ids whose usage another transcript owns. Claude Code sometimes
   * re-stamps copied records with the NEW session's id (same record uuid and
   * timestamp), which the sessionId rule cannot see; the import run resolves
   * those across files (earliest transcript wins) and passes the losers here.
   */
  skipUsageIds?: Set<string>;
}

/**
 * Reconstruct one transcript (and its subagents) into synthetic pairs.
 * Returns null when the transcript holds no responses and no prompts.
 */
export function importTranscript(ref: TranscriptFileRef, opts: ImportOptions = {}): ImportedTranscript | null {
  const known = opts.knownSessions ?? new Set<string>([ref.sessionId]);
  const knownSubs = opts.knownSubagents ?? new Map<string, Set<string>>();
  const countedIds = new Set<string>();
  const skipUsageIds = opts.skipUsageIds ?? new Set<string>();
  const shared = { countedIds, skipUsageIds };
  const { records, badLines } = readRecords(ref.path);

  const meta = sessionMeta(ref, records);
  const owner = ref.sessionId;
  const isForeignFor = (fileOwner: string) => (rec: Rec) => {
    const sid = typeof rec.sessionId === "string" ? rec.sessionId : "";
    return !!sid && sid !== fileOwner && known.has(sid);
  };

  // Main thread. Inline sidechain records (older Claude Code versions wrote
  // subagent turns into the main file) are split into their own group.
  const mainRecs = records.filter((r) => !r.isSidechain);
  const sideRecs = records.filter((r) => r.isSidechain);
  const groups: GroupResult[] = [];
  groups.push(synthesizeGroup(mainRecs, { sessionId: owner, agentId: null, meta, isForeign: isForeignFor(owner), ...shared }));
  if (sideRecs.length) {
    const byAgent = new Map<string, Rec[]>();
    for (const r of sideRecs) {
      const k = typeof r.agentId === "string" && r.agentId ? r.agentId : "sidechain";
      let l = byAgent.get(k);
      if (!l) byAgent.set(k, (l = []));
      l.push(r);
    }
    for (const [agentId, recs] of byAgent) {
      groups.push(
        synthesizeGroup(recs, {
          sessionId: owner,
          agentId,
          meta: { ...meta, subagent: { agentId, agentType: null, description: null } },
          isForeign: isForeignFor(owner),
          ...shared,
        }),
      );
    }
  }

  let badTotal = badLines;
  for (const sub of ref.subagents) {
    const { records: srecs, badLines: sb } = readRecords(sub.path);
    badTotal += sb;
    // A copied subagent file: every record names another session whose own
    // subagents dir holds the same file. That copy is counted over there.
    const stamp = srecs.find((r) => typeof r.sessionId === "string")?.sessionId as string | undefined;
    if (stamp && stamp !== owner && knownSubs.get(stamp)?.has(path.basename(sub.path))) continue;
    const sm = readSubagentMeta(sub.metaPath);
    groups.push(
      synthesizeGroup(srecs, {
        sessionId: owner,
        agentId: sub.agentId,
        meta: { ...meta, subagent: { agentId: sub.agentId, agentType: sm.agentType, description: sm.description } },
        // Inside a subagent file the owner is still the parent session.
        isForeign: (rec) => {
          const sid = typeof rec.sessionId === "string" ? rec.sessionId : "";
          return !!sid && sid !== owner && sid !== stamp && known.has(sid);
        },
        ...shared,
      }),
    );
  }

  const pairs: RawPair[] = [];
  let responses = 0;
  let counted = 0;
  let hooks = 0;
  let minTs = Infinity;
  let maxTs = -Infinity;
  const models = new Map<string, number>();
  for (const g of groups) {
    pairs.push(...g.pairs);
    responses += g.responses;
    counted += g.counted;
    hooks += g.hooks;
    if (g.minTs < minTs) minTs = g.minTs;
    if (g.maxTs > maxTs) maxTs = g.maxTs;
    for (const [m, n] of g.models) models.set(m, (models.get(m) ?? 0) + n);
  }
  if (pairs.length === 0) return null;
  // Main-thread model wins the label; fall back to the overall dominant one.
  const model = dominant(groups[0].models) || dominant(models) || "unknown";
  // The main group's pairs carry `model` per response; a trailing pair has
  // none, so give it the session label for pricing/labeling.
  for (const p of pairs) if (!p.request.body.model) p.request.body.model = model;

  return {
    ref,
    meta,
    pairs,
    responses,
    countedResponses: counted,
    badLines: badTotal,
    model,
    startedAt: Number.isFinite(minTs) ? minTs : 0,
    endedAt: Number.isFinite(maxTs) ? maxTs : 0,
    hooks,
    countedIds: [...countedIds],
  };
}

function sessionMeta(ref: TranscriptFileRef, records: Rec[]): TranscriptMeta {
  let cwd = "";
  let gitBranch = "";
  let version = "";
  const entry = new Map<string, number>();
  let customTitle = "";
  let aiTitle = "";
  let agentName = "";
  for (const r of records) {
    if (r.type === "custom-title" && typeof r.customTitle === "string" && r.customTitle.trim()) customTitle = r.customTitle;
    else if (r.type === "ai-title" && typeof r.aiTitle === "string" && r.aiTitle.trim()) aiTitle = r.aiTitle;
    else if (r.type === "agent-name" && typeof r.agentName === "string" && r.agentName.trim()) agentName = r.agentName;
    if (r.sessionId && r.sessionId !== ref.sessionId) continue; // copied history
    if (r.isSidechain) continue;
    if (typeof r.cwd === "string" && r.cwd) cwd = r.cwd;
    if (typeof r.gitBranch === "string" && r.gitBranch) gitBranch = r.gitBranch;
    if (typeof r.version === "string" && r.version) version = r.version;
    if (typeof r.entrypoint === "string" && r.entrypoint) entry.set(r.entrypoint, (entry.get(r.entrypoint) ?? 0) + 1);
  }
  return {
    sessionId: ref.sessionId,
    projectSlug: ref.projectSlug,
    cwd,
    gitBranch,
    entrypoint: dominant(entry) || "unknown",
    version,
    title: (customTitle || aiTitle || agentName).trim().slice(0, 200),
  };
}

function readSubagentMeta(metaPath: string | null): { agentType: string | null; description: string | null } {
  if (!metaPath) return { agentType: null, description: null };
  try {
    const j = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    return {
      agentType: typeof j?.agentType === "string" ? j.agentType : null,
      description: typeof j?.description === "string" ? j.description.slice(0, 200) : null,
    };
  } catch {
    return { agentType: null, description: null };
  }
}

/** Ownership indexes for {@link importTranscript}, built from one listing. */
export function ownershipFor(
  refs: TranscriptFileRef[],
): Required<Pick<ImportOptions, "knownSessions" | "knownSubagents">> {
  const knownSessions = new Set(refs.map((r) => r.sessionId));
  const knownSubagents = new Map<string, Set<string>>();
  for (const r of refs) knownSubagents.set(r.sessionId, new Set(r.subagents.map((s) => path.basename(s.path))));
  return { knownSessions, knownSubagents };
}

/** Serialize pairs exactly as written to disk (deterministic: no import-time fields). */
export function serializePairs(pairs: RawPair[]): string {
  return pairs.map((p) => JSON.stringify(p)).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dominant(m: Map<string, number>): string {
  let best = "";
  let n = -1;
  for (const [k, v] of m) {
    if (v > n) {
      best = k;
      n = v;
    }
  }
  return best;
}

function isoToSec(iso: unknown): number {
  if (typeof iso !== "string" || !iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 1000 : 0;
}

function secToIso(sec: number): string {
  return sec > 0 ? new Date(Math.round(sec * 1000)).toISOString() : new Date(0).toISOString();
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
