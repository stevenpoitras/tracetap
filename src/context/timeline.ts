/**
 * Per-API-call context size point for the session timeline.
 * Compaction annotations carry explicit pre/post sizes.
 */
export interface ContextTimelineRequest {
  seq: number;
  /** Unix epoch SECONDS. Note the unit mismatch with `durationMs`. */
  ts: number;
  /**
   * Wall-clock duration in MILLISECONDS, or null when not recorded.
   *
   * Needed by compaction detection, not just display: two calls that were in
   * flight at the same instant are provably different conversations, and that
   * is the strongest disqualifier available. Absent it, the detector cannot
   * tell a compaction from a comparison across concurrent agents.
   */
  durationMs?: number | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cacheRead: number;
  cacheCreation: number;
  transcriptItems: number;
  promptHash: string;
  errored: boolean;
}

export interface ContextTimelinePair {
  request?: { body?: unknown };
}

export interface ContextTimelinePoint {
  seq: number;
  ts: number;
  model: string;
  /**
   * Wire `usage.input_tokens` — the UNCACHED remainder only, and therefore
   * almost never the prompt size. On a cached agentic session it is routinely
   * 2. It is a billing quantity, not a size quantity; use `contextTokens`.
   */
  promptTokens: number;
  /**
   * What the model actually read: uncached input + cache read + cache write.
   * This is the only wire-measured context size, and the one the header, the
   * timeline and the compaction cards should quote.
   */
  contextTokens: number;
  completionTokens: number;
  cacheRead: number;
  cacheCreation: number;
  transcriptItems: number;
  /** Approx chars from request body composition (0 when body unavailable). */
  approxChars: number;
  approxTokens: number;
  promptHash: string;
  errored: boolean;
  /** Present when this call shrank the resent transcript vs the previous call. */
  compaction?: {
    fromItems: number;
    toItems: number;
    droppedItems: number;
    preContextTokens: number;
    postContextTokens: number;
    droppedTokens: number;
    preApproxTokens: number;
    postApproxTokens: number;
  };
  /** Bucket → approx token counts (when body was parsed). */
  buckets?: Record<string, number>;
}

export interface ContextTimeline {
  points: ContextTimelinePoint[];
  compactionCount: number;
  peakContextTokens: number;
  peakApproxTokens: number;
  /**
   * Adjacent-by-seq pairs whose timestamps run backwards. Non-zero means the
   * session interleaves concurrent conversations (a main thread plus a fleet
   * of subagents), so neighbouring rows are NOT neighbouring turns and any
   * metric that diffs them — growth, compaction — is comparing across threads.
   * Surfaced rather than silently smoothed: the honest caveat is the finding.
   */
  outOfOrderPairs: number;
}

/** Context composition for one call, as stored at index time. */
export interface ContextMetrics {
  totalChars: number;
  totalApproxTokens: number;
  buckets: Record<string, number>;
}

/** What the model actually read on this call, per the wire. */
export function contextTokensOf(r: ContextTimelineRequest): number {
  return r.promptTokens + r.cacheRead + r.cacheCreation;
}

/** A request's [start, end) in epoch MILLISECONDS (`ts` is seconds). */
function spanMs(r: ContextTimelineRequest): { from: number; to: number } {
  const from = r.ts * 1000;
  return { from, to: from + Math.max(0, r.durationMs ?? 0) };
}

/**
 * The smallest drop a REAL compaction has ever been observed to produce.
 *
 * Not a tuned threshold. Claude Code records every compaction explicitly in its
 * own session transcripts (`~/.claude/projects/**​/*.jsonl`) as
 * `{"subtype":"compact_boundary","compactMetadata":{...}}` carrying exact
 * pre/post token counts. Across 200 such records in 88 files the minimum freed
 * was 24,287 tokens, ZERO freed under 10,000, the median was 186,402, and the
 * median retention ratio was 0.072 — a compaction keeps ~7% and discards the
 * rest. 2,000 sits an order of magnitude below the observed floor, so it
 * rejects artifacts without coming near a real one.
 */
