/**
 * Per-API-call context size point for the session timeline.
 * Compaction annotations carry explicit pre/post sizes.
 */
export interface ContextTimelineRequest {
  seq: number;
  ts: number;
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

/**
 * A compaction must shrink BOTH the transcript and the context.
 *
 * Testing item count alone reported 85 compactions in an 8m55s session, of
 * which 30 showed context GROWING across the "compaction" (146,698 → 160,698
 * tokens). The cause is that a session interleaves a main thread with its
 * subagents, so `requests[i-1]` is frequently a different conversation
 * entirely and the item count just hops between them — the same phantom
 * appeared repeatedly as "items 9 → 7" at calls #17, #19 and #22.
 *
 * Requiring the measured size to fall as well is not a threshold or a fudge
 * factor: dropping turns that does not reduce what the model reads is, by
 * definition, not a compaction. It cannot separate interleaved threads on its
 * own — that needs per-agent identity — so `outOfOrderPairs` reports when the
 * caveat applies.
 */
export function findCompactions(
  requests: ContextTimelineRequest[],
): { seq: number; from: number; to: number }[] {
  const out: { seq: number; from: number; to: number }[] = [];
  for (let i = 1; i < requests.length; i++) {
    const prev = requests[i - 1];
    const cur = requests[i];
    const itemsFell = prev.transcriptItems > 0 && cur.transcriptItems < prev.transcriptItems;
    const contextFell = contextTokensOf(cur) < contextTokensOf(prev);
    if (itemsFell && contextFell) {
      out.push({ seq: cur.seq, from: prev.transcriptItems, to: cur.transcriptItems });
    }
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
  const reqs = [...opts.requests].sort((a, b) => a.seq - b.seq);
  const compactBySeq = new Map(findCompactions(reqs).map((c) => [c.seq, c] as const));
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

    const c = compactBySeq.get(r.seq);
    if (c && i > 0) {
      const prev = points[i - 1];
      const prevReq = reqs[i - 1];
      const preContext = contextTokensOf(prevReq);
      const postContext = contextTokensOf(r);
      point.compaction = {
        fromItems: c.from,
        toItems: c.to,
        droppedItems: c.from - c.to,
        preContextTokens: preContext,
        postContextTokens: postContext,
        droppedTokens: preContext - postContext,
        preApproxTokens: prev?.approxTokens ?? preContext,
        postApproxTokens: approxTokens,
      };
    }

    if (point.contextTokens > peakContext) peakContext = point.contextTokens;
    if (approxTokens > peakApprox) peakApprox = approxTokens;
    points.push(point);
  }

  return {
    points,
    compactionCount: compactBySeq.size,
    peakContextTokens: peakContext,
    peakApproxTokens: peakApprox,
    outOfOrderPairs: countOutOfOrder(reqs),
  };
}
