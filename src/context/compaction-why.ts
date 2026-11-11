import { isNoiseStep } from "../store/title";

/**
 * "Why did this compaction happen, and what filled the context?"
 *
 * One answer per compaction, computed on the server from what the index
 * already holds (served by `GET /api/session/<id>/compactions`):
 *
 *   - the trigger and focus text, from Claude Code's record when there is one
 *     (`auto` = hit the context limit, `manual` = the user ran /compact);
 *   - the prompt just before it;
 *   - before / after / dropped / duration / messages kept;
 *   - growth since the previous compaction (or the session start): calls,
 *     wall time, tokens;
 *   - the largest contributors in that span: the top tool results by size,
 *     and the largest user and assistant items.
 *
 * Steps carry no timestamps, so "before the compaction" is located through
 * the request rows: the cut is the step produced by the last call before it
 * (by seq when the compaction is attached to a call, by time when it is a
 * session-wide record). Steps after that call's step and before the next
 * call's are ambiguous by construction — a prompt typed right after a
 * boundary sits there too — so they are left OUT of the "before" span rather
 * than guessed into it. An imported session resolves its preceding prompt
 * exactly at index time instead (store: insertTranscriptCompactions).
 *
 * An inferred compaction gets every field it can support and reports its
 * trigger as unknown; nothing on the wire tells auto from /compact.
 */

export interface CompactionEventInput {
  /** Call the compaction is attached to; null for a session-wide record. */
  seq: number | null;
  /** Unix epoch seconds. */
  ts: number;
  trigger: string;
  triggerSource: "recorded" | "hook" | "inferred";
  preTokens: number;
  postTokens: number;
  durationMs?: number | null;
  preservedMessages?: number | null;
  userContext?: string | null;
  /** Resolved upstream (imported sessions); undefined = derive from steps. */
  precedingPrompt?: string | null;
}

export interface WhyStep {
  stepIndex: number;
  role: string;
  message: string;
  reasoning: string;
  toolName: string;
  toolInput: string;
  observation: string;
  /** Harness chatter rather than a person's ask; computed when absent. */
  noise?: boolean;
}

export interface WhyPoint {
  seq: number;
  ts: number;
  contextTokens: number;
}

export interface WhyRequest {
  seq: number;
  ts: number;
  agentStepIndex: number | null;
}

export interface WhyItem {
  stepIndex: number;
  chars: number;
  approxTokens: number;
  preview: string;
}

export interface CompactionWhy {
  /** 0-based position in the session's compactions. */
  index: number;
  seq: number | null;
  ts: number;
  /** `auto`, `manual`, `unknown`, or a newer client's own word, passed through. */
  trigger: string;
  triggerSource: CompactionEventInput["triggerSource"];
  userContext: string | null;
  precedingPrompt: { text: string; stepIndex: number | null } | null;
  preTokens: number;
  postTokens: number;
  droppedTokens: number;
  durationMs: number | null;
  preservedMessages: number | null;
  growth: {
    since: "session start" | "previous compaction";
    fromTs: number;
    /** Measured calls in the span, counted from the timeline. */
    calls: number;
    wallMs: number;
    /** preTokens minus the previous post-compaction size (or the first call's size). */
    tokens: number;
  };
  topToolResults: (WhyItem & { tool: string })[];
  largestUser: WhyItem | null;
  largestAssistant: WhyItem | null;
}

export interface CompactionInsights {
  source: "recorded" | "inferred" | "none";
  /** `claude-session`: records are session-wide, placed by time, not by call. */
  scope: "session" | "claude-session";
  subagentOnly: boolean;
  compactions: CompactionWhy[];
}

/** How many tool results the panel lists. */
export const TOP_TOOL_RESULTS = 5;
const PREVIEW_CHARS = 120;

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= PREVIEW_CHARS ? flat : flat.slice(0, PREVIEW_CHARS) + "…";
}

function item(stepIndex: number, chars: number, text: string): WhyItem {
  return { stepIndex, chars, approxTokens: Math.ceil(chars / 4), preview: preview(text) };
}

