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

/**
 * Did this compaction pay for itself?
 *
 * Reclaiming context is not free: dropping transcript items invalidates the
 * prompt-cache prefix, so the next call re-writes the surviving prefix at
 * cache-write price. `cache_creation` is the observable for that.
 *
 * Attribution caveat — `cache_creation` is NOT purely caused by compaction.
 * Every call that appends new material writes some cache, so a nonzero
 * `cache_creation` on a compaction call is partly ordinary growth. What makes
 * the cost attributable is the *spike*: see {@link cacheRebuildBaseline}.
 */
export interface CompactionEfficacy {
  /** preApproxTokens - postApproxTokens (never negative). */
  reclaimedTokens: number;
  /** reclaimed / preApproxTokens * 100, 1dp. */
  reclaimedPct: number;
  /** Raw `cache_creation` on the compaction call. */
  cacheRebuildTokens: number;
  /** `cache_read` on the call immediately before the compaction. */
  cacheReadBefore: number;
  /** `cache_read` on the compaction call. */
  cacheReadAfter: number;
  /** Calls after this one until ctx >= preApproxTokens; null = never regrew. */
  callsToRegrow: number | null;
  verdict: "negative" | "marginal" | "positive";
  /** One human sentence explaining the verdict. */
  verdictReason: string;
}

