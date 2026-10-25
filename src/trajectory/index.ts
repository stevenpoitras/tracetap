import type { RawPair } from "../types";
import type {
  AgentAdapter,
  NormalizedUsage,
  Step,
  StepMetrics,
  ToolCall,
  Trajectory,
  TrajectoryMetrics,
  WireItem,
} from "./types";
import { AnthropicAdapter } from "./anthropic";
import { OpenAIAdapter } from "./openai";
import { GeminiAdapter } from "./gemini";
import { DevinAdapter } from "./devin";

export * from "./types";
export { AnthropicAdapter } from "./anthropic";
export { OpenAIAdapter } from "./openai";
export { GeminiAdapter } from "./gemini";
export { DevinAdapter } from "./devin";

/**
 * Registered wire-format adapters, checked in order. Mirrors hivemind's
 * `extractors/index.ts`: one shared model + thin per-agent adapters dispatched
 * by wire format. OpenAI is checked first because its `input[]` shape is the
 * narrower signal; Gemini's `contents[]` is likewise distinct from Anthropic's
 * `messages[]`.
 */
const ADAPTERS: AgentAdapter[] = [
  // Devin first: its `provider: "devin"` marker is strict, and checking it
  // ahead of Anthropic guarantees the synthetic `transcript[]` wire is never
  // mistaken for the Messages API's `messages[]`.
  new DevinAdapter(),
  new OpenAIAdapter(),
  new GeminiAdapter(),
  new AnthropicAdapter(),
];

function adapterFor(pair: RawPair): AgentAdapter | null {
  for (const adapter of ADAPTERS) {
    if (adapter.matches(pair)) return adapter;
  }
  return null;
}

/**
 * The conversation id {@link groupPairs} would file this pair under, or null
 * when no adapter recognizes it.
 *
 * Exposed so a caller that wants ONE conversation out of a multi-conversation
 * log can test each pair as it is parsed and drop the rest, instead of building
 * every group to throw all but one away. On a live 888 MB capture holding 40
 * conversations that is the difference between peak memory scaling with the
 * file and scaling with the answer.
 */
export function conversationIdOf(pair: RawPair): string | null {
  const adapter = adapterFor(pair);
  return adapter ? adapter.conversationKey(pair) : null;
}

/**
 * One conversation's worth of captured pairs: the adapter that recognized
 * them, the stable session id (conversation grouping key), and the pairs in
 * capture order. Exposed so consumers that need per-PAIR detail (the store's
 * wire-metrics indexing, request waterfalls) can reuse the exact grouping
 * `buildTrajectories` uses instead of reimplementing it.
 */
export interface PairGroup {
  adapter: AgentAdapter;
  sessionId: string;
  /** {@link AgentAdapter.weakConversationKey} for this group's key. */
  weakKey: boolean;
  pairs: RawPair[];
}

/**
 * Partition a flat list of captured pairs by wire format, then group into
 * conversations, preserving first-seen order of conversation keys.
 */
export function groupPairs(pairs: RawPair[]): PairGroup[] {
  if (!Array.isArray(pairs) || pairs.length === 0) return [];

  const buckets: { adapter: AgentAdapter; keys: string[]; groups: Map<string, RawPair[]> }[] = [];
  const bucketByAdapter = new Map<string, (typeof buckets)[number]>();

  for (const pair of pairs) {
    const adapter = adapterFor(pair);
    if (!adapter) continue;
    let bucket = bucketByAdapter.get(adapter.name);
    if (!bucket) {
      bucket = { adapter, keys: [], groups: new Map() };
      bucketByAdapter.set(adapter.name, bucket);
      buckets.push(bucket);
    }
    const key = adapter.conversationKey(pair);
    let group = bucket.groups.get(key);
    if (!group) {
      group = [];
      bucket.groups.set(key, group);
      bucket.keys.push(key);
    }
    group.push(pair);
  }

  const out: PairGroup[] = [];
  for (const bucket of buckets) {
    for (const key of bucket.keys) {
      const groupPairs = bucket.groups.get(key)!;
      out.push({
        adapter: bucket.adapter,
        sessionId: key,
        weakKey: bucket.adapter.weakConversationKey(groupPairs[0]),
        pairs: groupPairs,
      });
    }
  }
  return out;
}

