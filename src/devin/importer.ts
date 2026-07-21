import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import type { RawPair } from "../types";

/**
 * Devin CLI (Cognition "chisel" agent) local-session importer.
 *
 * Devin is a Rust binary that talks to a proprietary cloud backend (Windsurf's
 * protobuf inference), so its LLM traffic never appears on the wire in a form a
 * base-URL proxy can capture — the default `tracetap <agent>` interception path
 * doesn't apply. But the CLI persists the FULL structured trajectory locally in
 * a SQLite database (`~/.local/share/devin/cli/sessions.db`), for every backend
 * including the default hosted models, as a normalized OpenAI-style chat forest.
 *
 * This module reconstructs a linear conversation from that store and synthesizes
 * canonical {@link RawPair}s — one per assistant turn, each carrying the
 * cumulative transcript-so-far in its request and the assistant turn in its
 * response — so the SAME wire pipeline the live tracers feed ({@link
 * import("../trajectory").buildTrajectories} → store → HTML) reconstructs Devin
 * sessions with zero special-casing. The synthetic wire is recognized by the
 * `provider: "devin"` marker (see {@link import("../trajectory/devin").DevinAdapter}).
 *
 * Fidelity notes captured straight from the store's per-message metadata:
 *   - the REAL underlying model the Adaptive router picked (`generation_model`,
 *     e.g. `claude-sonnet-4-6`) even when the session model is `"adaptive"`;
 *   - full token metrics including cache read/creation tokens;
 *   - per-turn timing (started_generation_at / created_at → TTFT + duration);
 *   - `finish_reason` as the stop reason.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Session-level metadata from the `sessions` table. */
export interface DevinSessionMeta {
  id: string;
  workingDirectory: string;
  backendType: string;
  /** Session-level model as configured, e.g. `"adaptive"` (a router alias). */
  model: string;
  agentMode: string;
  title: string;
  /** Leaf node id of the active branch; the reconstruction walks its ancestry. */
  mainChainId: number | null;
  /** Session creation time (unix epoch seconds), 0 when unknown. */
  createdAt: number;
  /** Last activity time (unix epoch seconds), 0 when unknown. */
  lastActivityAt: number;
}

/** A reconstructed session: its metadata, synthetic wire pairs, and rollups. */
export interface DevinImportedSession {
  meta: DevinSessionMeta;
  pairs: RawPair[];
  /** The dominant real model across the session's turns (for pricing/labeling). */
  resolvedModel: string;
  /** Number of assistant turns on the active chain. */
  turns: number;
}

// ---------------------------------------------------------------------------
// Internal DB row shapes
// ---------------------------------------------------------------------------

/** One node of a session's message forest, chat_message already JSON-parsed. */
interface DevinNode {
  nodeId: number;
  parentNodeId: number | null;
  createdAt: number;
  chat: DevinChatMessage;
}

interface DevinToolCall {
  id?: string;
  name?: string;
  arguments?: unknown;
}

interface DevinChatMessage {
  message_id?: string;
  role?: "system" | "user" | "assistant" | "tool";
  content?: unknown;
  tool_calls?: DevinToolCall[];
  tool_call_id?: string;
  metadata?: DevinMessageMetadata;
}

interface DevinMessageMetadata {
  generation_model?: string;
  finish_reason?: string;
  started_generation_at?: string;
  created_at?: string;
  metrics?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
    ttft_ms?: number;
    total_time_ms?: number;
  } | null;
}

/** One transcript message in the synthetic wire body. */
export interface DevinWireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { id: string; name: string; arguments: unknown }[];
  tool_call_id?: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Default Devin session store: `$DEVIN_SESSIONS_DB` when set, else the standard
 * install location `~/.local/share/devin/cli/sessions.db` (macOS/Linux).
 */
export function defaultDevinDbPath(): string {
  if (process.env.DEVIN_SESSIONS_DB) return process.env.DEVIN_SESSIONS_DB;
  return path.join(os.homedir(), ".local", "share", "devin", "cli", "sessions.db");
}

