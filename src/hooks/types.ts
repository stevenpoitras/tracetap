/**
 * Hook-event sidecar schema (v1).
 *
 * Claude Code hooks never appear on the Anthropic wire — they run locally and
 * can inject `additionalContext` or block a turn. This schema is the durable
 * record that lets the observatory show hook firing next to turns.
 */

export const HOOK_EVENT_VERSION = 1 as const;

export type HookDecision = "allow" | "block" | null;

export type HookOutcome = "ok" | "blocked" | "error" | "skipped";

/** Append-only JSONL line written under `~/.tracetap/hooks/<session_id>.jsonl`. */
export interface HookEvent {
  v: typeof HOOK_EVENT_VERSION;
  ts: string;
  session_id: string;
  /** Claude Code hook event name (UserPromptSubmit, PreToolUse, Stop, …). */
  event: string;
  /** Human label for the wrapped script / plugin hook. */
  hook_name?: string;
  duration_ms?: number;
  decision?: HookDecision;
  /** sha256 of the raw stdin body. */
  stdin_digest: string;
  /** Safe/summarized stdin fields for the UI. */
  stdin_preview: Record<string, unknown>;
  /** Summarized stdout (decision JSON, additionalContext length, …). */
  stdout_preview?: Record<string, unknown>;
  /** Full stdin object when TRACETAP_HOOK_FULL=1. */
  payload?: unknown;
  outcome?: HookOutcome;
  /** Process exit code of the wrapped command (0 when passthrough-only). */
  exit_code?: number;
}

/** Row returned from the SQLite hooks index / session API. */
export interface HookRow {
  id: number;
  sessionId: string;
  ts: number;
  event: string;
  hookName: string;
  durationMs: number | null;
  decision: HookDecision;
  stdinDigest: string;
  stdinPreview: Record<string, unknown>;
  stdoutPreview: Record<string, unknown> | null;
  outcome: HookOutcome | null;
  exitCode: number | null;
  /** Present when the event was captured with TRACETAP_HOOK_FULL=1. */
  payload: unknown | null;
  sourcePath: string;
}
