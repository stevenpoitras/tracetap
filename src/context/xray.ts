import * as crypto from "crypto";
import type { RawPair } from "../types";
import { XRAY_BUCKETS, type XrayBucketId } from "./xray-buckets";
import { toolName } from "./tooltax";

export interface XraySegment {
  bucket: XrayBucketId;
  /** Stable id for diffing across calls (content hash of normalized text). */
  id: string;
  chars: number;
  /** Rough token estimate (chars/4). */
  approxTokens: number;
  preview: string;
  /** Longer text for hover/expand (capped). */
  full?: string;
  /** Optional role / block type hint. */
  kind?: string;
}

export interface XrayBucketSummary {
  bucket: XrayBucketId;
  label: string;
  chars: number;
  approxTokens: number;
  segments: number;
}

export type XrayDeltaKind = "new" | "carried" | "dropped";

export interface XrayDelta {
  kind: XrayDeltaKind;
  bucket: XrayBucketId;
  id: string;
  chars: number;
  approxTokens: number;
  preview: string;
}

export interface ContextXray {
  seq: number;
  model: string;
  promptHash: string;
  totalChars: number;
  totalApproxTokens: number;
  /** Prompt tokens from the wire when available. */
  wirePromptTokens: number | null;
  buckets: XrayBucketSummary[];
  segments: XraySegment[];
  /** Present when a previous call was provided. */
  delta?: {
    prevSeq: number;
    newCount: number;
    carriedCount: number;
    droppedCount: number;
    items: XrayDelta[];
  };
}

function approxTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4));
}

function sha8(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function previewOf(text: string, n = 100): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : flat.slice(0, n) + "…";
}

function pushSeg(
  segs: XraySegment[],
  bucket: XrayBucketId,
  text: string,
  kind?: string,
): void {
  if (!text) return;
  const fullCap = 12000;
  segs.push({
    bucket,
    id: sha8(bucket + "\0" + text),
    chars: text.length,
    approxTokens: approxTokens(text.length),
    preview: previewOf(text),
    full: text.length > fullCap ? text.slice(0, fullCap) + "…" : text,
    kind,
  });
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const t = (b as any).type;
    if (t === "text" && typeof (b as any).text === "string") parts.push((b as any).text);
    else if (t === "thinking" && typeof (b as any).thinking === "string") parts.push((b as any).thinking);
    else if (t === "tool_result") {
      const c = (b as any).content;
      parts.push(typeof c === "string" ? c : JSON.stringify(c ?? ""));
    } else if (t === "tool_use") {
      parts.push(JSON.stringify({ name: (b as any).name, input: (b as any).input }));
    } else {
      parts.push(JSON.stringify(b));
    }
  }
  return parts.join("\n");
}

/** Heuristic: skill / CLAUDE.md style docs often appear as long system text blocks. */
function classifySystemText(text: string): XrayBucketId {
  const lower = text.toLowerCase();
  if (
    lower.includes("additionalcontext") ||
    lower.includes("[context-health]") ||
    lower.includes("hookspecificoutput") ||
    /\bposture\b/.test(lower) && text.length < 4000
  ) {
    return "hook_inject";
  }
  if (
    /skill\.md/i.test(text) ||
    /claude\.md/i.test(text) ||
    /<\/?skills?>/i.test(text) ||
    /\bavailable skills\b/i.test(text)
  ) {
    return "skills";
  }
  return "system";
}

/**
 * Partition an Anthropic-style request body into X-Ray segments.
 * Also tolerates OpenAI/Gemini-ish shapes by best-effort field picking.
 */
