/**
 * Context X-Ray bucket taxonomy.
 *
 * Each Anthropic (and similar) request body is partitioned into these lanes so
 * the observatory can show what's in the window, how big it is, and what
 * appeared/vanished between consecutive API calls.
 *
 * Order here is display order (top → bottom of the stacked composition).
 */

export type XrayBucketId =
  | "system"
  | "tools"
  | "skills"
  | "hook_inject"
  | "user"
  | "assistant"
  | "tool_result"
  | "thinking"
  | "other"
  | "unrecorded";

export interface XrayBucketDef {
  id: XrayBucketId;
  /** Short UI label. */
  label: string;
  /** One-line legend. */
  description: string;
}

/** First-class composition lanes — edit this list to reshape the X-Ray legend. */
export const XRAY_BUCKETS: readonly XrayBucketDef[] = [
  { id: "system", label: "system", description: "System prompt / instructions" },
  { id: "tools", label: "tools", description: "Tool definitions (schemas)" },
  { id: "skills", label: "skills", description: "Skill / CLAUDE.md style injected docs" },
  { id: "hook_inject", label: "hook inject", description: "Hook additionalContext / posture text" },
  { id: "user", label: "user", description: "User text turns" },
  { id: "assistant", label: "assistant", description: "Prior assistant text" },
  { id: "thinking", label: "thinking", description: "Extended thinking blocks" },
  { id: "tool_result", label: "tool result", description: "Tool outputs carried forward" },
  { id: "other", label: "other", description: "Unclassified content" },
  // Only a transcript-built X-Ray has this lane. A transcript does not record
  // the system prompt or the tool declarations, so the part of the measured
  // context the transcript cannot account for is shown as its own remainder
  // rather than silently folded into a bucket it does not belong to.
  {
    id: "unrecorded",
    label: "not accounted for",
    description:
      "Real context the transcript cannot account for: system prompt, tool definitions, thinking it does not keep, and chars/4 estimate error",
  },
] as const;

export const XRAY_BUCKET_IDS: readonly XrayBucketId[] = XRAY_BUCKETS.map((b) => b.id);
