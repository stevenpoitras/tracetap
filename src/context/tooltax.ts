import * as crypto from "crypto";

/**
 * Dead-tool-tax: per-tool cost of declared tool definitions.
 *
 * Tool schemas ride along in EVERY request body, so a declared-but-never-called
 * tool is paid for on every call. The wire gives us both halves of the ledger:
 * `body.tools[].name` (declared, sized here) and the session tool histogram
 * (`tool_use.name`, counted at analyze time) share one namespace, so their
 * set-difference is the dead set.
 *
 * Sizing uses the same chars/4 heuristic as the Context X-Ray so the per-tool
 * numbers reconcile with the `tools` bucket users already see.
 */

export interface ToolTokenEntry {
  name: string;
  chars: number;
  approxTokens: number;
}

export interface ToolsetInfo {
  /** sha256 over the name-sorted, cache_control-stripped definitions. */
  hash: string;
  /** Wire order preserved. */
  tools: ToolTokenEntry[];
  totalChars: number;
  /** Sum of per-tool estimates (matches the X-Ray tools bucket). */
  totalApproxTokens: number;
}

/** Tool name for Anthropic (`tool.name`) and chat-completions (`tool.function.name`) shapes. */
export function toolName(tool: any): string {
  if (!tool || typeof tool !== "object") return "";
  if (typeof tool.name === "string") return tool.name;
  if (tool.function && typeof tool.function.name === "string") return tool.function.name;
  return "";
}

/** A stable, comparable tool definition: drop the volatile `cache_control` key. */
export function normalizeToolDefinition(tool: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!tool || typeof tool !== "object") return out;
  for (const [k, v] of Object.entries(tool)) {
    if (k === "cache_control") continue;
    out[k] = v;
  }
  return out;
}

/** The declared tools array of a request body, or null. */
export function toolsFromBody(body: any): any[] | null {
  if (!body || typeof body !== "object") return null;
  const tools = Array.isArray(body.tools)
    ? body.tools
    : Array.isArray(body.tools_list)
      ? body.tools_list
      : null;
  return tools && tools.length ? tools : null;
}

/**
 * Size and content-address the toolset declared by one request body.
 * Null when the body declares no tools. Never throws on odd shapes.
 */
export function toolsetFromBody(body: any): ToolsetInfo | null {
  const raw = toolsFromBody(body);
  if (!raw) return null;
  const tools: ToolTokenEntry[] = [];
  const normalized: Array<{ name: string; def: Record<string, unknown> }> = [];
  for (const tool of raw) {
    const text = JSON.stringify(tool) ?? "";
    if (!text) continue;
    const name = toolName(tool) || "(unnamed)";
    tools.push({ name, chars: text.length, approxTokens: Math.ceil(text.length / 4) });
    normalized.push({ name, def: normalizeToolDefinition(tool) });
  }
  if (!tools.length) return null;
  normalized.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const hash = crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  const totalChars = tools.reduce((a, t) => a + t.chars, 0);
  const totalApproxTokens = tools.reduce((a, t) => a + t.approxTokens, 0);
  return { hash, tools, totalChars, totalApproxTokens };
}

// ---------------------------------------------------------------------------
// Tax computation (pure — feed it store rows, get view payloads)
// ---------------------------------------------------------------------------

export interface ToolTaxRow {
  name: string;
  /** Definition size, paid on every request that declares it. */
  approxTokens: number;
  calls: number;
  dead: boolean;
  /** approxTokens × requestCount. */
  cumulativeTokens: number;
}

export interface ToolsetTax {
  toolsetHash: string;
  requestCount: number;
  declaredCount: number;
  calledCount: number;
  deadCount: number;
  deadTokensPerRequest: number;
  deadTokensCumulative: number;
  /** Priced at the model's cache-read rate — declared tools are almost always cached. */
  deadCostUsd: number | null;
  tools: ToolTaxRow[];
}

/**
 * Cross one toolset's per-tool sizes with a call histogram.
 * `cacheReadPerMTok` is the model's cache-read USD rate per 1M tokens (null → no cost).
 */
export function computeToolsetTax(
  toolsetHash: string,
  perTool: Array<{ name: string; approxTokens: number }>,
  histogram: Record<string, number>,
  requestCount: number,
  cacheReadPerMTok: number | null,
): ToolsetTax {
  const tools: ToolTaxRow[] = perTool.map((t) => {
    const calls = histogram[t.name] ?? 0;
    return {
      name: t.name,
      approxTokens: t.approxTokens,
      calls,
      dead: calls === 0,
      cumulativeTokens: t.approxTokens * requestCount,
    };
  });
  tools.sort((a, b) => b.cumulativeTokens - a.cumulativeTokens);
  const deadTokensPerRequest = tools.reduce((a, t) => a + (t.dead ? t.approxTokens : 0), 0);
  const deadTokensCumulative = deadTokensPerRequest * requestCount;
  const calledCount = tools.filter((t) => !t.dead).length;
  return {
    toolsetHash,
    requestCount,
    declaredCount: tools.length,
    calledCount,
    deadCount: tools.length - calledCount,
    deadTokensPerRequest,
    deadTokensCumulative,
    deadCostUsd:
      cacheReadPerMTok == null ? null : (deadTokensCumulative * cacheReadPerMTok) / 1_000_000,
    tools,
  };
}