export interface CompactionTrigger {
  kind: "auto" | "manual" | "unknown";
  source: "hook" | "inferred";
  hookTs?: number;
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
    efficacy: CompactionEfficacy;
    trigger?: CompactionTrigger;
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

export function findCompactions(
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

/** How many calls either side of a compaction form its cache-cost baseline. */
export const CACHE_BASELINE_WINDOW = 5;

/** A compaction reclaiming less than this is treated as noise, not a win. */
const TRIVIAL_RECLAIM_TOKENS = 500;

/** callsToRegrow at or below this means the reclaim did not last. */
const SHORT_LIVED_CALLS = 5;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Ordinary per-call cache-write cost around index `i`, used to separate the
 * compaction's re-cache from the cache writes any growing conversation pays.
 *
 * Why the median of a *window* and not the immediately preceding call: on real
 * sessions the preceding call is sometimes itself a full prefix rebuild (model
 * switch, cache TTL expiry, a 429 retry), and its `cache_creation` can exceed
 * the compaction's own. Baselining against that single value reports the
 * compaction as free, which is plainly wrong. It is also why a
 * `cacheRebuild - cacheReadBefore` framing is unusable: `cache_read` sits an
 * order of magnitude above `cache_creation` on a warm session, so subtracting
 * it zeroes every compaction.
 *
 * The median over a window that excludes other compactions is robust to both:
 * non-compaction `cache_creation` is tightly clustered (hundreds to low
 * thousands) with only a handful of rebuild outliers, so a couple of spikes in
 * the window cannot move it.
 */
function cacheRebuildBaseline(
  reqs: ContextTimelineRequest[],
  i: number,
  isCompaction: (seq: number) => boolean,
): number {
  const sample: number[] = [];
  for (let j = i - CACHE_BASELINE_WINDOW; j <= i + CACHE_BASELINE_WINDOW; j++) {
    if (j < 0 || j >= reqs.length || j === i) continue;
    const r = reqs[j];
    if (isCompaction(r.seq) || r.errored) continue;
    sample.push(r.cacheCreation);
  }
  return median(sample);
}

/**
 * `cache_creation` to cost a compaction on. Normally the compaction call's own,
 * but a call that failed before doing any work (429, connection reset) records
 * no usage at all — the prefix is still rebuilt, on the retry. Rolling forward
 * to the first call that actually ran keeps that cost visible instead of
 * reporting the compaction as free.
 */
function rebuildCostFor(reqs: ContextTimelineRequest[], i: number): number {
  const r = reqs[i];
  if (!(r.errored && r.cacheCreation === 0 && r.cacheRead === 0)) return r.cacheCreation;
  for (let j = i + 1; j < reqs.length && j <= i + CACHE_BASELINE_WINDOW; j++) {
    if (!reqs[j].errored) return reqs[j].cacheCreation;
  }
  return r.cacheCreation;
}

/** Calls after `i` until context is back at `target`; null = never regrew. */
function callsToRegrow(sizes: number[], i: number, target: number): number | null {
  for (let j = i + 1; j < sizes.length; j++) {
    if (sizes[j] >= target) return j - i;
  }
  return null;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}K`;
}

/**
 * Verdict for one compaction, from what it reclaimed against what the re-cache
 * cost above the ambient baseline.
 *
 * Deliberately conservative about claiming a win: `attributableRebuild` is a
 * lower bound on the true cost (it ignores knock-on re-cache on later calls),
 * and a reclaim that is regrown within a handful of calls bought nothing
 * durable even when the arithmetic nets out positive.
 */
export function computeCompactionEfficacy(input: {
  reclaimedTokens: number;
  preApproxTokens: number;
  cacheRebuildTokens: number;
  cacheReadBefore: number;
  cacheReadAfter: number;
  /** Ambient per-call cache_creation near this compaction. */
  cacheBaseline: number;
  callsToRegrow: number | null;
  /**
   * cache_creation to *cost* the compaction on, when that is not the value
   * reported in `cacheRebuildTokens`. Only differs when the compaction call
   * itself failed before doing any work (a 429, say): it then records zero
   * usage and the re-cache lands on the retry instead. Defaults to
   * `cacheRebuildTokens`.
   */
  rebuildCostTokens?: number;
}): CompactionEfficacy {
  const reclaimedTokens = Math.max(0, Math.round(input.reclaimedTokens));
  const reclaimedPct =
    input.preApproxTokens > 0
      ? Math.round((reclaimedTokens / input.preApproxTokens) * 1000) / 10
      : 0;
  // The share of cache_creation that the compaction itself is answerable for.
  const rebuildCost = input.rebuildCostTokens ?? input.cacheRebuildTokens;
  const attributableRebuild = Math.max(0, rebuildCost - input.cacheBaseline);
  const regrow = input.callsToRegrow;

  let verdict: CompactionEfficacy["verdict"];
  let verdictReason: string;
  if (reclaimedTokens < attributableRebuild) {
    verdict = "negative";
    verdictReason = `reclaimed ${fmtTokens(reclaimedTokens)} tokens but paid ~${fmtTokens(
      attributableRebuild,
    )} to rebuild the prompt cache`;
  } else if (reclaimedTokens < TRIVIAL_RECLAIM_TOKENS) {
    verdict = "negative";
    verdictReason = `reclaimed only ${fmtTokens(reclaimedTokens)} tokens (${reclaimedPct}% of context)`;
  } else if (regrow !== null && regrow <= SHORT_LIVED_CALLS) {
    verdict = "marginal";
    verdictReason = `reclaimed ${fmtTokens(reclaimedTokens)} tokens (${reclaimedPct}%) but context was back to its old size within ${regrow} call${regrow === 1 ? "" : "s"}`;
  } else {
    verdict = "positive";
    verdictReason =
      regrow === null
        ? `reclaimed ${fmtTokens(reclaimedTokens)} tokens (${reclaimedPct}%) for ~${fmtTokens(attributableRebuild)} of cache rebuild, and context never regrew`
        : `reclaimed ${fmtTokens(reclaimedTokens)} tokens (${reclaimedPct}%) for ~${fmtTokens(attributableRebuild)} of cache rebuild, holding for ${regrow} calls`;
  }

  return {
    reclaimedTokens,
    reclaimedPct,
    cacheRebuildTokens: input.cacheRebuildTokens,
    cacheReadBefore: input.cacheReadBefore,
    cacheReadAfter: input.cacheReadAfter,
    callsToRegrow: regrow,
    verdict,
    verdictReason,
  };
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
  /**
   * seq → what triggered the compaction, resolved from the hooks store by the
   * caller. Absent seqs stay untriggered rather than being guessed at.
   */
  triggersBySeq?: Map<number, CompactionTrigger>;
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
        // Filled in below: callsToRegrow needs the whole timeline.
        efficacy: undefined as unknown as CompactionEfficacy,
      };
    }

    if (r.promptTokens > peakPrompt) peakPrompt = r.promptTokens;
    if (approxTokens > peakApprox) peakApprox = approxTokens;
    points.push(point);
  }

  // Second pass: efficacy is a function of what happened *after* the
  // compaction, so it cannot be settled while the timeline is still being laid
  // down.
  const sizes = points.map((p) => p.approxTokens);
  const isCompaction = (seq: number) => compactBySeq.has(seq);
  for (let i = 0; i < points.length; i++) {
    const comp = points[i].compaction;
    if (!comp) continue;
    comp.efficacy = computeCompactionEfficacy({
      reclaimedTokens: comp.preApproxTokens - comp.postApproxTokens,
      preApproxTokens: comp.preApproxTokens,
      cacheRebuildTokens: reqs[i].cacheCreation,
      cacheReadBefore: reqs[i - 1]?.cacheRead ?? 0,
      cacheReadAfter: reqs[i].cacheRead,
      cacheBaseline: cacheRebuildBaseline(reqs, i, isCompaction),
      callsToRegrow: callsToRegrow(sizes, i, comp.preApproxTokens),
      rebuildCostTokens: rebuildCostFor(reqs, i),
    });
    // No hook match means the trigger is genuinely unknown. Nothing on the
    // wire distinguishes an auto compaction from a user-typed /compact, so
    // this stays "unknown" rather than being inferred into a guess.
    comp.trigger = opts.triggersBySeq?.get(reqs[i].seq) ?? {
      kind: "unknown",
      source: "inferred",
    };
  }

  return {
    points,
    compactionCount: compactBySeq.size,
    peakPromptTokens: peakPrompt,
    peakApproxTokens: peakApprox,
  };
}