// ---------------------------------------------------------------------------
// DB access
// ---------------------------------------------------------------------------

/** Open the Devin session store read-only (never mutate the CLI's own DB). */
export function openDevinDb(dbPath: string = defaultDevinDbPath()): DatabaseType {
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `Devin session store not found at ${dbPath}. Run the Devin CLI at least once, ` +
        `or pass --db <path> / set DEVIN_SESSIONS_DB.`,
    );
  }
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

/** List every session in the store, most recently active first. */
export function listDevinSessions(db: DatabaseType): DevinSessionMeta[] {
  const rows = db
    .prepare(
      `SELECT id, working_directory, backend_type, model, agent_mode, title,
              main_chain_id, created_at, last_activity_at
       FROM sessions
       WHERE COALESCE(hidden, 0) = 0
       ORDER BY last_activity_at DESC`,
    )
    .all() as any[];
  return rows.map(rowToMeta);
}

/** Look up a single session's metadata by id, or null when absent. */
export function getDevinSession(db: DatabaseType, sessionId: string): DevinSessionMeta | null {
  const row = db
    .prepare(
      // Honor the same hidden filter `list` applies, so `import --session <id>`
      // never resurrects a session the user hid/deleted and `list` omits.
      `SELECT id, working_directory, backend_type, model, agent_mode, title,
              main_chain_id, created_at, last_activity_at
       FROM sessions WHERE id = ? AND COALESCE(hidden, 0) = 0`,
    )
    .get(sessionId) as any | undefined;
  return row ? rowToMeta(row) : null;
}

function rowToMeta(row: any): DevinSessionMeta {
  return {
    id: String(row.id),
    workingDirectory: String(row.working_directory ?? ""),
    backendType: String(row.backend_type ?? ""),
    model: String(row.model ?? ""),
    agentMode: String(row.agent_mode ?? ""),
    title: String(row.title ?? ""),
    mainChainId: row.main_chain_id == null ? null : Number(row.main_chain_id),
    // Devin stores these as integer milliseconds; normalize to epoch seconds.
    createdAt: msToSec(row.created_at),
    lastActivityAt: msToSec(row.last_activity_at),
  };
}

// ---------------------------------------------------------------------------
// Reconstruction
// ---------------------------------------------------------------------------

/** Load every message node for a session, chat_message JSON-parsed. */
function loadNodes(db: DatabaseType, sessionId: string): Map<number, DevinNode> {
  const rows = db
    .prepare(
      `SELECT node_id, parent_node_id, chat_message, created_at
       FROM message_nodes WHERE session_id = ?`,
    )
    .all(sessionId) as any[];
  const map = new Map<number, DevinNode>();
  for (const r of rows) {
    let chat: DevinChatMessage = {};
    try {
      chat = JSON.parse(String(r.chat_message)) as DevinChatMessage;
    } catch {
      continue; // skip a node whose payload is unparseable
    }
    const nodeId = Number(r.node_id);
    map.set(nodeId, {
      nodeId,
      parentNodeId: r.parent_node_id == null ? null : Number(r.parent_node_id),
      createdAt: msToSec(r.created_at),
      chat,
    });
  }
  return map;
}

/**
 * The active linear conversation: walk `parent_node_id` from the leaf (the
 * session's `main_chain_id`) up to a root, then reverse. Abandoned regeneration
 * branches (siblings not on this ancestry) are intentionally dropped. When
 * `main_chain_id` is missing or dangling, fall back to the highest node id
 * (the store appends monotonically, so that is the newest leaf).
 */
export function reconstructChain(
  nodes: Map<number, DevinNode>,
  mainChainId: number | null,
): DevinNode[] {
  if (nodes.size === 0) return [];
  let leafId = mainChainId;
  if (leafId == null || !nodes.has(leafId)) {
    leafId = pickFallbackLeaf(nodes);
  }
  const chain: DevinNode[] = [];
  const seen = new Set<number>();
  let cur: number | null = leafId;
  while (cur != null && nodes.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const node: DevinNode = nodes.get(cur)!;
    chain.push(node);
    cur = node.parentNodeId;
  }
  chain.reverse();
  return chain;
}

