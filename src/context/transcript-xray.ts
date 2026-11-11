import type { RawPair } from "../types";
import { approxTokens, diffSegments, summarizeBuckets } from "./xray";
import type { ContextXray, XraySegment } from "./xray";
import { XRAY_BUCKET_IDS, type XrayBucketId } from "./xray-buckets";

/**
 * Context X-Ray for sessions imported from Claude Code's local transcripts.
 *
 * The wire X-Ray partitions a request body, which on the wire is the whole
 * resent transcript. An imported request carries only a DELTA since the
 * previous response (see claude-transcripts/importer.ts), so partitioning it
 * finds nothing: on a real 871-call session every call read 0 chars. What the
 * transcript does have is every piece in order, so this walks a session's
 * pairs and keeps a RUNNING composition instead:
 *
 *   - request delta items: prompts → user, tool results → tool_result, sized
 *     context items → their bucket, and a compact_boundary → reset to what the
 *     compaction kept (the summary follows it as its own item);
 *   - response blocks, after the call is measured: text and tool-use input →
 *     assistant, thinking → thinking.
 *
 * Sizes use the wire X-Ray's rule (ceil(chars/4) per item) so the two views
 * reconcile. A transcript never records the system prompt or the tool
 * declarations, so for each measured call the part of the REAL context
 * (uncached input + cache read + cache write) the estimate does not reach is
 * reported as the `unrecorded` bucket, never below 0.
 *
 * That remainder is NOT just the system prompt and tool declarations. On a real
 * 871-call desktop session the estimate reached 91% of the real size on call 1
 * (so system + tools were ~9%), then drifted to 54% by the last call. The drift
 * is growth the estimate under-counts: thinking content transcripts do not
 * keep, and chars/4 reading code- and JSON-heavy text as fewer tokens than the
 * tokenizer does. The label says so, so the bucket is never read as the size of
 * the system prompt. When the estimate is
 * larger than the real size (chars/4 over-counts dense text, and Claude Code
 * may elide content it does not resend), the call is flagged with the
 * overshoot rather than scaled to fit: a scaled bucket would be a guess
 * dressed as a measurement.
 */

/** Buckets a transcript context item may name; anything else is `other`. */
export type ContextBucket = Exclude<XrayBucketId, "unrecorded">;

export const UNRECORDED_BUCKET: XrayBucketId = "unrecorded";
const UNRECORDED_LABEL =
  "not accounted for (system prompt, tool definitions, unkept thinking, estimate error)";
const CONTEXT_BUCKETS = new Set<string>(XRAY_BUCKET_IDS.filter((b) => b !== UNRECORDED_BUCKET));

/**
 * Bucket and size of one assistant content block, as it is carried forward
 * into later calls. Shared with the importer, which sizes preserved records
 * by the same rule so a compaction's `kept` total matches what this walker
 * counted before the reset.
 */
export function responseBlockSize(b: unknown): { bucket: ContextBucket; chars: number } | null {
  if (!b || typeof b !== "object") return null;
  const block = b as Record<string, any>;
  if (block.type === "text") return { bucket: "assistant", chars: String(block.text ?? "").length };
  if (block.type === "thinking" || block.type === "redacted_thinking") {
    return { bucket: "thinking", chars: String(block.thinking ?? block.data ?? "").length };
  }
  if (block.type === "tool_use") {
    // Same serialization xray.ts uses for a tool_use block in the history.
    return { bucket: "assistant", chars: JSON.stringify({ name: block.name, input: block.input }).length };
  }
  return null;
}

/** One call's composition: running totals only, cheap enough for every call at index time. */
export interface TranscriptCallComposition {
  seq: number;
  /** The call carried usage. `usage: null` pairs repeat a counted response. */
  measured: boolean;
  /** uncached input + cache read + cache write, null when not measured. */
  realTokens: number | null;
  estimatedChars: number;
  estimatedTokens: number;
  /** bucket → tokens; `unrecorded` is present on measured calls only. */
  buckets: Record<string, number>;
  unrecordedTokens: number;
  /** estimate − real when the estimate is larger; 0 otherwise. */
  overshootTokens: number;
}

