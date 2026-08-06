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
    efficacy: CompactionEfficacy;
    trigger?: CompactionTrigger;
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

/**
 * What the model actually read on this call, per the wire: uncached input +
 * cache reads + cache writes.
 *
 * `promptTokens` alone is Anthropic `usage.input_tokens`, which EXCLUDES the
 * cached prefix — on a warm session it is a few hundred tokens while the real
 * context is 100K+ sitting in `cache_read`. Any fallback standing in for an
 * approx context size must use this composition, or a timeline mixing
 * precomputed (~150K-scale) and fallback (~300-scale) points fabricates
 * compaction reclaims and breaks callsToRegrow.
 */
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

/** How many calls either side of a compaction form its cache-cost baseline. */
export const CACHE_BASELINE_WINDOW = 5;

/** A compaction reclaiming less than this is treated as noise, not a win. */
const TRIVIAL_RECLAIM_TOKENS = 500;

/** callsToRegrow at or below this means the reclaim did not last. */
const SHORT_LIVED_CALLS = 5;

/**
 * The reclaim side of the verdict is a chars/4 estimate while the rebuild side
 * is wire-exact `cache_creation` tokens. Code-heavy contexts tokenize nearer
 * 3.3 chars/token, so chars/4 under-counts the reclaim by up to ~20% relative
 * to the wire cost. A comparison inside that band cannot honestly be called
 * "negative" — it is treated as roughly break-even instead of letting the
 * estimation skew flip a compaction that actually paid for itself.
 */
const RECLAIM_ESTIMATE_TOLERANCE = 0.2;

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
 *
 * Equally conservative about claiming a loss: the reclaim is a chars/4
 * estimate compared against wire cache tokens, so a shortfall inside
 * {@link RECLAIM_ESTIMATE_TOLERANCE} is reported as "marginal" (an estimated
 * break-even), not "negative".
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
  if (reclaimedTokens * (1 + RECLAIM_ESTIMATE_TOLERANCE) < attributableRebuild) {
    // Clearly under water even after granting the reclaim its full estimation
    // headroom — safe to call negative outright.
    verdict = "negative";
    verdictReason = `reclaimed ${fmtTokens(reclaimedTokens)} tokens but paid ~${fmtTokens(
      attributableRebuild,
    )} to rebuild the prompt cache`;
  } else if (reclaimedTokens < TRIVIAL_RECLAIM_TOKENS) {
    verdict = "negative";
    verdictReason = `reclaimed only ${fmtTokens(reclaimedTokens)} tokens (${reclaimedPct}% of context)`;
  } else if (reclaimedTokens < attributableRebuild) {
    // Inside the estimation band: the wire cost nominally exceeds the
    // estimated reclaim, but by less than the chars/4 error can account for.
    verdict = "marginal";
    verdictReason = `reclaimed ~${fmtTokens(reclaimedTokens)} tokens (estimated) against ~${fmtTokens(
      attributableRebuild,
    )} of cache rebuild — within estimation tolerance, roughly break-even`;
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

  // Compaction annotation is a SECOND pass for two reasons. The "before" call
  // is the time predecessor, which may sit later in seq order and so may not
  // have had its point built yet during the first pass; and efficacy is a
  // function of what happened *after* the compaction, so it cannot be settled
  // while the timeline is still being laid down.
  const pointBySeq = new Map(points.map((p) => [p.seq, p] as const));
  const sizes = points.map((p) => p.approxTokens);
  const isCompaction = (seq: number) => compactBySeq.has(seq);
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    const c = compactBySeq.get(point.seq);
    if (!c) continue;
    const prevReq = timePredecessor.get(point.seq);
    if (!prevReq) continue;
    const preContext = contextTokensOf(prevReq);
    const postContext = point.contextTokens;
    const preApproxTokens = pointBySeq.get(prevReq.seq)?.approxTokens ?? preContext;
    point.compaction = {
      fromItems: c.from,
      toItems: c.to,
      droppedItems: c.from - c.to,
      preContextTokens: preContext,
      postContextTokens: postContext,
      droppedTokens: preContext - postContext,
      preApproxTokens,
      postApproxTokens: point.approxTokens,
      efficacy: computeCompactionEfficacy({
        reclaimedTokens: preApproxTokens - point.approxTokens,
        preApproxTokens,
        cacheRebuildTokens: reqs[i].cacheCreation,
        // The "before" call is the TIME predecessor, not `reqs[i - 1]`. On a
        // session interleaving subagents those are different calls, and
        // diffing the wrong pair is exactly what made the old detector wrong.
        cacheReadBefore: prevReq.cacheRead,
        cacheReadAfter: reqs[i].cacheRead,
        cacheBaseline: cacheRebuildBaseline(reqs, i, isCompaction),
        callsToRegrow: callsToRegrow(sizes, i, preApproxTokens),
        rebuildCostTokens: rebuildCostFor(reqs, i),
      }),
      // No hook match means the trigger is genuinely unknown. Nothing on the
      // wire distinguishes an auto compaction from a user-typed /compact, so
      // this stays "unknown" rather than being inferred into a guess.
      trigger: opts.triggersBySeq?.get(point.seq) ?? {
        kind: "unknown",
        source: "inferred",
      },
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