export function segmentsFromRequestBody(body: any): XraySegment[] {
  const segs: XraySegment[] = [];
  if (!body || typeof body !== "object") return segs;

  // System
  if (typeof body.system === "string") {
    pushSeg(segs, classifySystemText(body.system), body.system, "system");
  } else if (Array.isArray(body.system)) {
    for (const block of body.system) {
      const t = typeof block === "string" ? block : block?.text ?? "";
      if (typeof t === "string" && t) pushSeg(segs, classifySystemText(t), t, "system_block");
    }
  } else if (typeof body.instructions === "string") {
    pushSeg(segs, "system", body.instructions, "instructions");
  }

  // Tools — one segment per declared tool, so per-tool cost is visible in the
  // segment list and the toolset registry sizes from the same numbers.
  const tools = body.tools ?? body.tools_list;
  if (Array.isArray(tools) && tools.length) {
    for (const tool of tools) {
      const text = JSON.stringify(tool) ?? "";
      if (!text) continue;
      pushSeg(segs, "tools", text, `tool:${toolName(tool) || "(unnamed)"}`);
    }
  }

  // Messages (Anthropic / chat)
  const messages: any[] = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.input)
      ? body.input
      : Array.isArray(body.contents)
        ? body.contents
        : [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = String(msg.role ?? msg.author ?? "user");
    const content = msg.content ?? msg.parts ?? msg.parts_text;

    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          pushSeg(segs, "other", String(block ?? ""), "raw");
          continue;
        }
        const t = (block as any).type;
        if (t === "thinking" || t === "reasoning") {
          const text =
            typeof (block as any).thinking === "string"
              ? (block as any).thinking
              : textFromContent(block);
          pushSeg(segs, "thinking", text, t);
        } else if (t === "tool_result" || t === "function_response") {
          pushSeg(segs, "tool_result", textFromContent(block), t);
        } else if (t === "tool_use" || t === "function_call") {
          // Tool calls on the assistant turn are part of assistant history.
          pushSeg(segs, "assistant", textFromContent(block), t);
        } else if (role === "assistant" || role === "model") {
          pushSeg(segs, "assistant", textFromContent(block), t || "text");
        } else if (role === "tool") {
          pushSeg(segs, "tool_result", textFromContent(block), "tool");
        } else {
          pushSeg(segs, "user", textFromContent(block), t || "text");
        }
      }
    } else {
      const text = textFromContent(content);
      if (role === "assistant" || role === "model") pushSeg(segs, "assistant", text, role);
      else if (role === "tool" || role === "function") pushSeg(segs, "tool_result", text, role);
      else if (role === "system") pushSeg(segs, classifySystemText(text), text, role);
      else pushSeg(segs, "user", text, role);
    }
  }

  return segs;
}

function summarizeBuckets(segments: XraySegment[]): XrayBucketSummary[] {
  const byId = new Map<XrayBucketId, XrayBucketSummary>();
  for (const def of XRAY_BUCKETS) {
    byId.set(def.id, {
      bucket: def.id,
      label: def.label,
      chars: 0,
      approxTokens: 0,
      segments: 0,
    });
  }
  for (const s of segments) {
    const row = byId.get(s.bucket) ?? byId.get("other")!;
    row.chars += s.chars;
    row.approxTokens += s.approxTokens;
    row.segments += 1;
  }
  return XRAY_BUCKETS.map((d) => byId.get(d.id)!).filter((b) => b.segments > 0 || b.chars > 0);
}

function diffSegments(prev: XraySegment[], curr: XraySegment[], prevSeq: number) {
  const prevIds = new Map(prev.map((s) => [s.id, s]));
  const currIds = new Map(curr.map((s) => [s.id, s]));
  const items: XrayDelta[] = [];
  for (const s of curr) {
    items.push({
      kind: prevIds.has(s.id) ? "carried" : "new",
      bucket: s.bucket,
      id: s.id,
      chars: s.chars,
      approxTokens: s.approxTokens,
      preview: s.preview,
    });
  }
  for (const s of prev) {
    if (!currIds.has(s.id)) {
      items.push({
        kind: "dropped",
        bucket: s.bucket,
        id: s.id,
        chars: s.chars,
        approxTokens: s.approxTokens,
        preview: s.preview,
      });
    }
  }
  return {
    prevSeq,
    newCount: items.filter((i) => i.kind === "new").length,
    carriedCount: items.filter((i) => i.kind === "carried").length,
    droppedCount: items.filter((i) => i.kind === "dropped").length,
    items,
  };
}

export interface BuildXrayOpts {
  seq: number;
  pair: RawPair;
  prev?: { seq: number; pair: RawPair };
  promptHash?: string;
}

/** Build a Context X-Ray view for one captured request pair. */
export function buildContextXray(opts: BuildXrayOpts): ContextXray {
  const body = opts.pair?.request?.body;
  const segments = segmentsFromRequestBody(body);
  const buckets = summarizeBuckets(segments);
  const totalChars = segments.reduce((a, s) => a + s.chars, 0);
  const usage = (opts.pair?.response as any)?.body?.usage;
  let wirePromptTokens: number | null = null;
  // Prefer metrics already known from store when caller sets them via pair — here
  // we only peek at non-stream JSON bodies; SSE usage lives in body_raw.
  if (usage && typeof usage.input_tokens === "number") {
    wirePromptTokens = usage.input_tokens;
  }

  const model = String((body as any)?.model ?? "");
  const out: ContextXray = {
    seq: opts.seq,
    model,
    promptHash: opts.promptHash ?? "",
    totalChars,
    totalApproxTokens: approxTokens(totalChars),
    wirePromptTokens,
    buckets,
    segments,
  };

  if (opts.prev) {
    const prevSegs = segmentsFromRequestBody(opts.prev.pair?.request?.body);
    out.delta = diffSegments(prevSegs, segments, opts.prev.seq);
  }
  return out;
}

export { XRAY_BUCKETS } from "./xray-buckets";
