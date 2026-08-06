/**
 * Who made this API call: the main thread, or a named subagent?
 *
 * A Claude Code session that spawns a fleet writes every agent's traffic into
 * ONE wire log under ONE session id. Nothing in the HTTP headers separates
 * them — `x-claude-code-session-id` covered 672 of 682 calls on a live capture,
 * because subagents inherit the parent's session id. So every metric that
 * compares neighbouring requests (context growth, compaction detection) was
 * silently comparing across unrelated conversations: on that same capture, 87
 * of 223 adjacent pairs ran BACKWARDS in wall-clock time and 10 calls landed
 * in the first 3 seconds.
 *
 * Two signals recover the identity, and both are already in the captured body:
 *
 *  1. WHETHER a call is a subagent — Claude Code embeds a billing header in
 *     the system prompt (`x-anthropic-billing-header: ...; cc_is_subagent=true`).
 *     399 of 681 calls carried it on the capture above.
 *
 *  2. WHICH subagent — the PARENT's `Agent`/`Task` tool_use block carries the
 *     human-readable `description` ("Survey open PRs") and `subagent_type`.
 *     The child never sees them, but the `prompt` the parent passed appears
 *     verbatim in the child's user messages, so the prompt text is the join
 *     key. Note "appears in", not "is": Claude Code prepends a
 *     `<system-reminder>` block, so the prompt is not the first thing there.
 *
 * Everything here is pure so it can be tested against fixtures without a store
 * or a proxy.
 */

/** A wire pair, narrowed to the parts identity needs. */
export interface IdentityPair {
  request?: {
    body?: {
      system?: unknown;
      messages?: unknown;
    };
  };
}

export interface AgentSpawn {
  /** The parent's human-readable label, e.g. "Survey open PRs". */
  description: string;
  /** e.g. "general-purpose", "code-reviewer". */
  subagentType: string | null;
  /** The full prompt the parent handed the child, whitespace-collapsed. */
  prompt: string;
}

/** Flatten a `system` field (string or content-block array) to plain text. */
function systemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (b && typeof b === "object" ? String((b as any).text ?? "") : ""))
      .join("\n");
  }
  return "";
}

/**
 * Parse `x-anthropic-billing-header: k=v; k=v;` out of the system prompt.
 *
 * @returns the key/value pairs, or an empty object when absent. Claude Code
 *   prepends this to the system prompt rather than sending it as a real HTTP
 *   header, which is why it survives in the captured body at all.
 */
export function billingHeader(pair: IdentityPair): Record<string, string> {
  const text = systemText(pair?.request?.body?.system);
  const m = /x-anthropic-billing-header:\s*([^\n]*)/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const part of m[1].split(";")) {
    const kv = part.trim();
    if (!kv) continue;
    const eq = kv.indexOf("=");
    if (eq <= 0) continue;
    out[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
  }
  return out;
}

/** True when Claude Code marked this call as belonging to a subagent. */
export function isSubagentCall(pair: IdentityPair): boolean {
  return billingHeader(pair).cc_is_subagent === "true";
}

/**
 * Collapse whitespace so parent and child agree on the text.
 *
 * NOT truncated to a prefix. Two agents in the same fan-out routinely share a
 * long preamble — "Survey design docs part 1" and "part 2" were identical for
 * their first 200 characters — so a prefix key silently attributed every part-2
 * call to part 1. The full prompt is the only discriminating form.
 */
export function normalizePrompt(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Cap on how much of a child transcript is scanned for its spawn prompt. */
const CHILD_SCAN_CHARS = 40000;

/**
 * User-authored text from a request, whitespace-collapsed and bounded.
 *
 * Not just the FIRST text block: Claude Code prepends a `<system-reminder>`
 * block carrying CLAUDE.md and environment context, so a child's first block is
 * boilerplate and the prompt its parent handed it comes after. Reading only the
 * first block produced a 0% join rate against a live 738-call log.
 *
 * Bounded because a late subagent turn resends a large transcript and only the
 * opening is ever relevant.
 */
export function userText(pair: IdentityPair): string {
  const msgs = pair?.request?.body?.messages;
  if (!Array.isArray(msgs)) return "";
  const out: string[] = [];
  let len = 0;
  for (const m of msgs) {
    if (!m || typeof m !== "object" || (m as any).role !== "user") continue;
    const c = (m as any).content;
    if (typeof c === "string") {
      out.push(c);
      len += c.length;
    } else if (Array.isArray(c)) {
      for (const part of c) {
        if (part && typeof part === "object" && (part as any).type === "text") {
          const t = String((part as any).text ?? "");
          out.push(t);
          len += t.length;
        }
      }
    }
    if (len > CHILD_SCAN_CHARS) break;
  }
  return normalizePrompt(out.join(" "));
}

/**
 * Every subagent this request spawned, from its `Agent`/`Task` tool_use blocks.
 *
 * Read from the PARENT's messages: a parent resends its whole transcript, so
 * one late request carries every spawn it has made. Callers should merge across
 * requests and let later duplicates win.
 */
export function spawnsIn(pair: IdentityPair): AgentSpawn[] {
  const msgs = pair?.request?.body?.messages;
  if (!Array.isArray(msgs)) return [];
  const out: AgentSpawn[] = [];
  for (const m of msgs) {
    const c = m && typeof m === "object" ? (m as any).content : null;
    if (!Array.isArray(c)) continue;
    for (const part of c) {
      if (!part || typeof part !== "object") continue;
      const p = part as any;
      if (p.type !== "tool_use") continue;
      if (p.name !== "Agent" && p.name !== "Task") continue;
      const input = p.input || {};
      const prompt = typeof input.prompt === "string" ? input.prompt : "";
      if (!prompt) continue;
      out.push({
        description: String(input.description ?? "").trim() || "(unnamed agent)",
        subagentType: input.subagent_type ? String(input.subagent_type) : null,
        prompt: normalizePrompt(prompt),
      });
    }
  }
  return out;
}

/**
 * Every distinct spawn seen across a session's requests, most specific first.
 *
 * @param pairs all wire pairs for the session, in any order.
 */
export function spawnIndex(pairs: IdentityPair[]): AgentSpawn[] {
  const byPrompt = new Map<string, AgentSpawn>();
  for (const p of pairs) {
    for (const s of spawnsIn(p)) byPrompt.set(s.prompt, s);
  }
  // Longest first: when one spawn prompt is a prefix of another, the longer is
  // the more specific match and must win.
  return [...byPrompt.values()].sort((a, b) => b.prompt.length - a.prompt.length);
}

export interface AgentIdentity {
  isSubagent: boolean;
  /** Human-readable label when the spawn was found; null for the main thread. */
  label: string | null;
  subagentType: string | null;
}

/**
 * Identify one request against a spawn index built from the same session.
 *
 * A call marked `cc_is_subagent` whose prompt is not in the index still reports
 * `isSubagent: true` with a null label — the marking is direct evidence, the
 * label is a join that can miss (the spawning request may not have been
 * captured). Reporting "subagent, unnamed" is honest; guessing a name is not.
 */
export function identifyRequest(
  pair: IdentityPair,
  index: AgentSpawn[],
): AgentIdentity {
  if (!isSubagentCall(pair)) {
    return { isSubagent: false, label: null, subagentType: null };
  }
  const text = userText(pair);
  const hit = text ? index.find((s) => text.includes(s.prompt)) : undefined;
  return {
    isSubagent: true,
    label: hit ? hit.description : null,
    subagentType: hit ? hit.subagentType : null,
  };
}