/**
 * Lift a flat list of captured request/response {@link RawPair}s into
 * agent-agnostic {@link Trajectory}s.
 *
 * Pairs are partitioned by wire format, then grouped into conversations. Within
 * a conversation the pairs are walked in order: each pair's response becomes one
 * agent step, and the tool_result blocks carried by the NEXT pair's request are
 * stitched onto the observation of the matching tool call in the prior step
 * (tool results live in the following API call, not the one that emitted the
 * call). Token usage is summed per step and per trajectory.
 */
export function buildTrajectories(pairs: RawPair[]): Trajectory[] {
  return groupPairs(pairs).map((g) => buildOne(g.adapter, g.sessionId, g.pairs));
}

/**
 * Build one conversation's {@link Trajectory} from an already-formed
 * {@link PairGroup}. Lets callers that need BOTH per-pair detail and the
 * trajectory (e.g. the store's indexer) group once instead of twice.
 */
export function buildTrajectory(group: PairGroup): Trajectory {
  return buildOne(group.adapter, group.sessionId, group.pairs);
}

function buildOne(adapter: AgentAdapter, sessionId: string, pairs: RawPair[]): Trajectory {
  const steps: Step[] = [];
  const toolCallStepById = new Map<string, Step>();
  // Each replayed category is tracked independently. User prompts and
  // tool_results are reliably replayed in every subsequent request, but some
  // agents (e.g. Gemini) omit reasoning parts from history — so a single
  // positional cursor over ALL request items would drift by the number of
  // dropped items and misattribute observations. Assistant text, reasoning and
  // tool_call items are sourced from the responses below and skipped here.
  //
  // Neither tracker is a monotonic positional cursor: real Claude sessions
  // RESET the resent transcript (auto-compaction re-sends just the summary,
  // `/clear` starts over), and a high-water-mark cursor silently dropped every
  // prompt and tool_result after the first reset until the new transcript
  // outgrew the old one.
  const users = new UserMessageTracker();
  const results = new ToolResultTracker();

  for (const pair of pairs) {
    const reqItems = adapter.parseRequestItems(pair);
    const ts = requestTimestamp(pair);

    const resultItems: { sourceCallId: string; content: string }[] = [];
    for (const item of reqItems) if (item.kind === "tool_result") resultItems.push(item);

    // Results first, as before: they answer calls from the PREVIOUS response,
    // and a new user prompt in this request follows them in the transcript.
    for (const r of results.fresh(resultItems)) {
      stitchObservation(r.step, toolCallStepById, steps, r.sourceCallId, r.content);
    }
    for (const text of users.fresh(reqItems)) {
      if (text.trim()) steps.push(makeUserStep(text, ts));
    }

    const resp = adapter.parseResponse(pair);
    if (resp.items.length > 0 || resp.usage) {
      const step = registerAgentStep(resp.items, resp.usage, ts, toolCallStepById);
      results.registerCalls(step);
      users.observeResponse(resp.items);
      steps.push(step);
    }
  }

  steps.forEach((s, i) => (s.index = i + 1));
  return {
    sessionId,
    agent: adapter.agentInfo(pairs[pairs.length - 1] ?? pairs[0]),
    steps,
    metrics: rollupMetrics(steps),
  };
}

function registerAgentStep(
  items: WireItem[],
  usage: NormalizedUsage | null,
  timestamp: number,
  toolCallStepById: Map<string, Step>,
): Step {
  const step = makeAgentStep(items, usage, timestamp);
  for (const tc of step.toolCalls) {
    if (tc.id) toolCallStepById.set(tc.id, step);
  }
  return step;
}

function makeAgentStep(items: WireItem[], usage: NormalizedUsage | null, timestamp: number): Step {
  const messageParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const item of items) {
    if (item.kind === "message" && item.role === "assistant") {
      if (item.text) messageParts.push(item.text);
    } else if (item.kind === "reasoning") {
      if (item.text) reasoningParts.push(item.text);
    } else if (item.kind === "tool_call") {
      toolCalls.push({ id: item.id, name: item.name, arguments: item.arguments });
    }
  }

  const step: Step = {
    index: 0,
    role: "agent",
    message: messageParts.join(""),
    toolCalls,
    timestamp,
  };
  const reasoning = reasoningParts.join("");
  if (reasoning) step.reasoningContent = reasoning;
  if (usage) step.metrics = toStepMetrics(usage);
  return step;
}

function makeUserStep(text: string, timestamp: number): Step {
  return { index: 0, role: "user", message: text, toolCalls: [], timestamp };
}

