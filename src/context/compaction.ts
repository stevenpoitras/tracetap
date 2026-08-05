import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Compactions as Claude Code RECORDS them, rather than as we infer them.
 *
 * tracetap indexes wire logs (`.claude-trace/*.jsonl`) — what went to the API.
 * Claude Code separately writes its own session transcript under
 * `~/.claude/projects/<slug>/<session-uuid>.jsonl`, and in THAT file every
 * compaction appears as an explicit record:
 *
 *   {"type":"system","subtype":"compact_boundary","sessionId":"…","cwd":"…",
 *    "timestamp":"2026-08-03T06:16:17.792Z",
 *    "compactMetadata":{"trigger":"auto","preTokens":206493,"postTokens":12484,
 *      "cumulativeDroppedTokens":194009,"durationMs":98436,
 *      "preservedSegment":{…},"preservedMessages":{"uuids":[…]}}}
 *
 * This matters because the wire-side inference in `timeline.ts` was measured at
 * 75% false positives (209 reported, 53 real) against the live index, and even
 * a perfect inference cannot recover the one field people actually ask for:
 * WHY it happened. `trigger` distinguishes an automatic compaction from a user
 * typing `/compact`, and nothing on the wire distinguishes those.
 *
 * Measured across 200 boundary records in 88 transcripts: trigger was `auto`
 * 138 times and `manual` 62; the smallest real compaction freed 24,287 tokens;
 * none freed under 10,000; the median retention (post/pre) was 0.072.
 *
 * The join key is Claude Code's own session id, which the wire log carries as
 * the `x-claude-code-session-id` request header and the transcript carries both
 * in its filename and in every record.
 */

/** One compaction, as recorded by the agent that performed it. */
export interface CompactionRecord {
  /** Claude Code's session uuid — the join key back to the wire log. */
  claudeSessionId: string;
  /** Unix epoch SECONDS, matching every other timestamp in the index. */
  ts: number;
  /**
   * `auto` when Claude Code compacted to stay under the context limit,
   * `manual` when the user ran `/compact`. Any other string is passed through
   * rather than coerced: an unrecognised trigger is a fact about a newer
   * client, not a parse error.
   */
  trigger: string;
  /** Context size immediately before, in tokens, as the client measured it. */
  preTokens: number;
  /** Context size immediately after. */
  postTokens: number;
  /** `preTokens - postTokens`; the honest "what did this buy" number. */
  droppedTokens: number;
  /** Running total across the whole session, when the client reported one. */
  cumulativeDroppedTokens: number | null;
  /** How long the compaction itself took. Median observed: ~116s. */
  durationMs: number | null;
  /** How many messages survived. The uuid list itself is not retained. */
  preservedMessages: number | null;
  /** Working directory the session ran in, when recorded. */
  cwd: string | null;
  /** What the user asked the summary to focus on, on a manual `/compact`. */
  userContext: string | null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Parse one transcript line into a compaction record.
 *
 * @returns null for every line that is not a compaction boundary — which is
 *   almost all of them, so this is the hot path of a whole-file scan and stays
 *   allocation-free until the subtype matches.
 */
export function parseCompactBoundary(line: string): CompactionRecord | null {
  // Cheap reject before JSON.parse: a transcript is mostly large message
  // objects, and parsing every one of them to discard it dominates the scan.
  if (!line.includes("compact_boundary")) return null;
  let j: any;
  try {
    j = JSON.parse(line);
  } catch {
    return null; // a torn tail line is not worth failing a whole session over
  }
  if (!j || j.subtype !== "compact_boundary") return null;
  const m = j.compactMetadata;
  if (!m || typeof m !== "object") return null;

  const pre = num(m.preTokens);
  const post = num(m.postTokens);
  // Without both sizes there is no measurement here, only an assertion that
  // something happened — and the inferred path already provides that.
  if (pre == null || post == null) return null;

  const tsMs = Date.parse(j.timestamp ?? "");
  const uuids = m.preservedMessages?.uuids;

  return {
    claudeSessionId: String(j.sessionId ?? ""),
    ts: Number.isFinite(tsMs) ? tsMs / 1000 : 0,
    trigger: typeof m.trigger === "string" ? m.trigger : "unknown",
    preTokens: pre,
    postTokens: post,
    droppedTokens: pre - post,
    cumulativeDroppedTokens: num(m.cumulativeDroppedTokens),
    durationMs: num(m.durationMs),
    preservedMessages: Array.isArray(uuids) ? uuids.length : null,
    cwd: typeof j.cwd === "string" ? j.cwd : null,
    userContext: typeof m.userContext === "string" ? m.userContext : null,
  };
}

/** Every compaction recorded in one transcript file, in file order. */
export function readCompactionsFromTranscript(file: string): CompactionRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return []; // the transcript is optional evidence, never a hard dependency
  }
  const out: CompactionRecord[] = [];
  for (const line of text.split("\n")) {
    const rec = parseCompactBoundary(line);
    if (rec) out.push(rec);
  }
  return out;
}

/** Root of Claude Code's per-project transcript store. */
export function transcriptRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Locate the transcript for a Claude Code session id.
 *
 * The file is `<root>/<project-slug>/<uuid>.jsonl`, and the slug is derived
 * from the cwd in a way we deliberately do NOT reimplement — one session's
 * traffic can span slugs (a worktree, a `/private/tmp` scratchpad), and
 * guessing wrong reads as "no data" rather than as a bug. Scanning the project
 * directories for the filename is exact and cheap: one readdir per project.
 *
 * @returns every matching path — normally one, occasionally more when the same
 *   session id appears under two project slugs.
 */
export function transcriptPathsFor(claudeSessionId: string, root = transcriptRoot()): string[] {
  if (!/^[0-9a-fA-F-]{36}$/.test(claudeSessionId)) return [];
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const p = path.join(root, d.name, claudeSessionId + ".jsonl");
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}

/**
 * Recorded compactions for a Claude Code session id, deduplicated.
 *
 * The same boundary can appear in more than one transcript when a session was
 * resumed or forked; `(ts, preTokens)` identifies it, since two distinct
 * compactions cannot start at the same instant from the same context size.
 */
export function compactionsForSession(
  claudeSessionId: string,
  root = transcriptRoot(),
): CompactionRecord[] {
  const seen = new Map<string, CompactionRecord>();
  for (const file of transcriptPathsFor(claudeSessionId, root)) {
    for (const rec of readCompactionsFromTranscript(file)) {
      seen.set(rec.ts + ":" + rec.preTokens, rec);
    }
  }
  return [...seen.values()].sort((a, b) => a.ts - b.ts);
}