interface Item {
  id: string;
  bucket: XrayBucketId;
  chars: number;
  tokens: number;
  label: string;
  preview: string;
}

function previewOf(text: string, n = 100): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : flat.slice(0, n) + "…";
}

function realTokensOf(pair: RawPair): number | null {
  const u = (pair?.response?.body as any)?.usage;
  if (!u || typeof u !== "object") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
}

/**
 * Walk `pairs` (one conversation, in seq order) and call `visit` once per
 * call with the composition the call was sent with.
 */
function walk(
  pairs: RawPair[],
  visit: (seq: number, items: readonly Item[], totals: Map<XrayBucketId, { chars: number; tokens: number }>) => void,
): void {
  let items: Item[] = [];
  let totals = new Map<XrayBucketId, { chars: number; tokens: number }>();
  let nextId = 0;
  const add = (bucket: XrayBucketId, chars: number, label: string, preview: string) => {
    if (!(chars > 0)) return;
    const tokens = approxTokens(chars);
    items.push({ id: `t${nextId++}`, bucket, chars, tokens, label, preview });
    const t = totals.get(bucket) ?? { chars: 0, tokens: 0 };
    t.chars += chars;
    t.tokens += tokens;
    totals.set(bucket, t);
  };
  pairs.forEach((pair, seq) => {
    const body: any = pair?.request?.body ?? {};
    const delta: any[] = Array.isArray(body.delta) ? body.delta : [];
    for (const d of delta) {
      if (!d || typeof d !== "object") continue;
      if (d.kind === "user") {
        const text = String(d.text ?? "");
        add("user", text.length, "prompt", previewOf(text));
      } else if (d.kind === "tool_result") {
        const text = String(d.content ?? "");
        add("tool_result", text.length, "tool result", previewOf(text));
      } else if (d.kind === "context") {
        const bucket = CONTEXT_BUCKETS.has(d.bucket) ? (d.bucket as XrayBucketId) : "other";
        const label = String(d.label ?? "context");
        add(bucket, Number(d.chars) || 0, label, label);
      } else if (d.kind === "compact_boundary") {
        // Everything before the boundary is gone; what the compaction kept
        // comes back as one item per bucket, and the summary follows as its
        // own delta item.
        items = [];
        totals = new Map();
        const kept = d.kept && typeof d.kept === "object" ? d.kept : {};
        for (const [b, n] of Object.entries(kept)) {
          const bucket = CONTEXT_BUCKETS.has(b) ? (b as XrayBucketId) : "other";
          add(bucket, Number(n) || 0, "kept after compaction", "kept after compaction");
        }
      }
    }
    visit(seq, items, totals);
    // The response is read by every LATER call. An errored call's blocks are
    // Claude Code's client-side placeholder, never sent back to the model.
    const status = pair?.response?.status_code ?? 0;
    const rb: any = pair?.response?.body ?? {};
    if (status >= 400 || rb.trailing) return;
    for (const b of Array.isArray(rb.content) ? rb.content : []) {
      const sz = responseBlockSize(b);
      if (!sz) continue;
      const text =
        b.type === "text" ? String(b.text ?? "") : b.type === "tool_use" ? `${b.name ?? "tool"} call` : String(b.thinking ?? "");
      add(sz.bucket, sz.chars, b.type === "tool_use" ? `tool_use:${b.name ?? "tool"}` : String(b.type), previewOf(text));
    }
  });
}