/**
 * Choose a leaf when `main_chain_id` is missing or dangling. Prefer the most
 * recently created CHILDLESS node (a genuine conversation leaf) so a
 * higher-numbered abandoned regeneration sibling isn't picked over the active
 * tip; fall back to the highest node id. Uses linear scans (never a `Math.max`
 * argument spread), so it stays stack-safe on sessions with 100k+ nodes.
 */
function pickFallbackLeaf(nodes: Map<number, DevinNode>): number {
  const hasChild = new Set<number>();
  for (const n of nodes.values()) {
    if (n.parentNodeId != null) hasChild.add(n.parentNodeId);
  }
  let best: DevinNode | null = null;
  for (const n of nodes.values()) {
    if (hasChild.has(n.nodeId)) continue; // internal node, not a leaf
    if (
      best == null ||
      n.createdAt > best.createdAt ||
      (n.createdAt === best.createdAt && n.nodeId > best.nodeId)
    ) {
      best = n;
    }
  }
  if (best != null) return best.nodeId;
  // Degenerate forest (a cycle, or every node has a child): highest id wins.
  let maxId = -Infinity;
  for (const id of nodes.keys()) if (id > maxId) maxId = id;
  return maxId;
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

/**
 * Reconstruct one session into synthetic {@link RawPair}s. Returns null when the
 * session has no assistant turns (nothing to show).
 */
export function importDevinSession(
  db: DatabaseType,
  meta: DevinSessionMeta,
): DevinImportedSession | null {
  const nodes = loadNodes(db, meta.id);
  const chain = reconstructChain(nodes, meta.mainChainId);
  if (chain.length === 0) return null;

  // System-role nodes form the (resent-every-turn) system prompt; everything
  // else is the ordered transcript that grows turn to turn.
  const systemText = chain
    .filter((n) => n.chat.role === "system")
    .map((n) => contentToText(n.chat.content))
    .filter((t) => t.trim())
    .join("\n\n");
  const transcript = chain.filter((n) => n.chat.role !== "system");

  const assistantNodes = transcript.filter((n) => n.chat.role === "assistant");
  if (assistantNodes.length === 0) return null;
  const resolvedModel = dominantModel(assistantNodes, meta.model);

  const pairs: RawPair[] = [];
  const prior: DevinWireMessage[] = [];
  // True when the chain ends with user/tool node(s) after the last assistant
  // turn (a mid-turn snapshot: e.g. a tool executed but the next assistant
  // generation was not yet persisted). Those trailing messages would otherwise
  // never appear in any pair's request transcript and be silently dropped.
  let trailingTail = false;
  let lastTs = meta.createdAt;

  for (const node of transcript) {
    const role = node.chat.role;
    lastTs = node.createdAt || lastTs;
    if (role === "assistant") {
      const md: DevinMessageMetadata = node.chat.metadata ?? {};
      const metrics = md.metrics ?? {};
      const genModel = md.generation_model || resolvedModel;
      const reqTs =
        isoToSec(md.started_generation_at) ??
        isoToSec(md.created_at) ??
        (node.createdAt || meta.createdAt);
      const respTs = isoToSec(md.created_at) ?? (node.createdAt || reqTs);
      const ttftSec =
        typeof metrics.ttft_ms === "number" && Number.isFinite(metrics.ttft_ms)
          ? metrics.ttft_ms / 1000
          : undefined;

      const assistantMsg = toAssistantWire(node.chat);
      pairs.push({
        request: {
          timestamp: reqTs,
          method: "POST",
          url: `devin://session/${meta.id}`,
          headers: {},
          body: {
            provider: "devin",
            session_id: meta.id,
            model: resolvedModel,
            system: systemText || undefined,
            // Cumulative transcript BEFORE this assistant turn (copied so later
            // mutation of `prior` never rewrites an already-emitted pair).
            transcript: prior.map(cloneMessage),
          },
        },
        response: {
          timestamp: respTs,
          first_byte_timestamp: ttftSec != null ? reqTs + ttftSec : undefined,
          status_code: 200,
          headers: {},
          body: {
            provider: "devin",
            model: genModel,
            finish_reason: md.finish_reason,
            message: assistantMsg,
            usage: {
              input_tokens: num(metrics.input_tokens),
              output_tokens: num(metrics.output_tokens),
              cache_read_tokens: num(metrics.cache_read_tokens),
              cache_creation_tokens: num(metrics.cache_creation_tokens),
            },
          },
        },
        logged_at: md.created_at || new Date(Math.round(respTs * 1000)).toISOString(),
      });
      prior.push(assistantMsg);
      trailingTail = false;
    } else if (role === "user") {
      prior.push({ role: "user", content: contentToText(node.chat.content) });
      trailingTail = true;
    } else if (role === "tool") {
      prior.push({
        role: "tool",
        content: contentToText(node.chat.content),
        tool_call_id: node.chat.tool_call_id,
      });
      trailingTail = true;
    }
  }

  // Flush trailing user/tool state as a final pair with an EMPTY response, so
  // the shared walker still emits any trailing user step and stitches the
  // trailing tool result onto the tool call that produced it — without adding
  // a phantom agent step (parseResponse yields no items + null usage, so the
  // walker's `items.length > 0 || usage` guard skips the agent step).
  if (trailingTail) {
    pairs.push({
      request: {
        timestamp: lastTs,
        method: "POST",
        url: `devin://session/${meta.id}`,
        headers: {},
        body: {
          provider: "devin",
          session_id: meta.id,
          model: resolvedModel,
          system: systemText || undefined,
          transcript: prior.map(cloneMessage),
        },
      },
      response: {
        timestamp: lastTs,
        status_code: 200,
        headers: {},
        body: { provider: "devin", model: resolvedModel },
      },
      logged_at: new Date(Math.round(lastTs * 1000)).toISOString(),
    });
  }

  return { meta, pairs, resolvedModel, turns: assistantNodes.length };
}

/** Convenience: reconstruct every session in the store (skipping empty ones). */
export function importAllDevinSessions(db: DatabaseType): DevinImportedSession[] {
  const out: DevinImportedSession[] = [];
  for (const meta of listDevinSessions(db)) {
    const s = importDevinSession(db, meta);
    if (s) out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toAssistantWire(chat: DevinChatMessage): DevinWireMessage {
  const msg: DevinWireMessage = { role: "assistant", content: contentToText(chat.content) };
  const tcs = Array.isArray(chat.tool_calls) ? chat.tool_calls : [];
  if (tcs.length) {
    msg.tool_calls = tcs.map((tc) => ({
      id: String(tc.id ?? ""),
      name: String(tc.name ?? "tool"),
      arguments: tc.arguments,
    }));
  }
  return msg;
}

function cloneMessage(m: DevinWireMessage): DevinWireMessage {
  const out: DevinWireMessage = { role: m.role, content: m.content };
  if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
  if (m.tool_calls) out.tool_calls = m.tool_calls.map((t) => ({ ...t }));
  return out;
}

/** Most frequent non-empty `generation_model`; ties broken by first-seen. */
function dominantModel(assistantNodes: DevinNode[], fallback: string): string {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const n of assistantNodes) {
    const m = n.chat.metadata?.generation_model;
    if (!m) continue;
    if (!counts.has(m)) order.push(m);
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = -1;
  for (const m of order) {
    const c = counts.get(m)!;
    if (c > bestCount) {
      best = m;
      bestCount = c;
    }
  }
  return best || fallback || "unknown";
}

/** Devin `content` is normally a string; tolerate arrays/objects defensively. */
function contentToText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as any).text === "string") {
          return (part as any).text;
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  return JSON.stringify(content);
}

/** ISO-8601 (with fractional seconds + `Z`) → unix epoch seconds, or undefined. */
function isoToSec(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 1000 : undefined;
}

/** Integer epoch-milliseconds → epoch seconds; 0 when absent/invalid. */
function msToSec(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Values look like ms (13 digits); guard against a store that already used s.
  return n > 1e11 ? n / 1000 : n;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