const MIN_COMPACTION_TOKENS = 2000;

/**
 * A compaction must shrink BOTH the transcript and the context, between two
 * calls that could actually have been consecutive turns.
 *
 * Three gates, each earned from a way this was wrong on real data:
 *
 * 1. ITEMS FELL. Alone this reported 85 compactions in an 8m55s session, 30 of
 *    which showed context GROWING across the "compaction".
 *
 * 2. CONTEXT ALSO FELL. Dropping turns that does not reduce what the model
 *    reads is, by definition, not a compaction. Still wrong: 209 detections
 *    across the live index, of which only 53 are real.
 *
 * 3. THE TWO CALLS WERE NOT IN FLIGHT TOGETHER. This is a proof, not a
 *    heuristic. A conversation is strictly sequential — turn N+1 cannot be sent
 *    before turn N returns — so two calls whose spans overlap are provably
 *    different conversations and their diff is meaningless. 81 of 156
 *    survivors overlapped. The tell in the data is a wildly disproportionate
 *    ratio: one pair dropped 16 transcript items while freeing 335 tokens
 *    (real compactions average ~4,351 tokens freed per item dropped; the
 *    artifacts ~422).
 *
 * Callers MUST pass requests in TIME order, which `buildContextTimeline` now
 * does. Ordering by `seq` alone accounted for 53 of the false positives: on one
 * session every reported compaction was this, with items reading 3, 12, 9, 18,
 * 19, 27, 24, 31, 30 by seq and 3, 9, 12, 18, 19, 24, 27, 30, 31 by time —
 * monotonic, never compacted once.
 *
 * This remains INFERENCE. `compact_boundary` in the session transcript is the
 * authority and states the trigger (auto vs manual) outright; nothing here can
 * recover that. See MIN_COMPACTION_TOKENS.
 */
export function findCompactions(
  requests: ContextTimelineRequest[],
): { seq: number; from: number; to: number }[] {
  const out: { seq: number; from: number; to: number }[] = [];
  for (let i = 1; i < requests.length; i++) {
    const prev = requests[i - 1];
    const cur = requests[i];
    const itemsFell = prev.transcriptItems > 0 && cur.transcriptItems < prev.transcriptItems;
    if (!itemsFell) continue;
    const freed = contextTokensOf(prev) - contextTokensOf(cur);
    if (freed < MIN_COMPACTION_TOKENS) continue;
    const a = spanMs(prev);
    const b = spanMs(cur);
    // Overlap ⇒ concurrent ⇒ different conversations ⇒ not a compaction.
    if (b.from < a.to && a.from < b.to) continue;
    out.push({ seq: cur.seq, from: prev.transcriptItems, to: cur.transcriptItems });
  }
  return out;
}

/** Adjacent-by-seq pairs that run backwards in wall-clock time. */
function countOutOfOrder(requests: ContextTimelineRequest[]): number {
  let n = 0;
  for (let i = 1; i < requests.length; i++) {
    if (requests[i].ts < requests[i - 1].ts) n++;
  }
  return n;
}

/**
 * Build a context-size timeline for a session from wire request rows + optional
 * raw pairs (for composition / approx token estimates).
 */