/**
 * Decides which user messages in a request's resent transcript are NEW.
 *
 * Rule: the new user messages are the ones after the request's ANCHOR — the
 * last assistant-side item (assistant text, reasoning, tool_call) in it that we
 * saw come back in a captured response under this key. Everything before the
 * anchor was already in the transcript when that response was produced, so its
 * prompts were emitted then (or predate the capture). Without any recognised
 * anchor every user message is new: the first call, a capture that began
 * mid-session (its replayed history is all we will ever see of it), a
 * compaction summary, a `/clear`, a subagent's first call.
 *
 * This is stateless with respect to transcript SHAPE, which is the point: it
 * does not care whether the transcript grew, shrank or reset, nor whether
 * several lineages (parallel same-type subagents sharing system+model)
 * interleave under one conversation key. Anchoring on captured responses rather
 * than on any assistant item matters for Gemini, which omits reasoning from
 * history, and for a response that was never captured.
 *
 * One stateful guard against replays: tails are remembered per anchor, and
 * only the part past an already-emitted tail is new. With an anchor, that
 * covers a retried request (the first attempt got no reply). Without one, the
 * longest prefix shared with ANY earlier anchorless tail is skipped — this
 * collapses identical or prefix-growing single-shot side calls, at the cost
 * of not re-emitting an identical prompt typed again after `/clear`.
 */
class UserMessageTracker {
  private known = new Set<string>();
  private tails = new Map<string, TailEntry[]>();
  private last: TailEntry | null = null;

  observeResponse(items: WireItem[]): void {
    if (this.last && items.length > 0) this.last.answered = true;
    this.last = null;
    for (const it of items) {
      const sig = anchorSignature(it);
      if (sig) this.known.add(sig);
    }
  }

  /** The user-message texts in `items` to emit as new user steps. */
  fresh(items: WireItem[]): string[] {
    this.last = null;
    let anchor = -1;
    let sig = "";
    for (let i = items.length - 1; i >= 0; i--) {
      const s = anchorSignature(items[i]);
      if (s && this.known.has(s)) {
        anchor = i;
        sig = s;
        break;
      }
    }
    const tail: string[] = [];
    // Assistant output after the anchor that we never saw come back (a reply
    // replayed with different text, an uncaptured response): the transcript
    // moved on from the anchor, so an earlier tail it extends was emitted.
    let movedOn = false;
    for (let i = anchor + 1; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "message" && it.role === "user") tail.push(it.text);
      else if (anchorSignature(it)) movedOn = true;
    }
    if (tail.length === 0) return tail;

    const key = anchor < 0 ? "none" : anchor + "@" + sig;
    let seen = this.tails.get(key);
    if (!seen) this.tails.set(key, (seen = []));
    let skip = 0;
    for (const prior of seen) {
      const p = prior.tail;
      if (anchor < 0) {
        // No anchor: a fresh transcript. Single-shot side calls (Claude Code's
        // auto-mode security monitor, classifiers) re-send a growing prefix of
        // context blocks each call, and parallel subagents share a header —
        // only what is past the longest prefix already emitted is new.
        skip = Math.max(skip, commonPrefix(p, tail));
        continue;
      }
      // A prior tail that got a reply, replayed with no sign of that reply, is
      // a rewind to before that reply, not a retry: its prompts are new again.
      if (prior.answered && !movedOn) continue;
      if (p.length > skip && p.length <= tail.length && isPrefix(p, tail)) skip = p.length;
    }
    const entry: TailEntry = { tail, answered: false };
    seen.push(entry);
    this.last = entry;
    return tail.slice(skip);
  }
}

interface TailEntry {
  tail: string[];
  answered: boolean;
}

/** Identity of an assistant-side item, for matching a request item to a response. */
function anchorSignature(it: WireItem): string | null {
  if (it.kind === "tool_call") return it.id ? "c:" + it.id + ":" + it.name : null;
  if (it.kind === "message" && it.role === "assistant") return it.text ? "m:" + it.text : null;
  if (it.kind === "reasoning") return it.text ? "r:" + it.text : null;
  return null;
}

function commonPrefix(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  let k = 0;
  while (k < n && a[k] === b[k]) k++;
  return k;
}

