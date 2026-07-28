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
  promptTokens: number;
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
    prePromptTokens: number;
    postPromptTokens: number;
    preApproxTokens: number;
    postApproxTokens: number;
  };
  /** Bucket → approx token counts (when body was parsed). */
  buckets?: Record<string, number>;
}

export interface ContextTimeline {
  points: ContextTimelinePoint[];
  compactionCount: number;
  peakPromptTokens: number;
  peakApproxTokens: number;
}

/** Context composition for one call, as stored at index time. */
export interface ContextMetrics {
  totalChars: number;
  totalApproxTokens: number;
  buckets: Record<string, number>;
}

function findCompactions(
  requests: ContextTimelineRequest[],
): { seq: number; from: number; to: number }[] {
  const out: { seq: number; from: number; to: number }[] = [];
  for (let i = 1; i < requests.length; i++) {
    const prev = requests[i - 1].transcriptItems;
    const cur = requests[i].transcriptItems;
    if (prev > 0 && cur < prev) out.push({ seq: requests[i].seq, from: prev, to: cur });
  }
  return out;
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
  let peakPrompt = 0;
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
      approxTokens = r.promptTokens;
      approxChars = r.promptTokens * 4;
    }

    const point: ContextTimelinePoint = {
      seq: r.seq,
      ts: r.ts,
      model: r.model,
      promptTokens: r.promptTokens,
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
      point.compaction = {
        fromItems: c.from,
        toItems: c.to,
        droppedItems: c.from - c.to,
        prePromptTokens: prevReq.promptTokens,
        postPromptTokens: r.promptTokens,
        preApproxTokens: prev?.approxTokens ?? prevReq.promptTokens,
        postApproxTokens: approxTokens,
      };
    }

    if (r.promptTokens > peakPrompt) peakPrompt = r.promptTokens;
    if (approxTokens > peakApprox) peakApprox = approxTokens;
    points.push(point);
  }

  return {
    points,
    compactionCount: compactBySeq.size,
    peakPromptTokens: peakPrompt,
    peakApproxTokens: peakApprox,
  };
}