export function explainCompactions(input: {
  source: CompactionInsights["source"];
  scope: CompactionInsights["scope"];
  subagentOnly: boolean;
  events: CompactionEventInput[];
  points: WhyPoint[];
  requests: WhyRequest[];
  steps: WhyStep[];
}): CompactionInsights {
  const events = [...input.events].sort((a, b) => a.ts - b.ts || (a.seq ?? 0) - (b.seq ?? 0));
  const steps = [...input.steps].sort((a, b) => a.stepIndex - b.stepIndex);
  const isNoise = (s: WhyStep) => (s.noise != null ? s.noise : isNoiseStep(s.message));
  // Attached by call when the event has one, by time when it does not.
  const before = (seq: number, ts: number, ev: CompactionEventInput) =>
    ev.seq != null ? seq < ev.seq : ts > 0 && ts < ev.ts;
  const atOrAfter = (seq: number, ts: number, ev: CompactionEventInput) =>
    ev.seq != null ? seq >= ev.seq : ts >= ev.ts;
  /** The last step produced before `ev`: the boundary of its "before" span. */
  const cutOf = (ev: CompactionEventInput) => {
    let cut = 0;
    for (const r of input.requests) {
      if (r.agentStepIndex != null && before(r.seq, r.ts, ev) && r.agentStepIndex > cut) cut = r.agentStepIndex;
    }
    return cut;
  };

  const out: CompactionWhy[] = [];
  let prev: CompactionEventInput | null = null;
  let prevCut = 0;
  events.forEach((ev, index) => {
    const cut = cutOf(ev);
    const span = steps.filter((s) => s.stepIndex > prevCut && s.stepIndex <= cut);
    const window = input.points.filter(
      (p) => before(p.seq, p.ts, ev) && (!prev || atOrAfter(p.seq, p.ts, prev)),
    );
    const first = window.length ? window.reduce((a, b) => (b.ts < a.ts || (b.ts === a.ts && b.seq < a.seq) ? b : a)) : null;
    const fromTs = prev ? prev.ts : (first?.ts ?? ev.ts);
    const baseTokens = prev ? prev.postTokens : (first?.contextTokens ?? 0);

    let precedingPrompt: CompactionWhy["precedingPrompt"] = null;
    if (ev.precedingPrompt !== undefined) {
      if (ev.precedingPrompt) {
        const text = ev.precedingPrompt;
        const hit = steps
          .filter((s) => s.role === "user" && s.stepIndex <= cut && (s.message === text || (text.endsWith("…") && s.message.startsWith(text.slice(0, -1)))))
          .pop();
        precedingPrompt = { text, stepIndex: hit ? hit.stepIndex : null };
      }
    } else {
      const hit = steps.filter((s) => s.role === "user" && s.stepIndex <= cut && s.message.trim() && !isNoise(s)).pop();
      if (hit) precedingPrompt = { text: hit.message, stepIndex: hit.stepIndex };
    }

    const topToolResults = span
      .filter((s) => s.observation)
      .map((s) => ({ ...item(s.stepIndex, s.observation.length, s.observation), tool: s.toolName || "(unknown tool)" }))
      .sort((a, b) => b.chars - a.chars || a.stepIndex - b.stepIndex)
      .slice(0, TOP_TOOL_RESULTS);
    let largestUser: WhyItem | null = null;
    let largestAssistant: WhyItem | null = null;
    for (const s of span) {
      if (s.role === "user") {
        // Noise steps count here: a system reminder fills context like anything else.
        if (s.message.length && (!largestUser || s.message.length > largestUser.chars)) {
          largestUser = item(s.stepIndex, s.message.length, s.message);
        }
      } else if (s.role === "agent") {
        const chars = s.message.length + s.reasoning.length + s.toolInput.length;
        if (chars && (!largestAssistant || chars > largestAssistant.chars)) {
          largestAssistant = item(s.stepIndex, chars, s.message || s.reasoning || s.toolInput);
        }
      }
    }

    out.push({
      index,
      seq: ev.seq,
      ts: ev.ts,
      trigger: ev.trigger || "unknown",
      triggerSource: ev.triggerSource,
      userContext: ev.userContext ?? null,
      precedingPrompt,
      preTokens: ev.preTokens,
      postTokens: ev.postTokens,
      droppedTokens: ev.preTokens - ev.postTokens,
      durationMs: ev.durationMs ?? null,
      preservedMessages: ev.preservedMessages ?? null,
      growth: {
        since: prev ? "previous compaction" : "session start",
        fromTs,
        calls: window.length,
        wallMs: Math.max(0, Math.round((ev.ts - fromTs) * 1000)),
        tokens: ev.preTokens - baseTokens,
      },
      topToolResults,
      largestUser,
      largestAssistant,
    });
    prev = ev;
    prevCut = cut;
  });

  return { source: input.source, scope: input.scope, subagentOnly: input.subagentOnly, compactions: out };
}
