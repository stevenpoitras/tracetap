import type { RawPair } from "../types";
import type { Agent, AgentAdapter, NormalizedUsage, ParsedResponse, WireItem } from "./types";

/**
 * Devin CLI (Cognition) adapter.
 *
 * Devin's LLM traffic is not capturable on the wire (proprietary cloud backend),
 * so unlike the other adapters this one does not parse a provider's real API
 * shape. Instead it recognizes the CANONICAL synthetic wire that
 * {@link import("../devin/importer").importDevinSession} reconstructs from the
 * CLI's local `sessions.db`. Each pair is one assistant turn:
 *
 *   request.body  = { provider: "devin", session_id, model, system?, transcript[] }
 *   response.body = { provider: "devin", model, finish_reason?, message, usage }
 *
 * `transcript[]` is the cumulative prior turns (user / assistant / tool messages),
 * resent every turn the same way a real replay transcript is, so the shared
 * walker's user-step and tool-result stitching works unchanged. The assistant
 * turn (text + tool_calls) comes from `response.body.message`. The `provider`
 * marker makes {@link matches} unambiguous, and the distinct `transcript` field
 * name (vs Anthropic's `messages`) keeps the two apart even if adapter order
 * ever changed.
 */
export class DevinAdapter implements AgentAdapter {
  readonly name = "devin";

  matches(pair: RawPair): boolean {
    const body = pair?.request?.body;
    return !!body && typeof body === "object" && (body as any).provider === "devin";
  }

  agentInfo(pair: RawPair): Agent {
    const body = pair?.request?.body ?? {};
    // request.model carries the session's dominant real model (e.g.
    // "claude-sonnet-4-6"), which is what pricing/labeling wants — not the
    // "adaptive" router alias.
    return { name: "devin", model: String(body.model ?? "unknown") };
  }

  conversationKey(pair: RawPair): string {
    const body = pair?.request?.body ?? {};
    if (body.session_id) return "devin:" + String(body.session_id);
    return "devin:" + djb2(String(body.model ?? "?") + "|" + textPreview(body.system));
  }

  parseRequestItems(pair: RawPair): WireItem[] {
    const body = pair?.request?.body ?? {};
    const transcript: any[] = Array.isArray(body.transcript) ? body.transcript : [];
    const items: WireItem[] = [];
    for (const m of transcript) {
      if (!m || typeof m !== "object") continue;
      if (m.role === "user") {
        items.push({ kind: "message", role: "user", text: str(m.content) });
      } else if (m.role === "tool") {
        items.push({ kind: "tool_result", sourceCallId: String(m.tool_call_id ?? ""), content: str(m.content) });
      } else if (m.role === "assistant") {
        // Assistant/system items in the request are ignored by the walker
        // (assistant turns are sourced from responses); emitted for fidelity.
        pushAssistant(items, m);
      } else if (m.role === "system") {
        items.push({ kind: "message", role: "system", text: str(m.content) });
      }
    }
    return items;
  }

  parseResponse(pair: RawPair): ParsedResponse {
    const resp = pair?.response;
    if (!resp) return { items: [], usage: null, status: null };
    const body: any = resp.body ?? {};
    const items: WireItem[] = [];
    if (body.message && typeof body.message === "object") pushAssistant(items, body.message);
    return {
      items,
      usage: normalizeUsage(body.usage),
      model: typeof body.model === "string" ? body.model : undefined,
      status: resp.status_code ?? null,
      stopReason: typeof body.finish_reason === "string" ? body.finish_reason : undefined,
    };
  }

  systemPromptText(pair: RawPair): string | null {
    const system = pair?.request?.body?.system;
    if (typeof system !== "string" || !system.trim()) return null;
    const text = normalizeVolatileText(system);
    return text.trim() ? text : null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pushAssistant(items: WireItem[], m: any): void {
  const text = str(m.content);
  if (text) items.push({ kind: "message", role: "assistant", text });
  const tcs = Array.isArray(m.tool_calls) ? m.tool_calls : [];
  for (const tc of tcs) {
    if (!tc || typeof tc !== "object") continue;
    items.push({
      kind: "tool_call",
      id: String(tc.id ?? ""),
      name: String(tc.name ?? "tool"),
      arguments: tc.arguments,
    });
  }
}

function normalizeUsage(u: any): NormalizedUsage | null {
  if (!u || typeof u !== "object") return null;
  return {
    promptTokens: num(u.input_tokens),
    completionTokens: num(u.output_tokens),
    cacheCreationTokens: num(u.cache_creation_tokens),
    cacheReadTokens: num(u.cache_read_tokens),
  };
}

/**
 * Strip per-session volatile fragments from Devin's system prompt so
 * semantically identical prompts hash identically across sessions (matches the
 * prompt-registry intent). Devin injects a `<system_info>` block with the date,
 * OS version, and a git-status snapshot; those are normalized away.
 */
function normalizeVolatileText(text: string): string {
  return text
    .replace(/Today's date:[^\n]*/g, "Today's date: [DATE]")
    .replace(/OS Version:[^\n]*/g, "OS Version: [OS]")
    .replace(/<git_status>[\s\S]*?<\/git_status>/g, "[GIT_STATUS]")
    .replace(/<system_info>[\s\S]*?<\/system_info>/g, "[SYSTEM_INFO]");
}

function str(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function textPreview(v: unknown): string {
  return str(v).slice(0, 200);
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