function compose(
  seq: number,
  pair: RawPair,
  totals: Map<XrayBucketId, { chars: number; tokens: number }>,
): TranscriptCallComposition {
  const buckets: Record<string, number> = {};
  let estimatedChars = 0;
  let estimatedTokens = 0;
  for (const id of XRAY_BUCKET_IDS) {
    const t = totals.get(id);
    if (!t || !t.tokens) continue;
    buckets[id] = t.tokens;
    estimatedChars += t.chars;
    estimatedTokens += t.tokens;
  }
  const realTokens = realTokensOf(pair);
  const measured = realTokens != null;
  const unrecordedTokens = measured ? Math.max(0, realTokens - estimatedTokens) : 0;
  const overshootTokens = measured ? Math.max(0, estimatedTokens - realTokens) : 0;
  if (measured) buckets[UNRECORDED_BUCKET] = unrecordedTokens;
  return { seq, measured, realTokens, estimatedChars, estimatedTokens, buckets, unrecordedTokens, overshootTokens };
}

/** Per-call composition for every pair of one conversation, in seq order. */
export function transcriptCompositions(pairs: RawPair[]): TranscriptCallComposition[] {
  const out: TranscriptCallComposition[] = [];
  walk(pairs, (seq, _items, totals) => out.push(compose(seq, pairs[seq], totals)));
  return out;
}

function segmentsOf(items: readonly Item[], c: TranscriptCallComposition): XraySegment[] {
  const segs: XraySegment[] = items.map((it) => ({
    bucket: it.bucket,
    id: it.id,
    chars: it.chars,
    approxTokens: it.tokens,
    preview: it.preview,
    kind: it.label,
  }));
  if (c.unrecordedTokens > 0) {
    segs.push({
      bucket: UNRECORDED_BUCKET,
      id: "unrecorded",
      // Expressed in chars so totals keep X-Ray's chars = 4 × tokens relation.
      chars: c.unrecordedTokens * 4,
      approxTokens: c.unrecordedTokens,
      preview: UNRECORDED_LABEL,
      kind: "unrecorded",
    });
  }
  return segs;
}

/**
 * Full X-Ray views (segments, buckets, delta against the previous call) for
 * the requested seqs. The walk always starts at the first call — the
 * composition is cumulative — but segments are materialized only for the
 * calls asked for and their predecessors.
 */
export function transcriptXrayWindow(
  pairs: RawPair[],
  seqs: number[],
  promptHashes: Map<number, string> = new Map(),
): ContextXray[] {
  const want = new Set(seqs);
  const keep = new Set<number>();
  for (const s of seqs) {
    keep.add(s);
    if (s > 0) keep.add(s - 1);
  }
  const snaps = new Map<number, { segs: XraySegment[]; comp: TranscriptCallComposition }>();
  walk(pairs, (seq, items, totals) => {
    if (!keep.has(seq)) return;
    const comp = compose(seq, pairs[seq], totals);
    snaps.set(seq, { segs: segmentsOf(items, comp), comp });
  });
  const out: ContextXray[] = [];
  for (const seq of [...want].sort((a, b) => a - b)) {
    const snap = snaps.get(seq);
    if (!snap) continue;
    const { segs, comp } = snap;
    const totalChars = segs.reduce((a, s) => a + s.chars, 0);
    const prev = snaps.get(seq - 1);
    const usage = (pairs[seq]?.response?.body as any)?.usage;
    out.push({
      seq,
      model: String((pairs[seq]?.request?.body as any)?.model ?? ""),
      promptHash: promptHashes.get(seq) ?? "",
      totalChars,
      totalApproxTokens: segs.reduce((a, s) => a + s.approxTokens, 0),
      wirePromptTokens: usage && typeof usage.input_tokens === "number" ? usage.input_tokens : null,
      buckets: summarizeBuckets(segs),
      segments: segs,
      transcript: {
        measured: comp.measured,
        realTokens: comp.realTokens,
        estimatedTokens: comp.estimatedTokens,
        unrecordedTokens: comp.unrecordedTokens,
        overshootTokens: comp.overshootTokens,
      },
      ...(prev ? { delta: diffSegments(prev.segs, segs, seq - 1) } : {}),
    });
  }
  return out;
}