function isPrefix(a: string[], b: string[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Decides which tool_results in a request's resent transcript are NEW, by
 * the tool calls still awaiting a result rather than by position — so a
 * transcript reset (compaction, `/clear`) can't hide the results that follow
 * it, and a carried tail can't re-stitch results already attached.
 *
 * Ids are not always unique (Gemini falls back to the function NAME when a
 * call has no id), so a call id maps to a FIFO of awaiting steps, and of the
 * `n` results carrying an id in one request only the trailing `pending` ones
 * are new: a resent transcript replays old results before new ones.
 * Limitation: with name-as-id, two interleaved lineages calling the same tool
 * share one FIFO, so a result can land on the other lineage's call of that
 * name. Unique ids (Anthropic, OpenAI, Devin, Gemini with ids) are unaffected.
 *
 * Results whose id never matched a captured call (capture began mid-session)
 * still attach best-effort, once per id; results with no id at all are keyed
 * by their ordinal and content.
 */
class ToolResultTracker {
  private pending = new Map<string, Step[]>();
  private everCalled = new Set<string>();
  private orphansSeen = new Set<string>();

  registerCalls(step: Step): void {
    for (const tc of step.toolCalls) {
      if (!tc.id) continue;
      this.everCalled.add(tc.id);
      let q = this.pending.get(tc.id);
      if (!q) this.pending.set(tc.id, (q = []));
      q.push(step);
    }
  }

  fresh(
    items: { sourceCallId: string; content: string }[],
  ): { step: Step | null; sourceCallId: string; content: string }[] {
    const total = new Map<string, number>();
    for (const it of items) total.set(it.sourceCallId, (total.get(it.sourceCallId) ?? 0) + 1);
    const seenSoFar = new Map<string, number>();
    const awaiting = new Map<string, number>();
    for (const [id] of total) awaiting.set(id, this.pending.get(id)?.length ?? 0);

    const out: { step: Step | null; sourceCallId: string; content: string }[] = [];
    let emptyOrdinal = 0;
    for (const it of items) {
      const id = it.sourceCallId;
      const ordinal = seenSoFar.get(id) ?? 0;
      seenSoFar.set(id, ordinal + 1);
      if (id && this.everCalled.has(id)) {
        const n = total.get(id)!;
        if (ordinal >= n - awaiting.get(id)!) {
          const step = this.pending.get(id)!.shift() ?? null;
          out.push({ step, sourceCallId: id, content: it.content });
        }
        continue;
      }
      const key = id ? "id:" + id : "empty:" + emptyOrdinal++ + ":" + it.content;
      if (this.orphansSeen.has(key)) continue;
      this.orphansSeen.add(key);
      out.push({ step: null, sourceCallId: id, content: it.content });
    }
    return out;
  }
}

function stitchObservation(
  matched: Step | null,
  toolCallStepById: Map<string, Step>,
  steps: Step[],
  sourceCallId: string,
  content: string,
): void {
  let step = matched ?? toolCallStepById.get(sourceCallId);
  if (!step) {
    // Best-effort fallback: attach to the most recent agent step so result
    // content is never lost (well-formed logs always have a match).
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].role === "agent") {
        step = steps[i];
        break;
      }
    }
  }
  if (!step) return;
  if (!step.observation) step.observation = { results: [] };
  step.observation.results.push({ sourceCallId, content });
}

function toStepMetrics(u: NormalizedUsage): StepMetrics {
  const m: StepMetrics = {
    promptTokens: u.promptTokens,
    completionTokens: u.completionTokens,
    cacheCreationTokens: u.cacheCreationTokens,
    cacheReadTokens: u.cacheReadTokens,
  };
  if (u.reasoningTokens !== undefined) m.reasoningTokens = u.reasoningTokens;
  return m;
}

function rollupMetrics(steps: Step[]): TrajectoryMetrics {
  const total: TrajectoryMetrics = {
    promptTokens: 0,
    completionTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
  let anyReasoning = false;
  let reasoning = 0;
  for (const step of steps) {
    const m = step.metrics;
    if (!m) continue;
    total.promptTokens += m.promptTokens;
    total.completionTokens += m.completionTokens;
    total.cacheCreationTokens += m.cacheCreationTokens;
    total.cacheReadTokens += m.cacheReadTokens;
    if (m.reasoningTokens !== undefined) {
      anyReasoning = true;
      reasoning += m.reasoningTokens;
    }
  }
  if (anyReasoning) total.reasoningTokens = reasoning;
  return total;
}

function requestTimestamp(pair: RawPair): number {
  const t = pair?.request?.timestamp;
  return typeof t === "number" && Number.isFinite(t) ? t : 0;
}
