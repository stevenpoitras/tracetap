import type { RawPair } from "../types";
import type { Agent, AgentAdapter, NormalizedUsage, ParsedResponse, WireItem } from "./types";

/**
 * Claude Code local-transcript adapter.
 *
 * Recognizes the CANONICAL synthetic wire that
 * {@link import("../claude-transcripts/importer").importTranscript} builds from
 * `~/.claude/projects/<slug>/<uuid>.jsonl` — sessions that were never proxied
 * (the Claude desktop app above all). One pair per API response:
 *
 *   request.body  = { provider: "claude-transcript", session_id, agent_id?, model,
 *                     meta, anchor?, delta[], hooks? }
 *   response.body = { provider: "claude-transcript", id, model, content[], stop_reason, usage|null }
 *
 * The strict `provider` marker makes {@link matches} unambiguous, and the
 * request deliberately has no `messages[]`, so the Anthropic adapter (checked
 * last) can never claim these pairs either.
 *
 * The agent is reported as `"claude"` — it is the same harness the wire tracer
 * captures — so `--agent claude` filters, pricing and the dashboard treat both
 * sources alike. Where the session came from is kept on `body.meta`
 * (`entrypoint`: claude-desktop / cli / sdk-cli / claude-vscode) and surfaced
 * by the store.
 */
export class ClaudeTranscriptAdapter implements AgentAdapter {
  readonly name = "claude-transcript";

  matches(pair: RawPair): boolean {
    const body = pair?.request?.body;
    return !!body && typeof body === "object" && (body as any).provider === "claude-transcript";
  }

  agentInfo(pair: RawPair): Agent {
    const body = pair?.request?.body ?? {};
    const version = body.meta && typeof body.meta.version === "string" ? body.meta.version : undefined;
    return { name: "claude", model: String(body.model || "unknown"), ...(version ? { version } : {}) };
  }

  conversationKey(pair: RawPair): string {
    const body = pair?.request?.body ?? {};
    const sid = String(body.session_id ?? "?");
    return "claude-transcript:" + sid + (body.agent_id ? ":agent-" + String(body.agent_id) : "");
  }

  parseRequestItems(pair: RawPair): WireItem[] {
    const body = pair?.request?.body ?? {};
    const items: WireItem[] = [];
    // The previous response's last item, so the walker can anchor this
    // request's delta and treat every user message after it as new.
    const a = body.anchor;
    if (a && typeof a === "object") {
      if (a.kind === "tool_call") items.push({ kind: "tool_call", id: String(a.id ?? ""), name: String(a.name ?? "tool"), arguments: undefined });
      else if (a.kind === "text") items.push({ kind: "message", role: "assistant", text: String(a.text ?? "") });
      else if (a.kind === "reasoning") items.push({ kind: "reasoning", text: String(a.text ?? "") });
    }
    const delta: any[] = Array.isArray(body.delta) ? body.delta : [];
    for (const d of delta) {
      if (!d || typeof d !== "object") continue;
      if (d.kind === "user") items.push({ kind: "message", role: "user", text: String(d.text ?? "") });
      else if (d.kind === "tool_result") {
        items.push({ kind: "tool_result", sourceCallId: String(d.tool_use_id ?? ""), content: String(d.content ?? "") });
      }
    }
    return items;
  }

  parseResponse(pair: RawPair): ParsedResponse {
    const resp = pair?.response;
    if (!resp) return { items: [], usage: null, status: null };
    const b: any = resp.body ?? {};
    const blocks: any[] = Array.isArray(b.content) ? b.content : [];
    return {
      items: flattenAssistantBlocks(blocks),
      usage: normalizeUsage(b.usage),
      model: typeof b.model === "string" && b.model ? b.model : undefined,
      status: resp.status_code ?? null,
      stopReason: typeof b.stop_reason === "string" ? b.stop_reason : undefined,
    };
  }

  /** Transcripts do not record the system prompt. */
  systemPromptText(_pair: RawPair): string | null {
    return null;
  }
}

function flattenAssistantBlocks(blocks: any[]): WireItem[] {
  const items: WireItem[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      items.push({ kind: "message", role: "assistant", text: String(block.text ?? "") });
    } else if (block.type === "thinking" || block.type === "redacted_thinking") {
      items.push({ kind: "reasoning", text: String(block.thinking ?? block.data ?? "") });
    } else if (block.type === "tool_use") {
      items.push({ kind: "tool_call", id: String(block.id ?? ""), name: String(block.name ?? "tool"), arguments: block.input });
    }
  }
  return items;
}

function normalizeUsage(u: any): NormalizedUsage | null {
  if (!u || typeof u !== "object") return null;
  return {
    promptTokens: num(u.input_tokens),
    completionTokens: num(u.output_tokens),
    cacheCreationTokens: num(u.cache_creation_input_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