export function buildContextTimeline(opts: {
  requests: ContextTimelineRequest[];
  /** seq → RawPair-like when source JSONL is available. */
  pairsBySeq?: Map<number, ContextTimelinePair>;
  /**
   * seq → composition computed at index time. Preferred over `pairsBySeq`:
   * re-deriving it means reading and segmenting every request body in the
   * session, which is the dominant cost of building this timeline.
   */
  precomputedBySeq?: Map<number, ContextMetrics>;
  /** Optional xray builder injected to avoid circular imports in tests. */
  xrayFor?: (seq: number, pair: ContextTimelinePair, promptHash: string) => {
    totalChars: number;
    totalApproxTokens: number;
    buckets: { bucket: string; approxTokens: number }[];
  };
}): ContextTimeline {
  // The SERIES is ordered by seq — that is the axis the chart and the transcript
  // are indexed on, and renumbering it would break every `ctp:<seq>` link.
  const reqs = [...opts.requests].sort((a, b) => a.seq - b.seq);
  // DETECTION is ordered by time, which is a different question. `seq` is
  // assignment order in the log; concurrent calls finish out of order, so
  // `reqs[i-1]` is routinely a LATER turn. Diffing on that axis produced 53 of
  // the 209 false compactions on the live index all by itself.
  const byTime = [...opts.requests].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  const compactBySeq = new Map(findCompactions(byTime).map((c) => [c.seq, c] as const));
  // seq → the call that PRECEDED it in time. A compaction's "before" size has
  // to come from the call it was detected against, and that is this one, not
  // whatever happens to sit at `reqs[i-1]`.
  const timePredecessor = new Map<number, ContextTimelineRequest>();
  for (let i = 1; i < byTime.length; i++) timePredecessor.set(byTime[i].seq, byTime[i - 1]);
  const points: ContextTimelinePoint[] = [];
  let peakContext = 0;
  let peakApprox = 0;

  for (let i = 0; i < reqs.length; i++) {
    const r = reqs[i];
    const pair = opts.pairsBySeq?.get(r.seq);
    let approxChars = 0;
    let approxTokens = 0;
    let buckets: Record<string, number> | undefined;
    const pre = opts.precomputedBySeq?.get(r.seq);
    if (pre) {
      approxChars = pre.totalChars;
      approxTokens = pre.totalApproxTokens;
      buckets = pre.buckets;
    } else if (pair && opts.xrayFor) {
      const xray = opts.xrayFor(r.seq, pair, r.promptHash);
      approxChars = xray.totalChars;
      approxTokens = xray.totalApproxTokens;
      buckets = {};
      for (const b of xray.buckets) buckets[b.bucket] = b.approxTokens;
    } else {
      // No body to segment. Fall back to the wire's own size rather than to
      // `promptTokens`, which under caching is the uncached remainder (~2) and
      // would flatten the whole series to nothing.
      approxTokens = contextTokensOf(r);
      approxChars = approxTokens * 4;
    }

    const point: ContextTimelinePoint = {
      seq: r.seq,
      ts: r.ts,
      model: r.model,
      promptTokens: r.promptTokens,
      contextTokens: contextTokensOf(r),
      completionTokens: r.completionTokens,
      cacheRead: r.cacheRead,
      cacheCreation: r.cacheCreation,
      transcriptItems: r.transcriptItems,
      approxChars,
      approxTokens,
      promptHash: r.promptHash,
      errored: r.errored,
      buckets,
    };

    if (point.contextTokens > peakContext) peakContext = point.contextTokens;
    if (approxTokens > peakApprox) peakApprox = approxTokens;
    points.push(point);
  }

  // Compaction annotation is a SECOND pass: the "before" call is the time
  // predecessor, which may sit later in seq order and so may not have had its
  // point built yet during the first pass.
  const pointBySeq = new Map(points.map((p) => [p.seq, p] as const));
  for (const point of points) {
    const c = compactBySeq.get(point.seq);
    if (!c) continue;
    const prevReq = timePredecessor.get(point.seq);
    if (!prevReq) continue;
    const preContext = contextTokensOf(prevReq);
    const postContext = point.contextTokens;
    point.compaction = {
      fromItems: c.from,
      toItems: c.to,
      droppedItems: c.from - c.to,
      preContextTokens: preContext,
      postContextTokens: postContext,
      droppedTokens: preContext - postContext,
      preApproxTokens: pointBySeq.get(prevReq.seq)?.approxTokens ?? preContext,
      postApproxTokens: point.approxTokens,
    };
  }

  return {
    points,
    compactionCount: compactBySeq.size,
    peakContextTokens: peakContext,
    peakApproxTokens: peakApprox,
    outOfOrderPairs: countOutOfOrder(reqs),
  };
}
