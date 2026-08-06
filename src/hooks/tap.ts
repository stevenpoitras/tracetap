import * as crypto from "crypto";
import * as fs from "fs";
import { spawnSync } from "child_process";
import { HOOK_EVENT_VERSION } from "./types";
import type { HookDecision, HookEvent, HookOutcome } from "./types";
import { defaultHooksDir, ensureDir, hookLogPath } from "./paths";

/**
 * Build a safe stdin preview from Claude Code hook stdin JSON.
 * Keeps structural fields; drops large free-text / secret-prone blobs.
 */
export function buildStdinPreview(stdin: unknown): Record<string, unknown> {
  if (!stdin || typeof stdin !== "object" || Array.isArray(stdin)) {
    return { kind: typeof stdin };
  }
  const o = stdin as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // The first group is context; the second is JOIN KEYS, and they are the whole
  // reason a hook event can ever be attributed to anything. Claude Code hands
  // them to us on stdin and they are cheap identifiers, not payload:
  //
  //   tool_use_id  the `toolu_…` of the tool call this hook gated or observed —
  //                the exact key that pairs PreToolUse with its tool call and
  //                with the matching PostToolUse.
  //   prompt_id    shared by every hook fired during one user turn, which is
  //                what partitions a flat hook stream into turns.
  //   agent_id     which subagent fired this, so lanes stop being guessed from
  //                tool names.
  //   agent_type   that subagent's label ("Explore", "claude"), which names the
  //                lane agent_id only identifies.
  //   source       why a SessionStart fired — a closed enum of startup, resume,
  //                clear, compact, fork. Not a join key; it is here because it
  //                is the only wire-side witness to a session's provenance, and
  //                it is bounded to those five literals.
  //
  // Every key on this list is an opaque identifier or a bounded literal, which
  // is the bar for entering it: this allowlist is the redaction fence for hook
  // stdin, and these events are indexed and rendered WITHOUT --redact-bodies.
  // Measured against real captures, the longest of these is 36 chars.
  //
  // Their sensitive neighbours fall into two groups, and the difference matters
  // to anyone reading a preview:
  //   never present   session_title, compact_summary, custom_instructions,
  //                   error_details, message, tool_response — no branch below
  //                   emits them in any form.
  //   summarized      prompt keeps a length AND its first 120 chars VERBATIM in
  //                   prompt_preview; last_assistant_message keeps a length
  //                   only. So a secret pasted into the first 120 characters of
  //                   a prompt does reach the log. Pre-existing, and the reason
  //                   this list must stay identifiers-only rather than becoming
  //                   the place where new free text gets added.
  //
  // These are dropped at CAPTURE time, so a reindex can never recover them for
  // events already on disk. Anything omitted here is unattributable forever,
  // which also means the corpus is mixed-shape: events captured before this
  // will never carry these keys, and a consumer must read absence as "captured
  // earlier", never as "no subagent".
  const copyKeys = [
    "session_id",
    "transcript_path",
    "cwd",
    "permission_mode",
    "hook_event_name",
    "tool_name",
    "stop_hook_active",
    "trigger",
    "tool_use_id",
    "prompt_id",
    "agent_id",
    "agent_type",
    "source",
  ];
  for (const k of copyKeys) {
    if (o[k] !== undefined) out[k] = o[k];
  }
  if (o.tool_input && typeof o.tool_input === "object" && !Array.isArray(o.tool_input)) {
    const ti = o.tool_input as Record<string, unknown>;
    const slim: Record<string, unknown> = {};
    for (const k of ["file_path", "path", "command", "pattern", "url", "description"]) {
      if (ti[k] !== undefined) {
        const v = ti[k];
        slim[k] = typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "…" : v;
      }
    }
    if (Object.keys(slim).length) out.tool_input = slim;
  }
  if (typeof o.prompt === "string") {
    out.prompt_chars = o.prompt.length;
    out.prompt_preview = o.prompt.slice(0, 120) + (o.prompt.length > 120 ? "…" : "");
  }
  if (typeof o.last_assistant_message === "string") {
    out.last_assistant_chars = o.last_assistant_message.length;
  }
  return out;
}

/** Max chars of returned stdout kept in the event preview (UI expand/hover). */
export const STDOUT_TEXT_CAP = 80_000;

/**
 * Summarize hook stdout for the UI.
 * Always keeps a `text` field (capped) so the observatory can show what the
 * hook returned — decision JSON, additionalContext, or plain injection text.
 *
 * `wrapped` distinguishes the two ways stdout ends up empty. An observe-only
 * tap (`hooks install`, which wraps the shell no-op `true`) has no command to
 * capture, so emptiness is structural and permanent. A wrapped hook that
 * returns nothing is a real result. The UI reports these differently — without
 * the flag both render as "no payload" and the user cannot tell which they have.
 */
export function buildStdoutPreview(
  stdout: string,
  wrapped = true,
): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) {
    // Emit the flag in BOTH directions. `observeOnly: false` is what lets the UI
    // say "ran and returned nothing" with confidence; omitting it would make a
    // real silent hook indistinguishable from an event captured before this
    // flag existed, which is the exact ambiguity the flag is here to remove.
    return { chars: 0, empty: true, observeOnly: !wrapped };
  }
  const out: Record<string, unknown> = {
    chars: trimmed.length,
    text: trimmed.length > STDOUT_TEXT_CAP ? trimmed.slice(0, STDOUT_TEXT_CAP) + "…" : trimmed,
  };
  try {
    const j = JSON.parse(trimmed);
    if (j && typeof j === "object") {
      out.parsed = true;
      if (typeof j.decision === "string") out.decision = j.decision;
      if (typeof j.reason === "string") {
        out.reason_chars = j.reason.length;
        out.reason_preview = j.reason.slice(0, 160) + (j.reason.length > 160 ? "…" : "");
        out.reason = j.reason.length > STDOUT_TEXT_CAP ? j.reason.slice(0, STDOUT_TEXT_CAP) + "…" : j.reason;
      }
      const hso = j.hookSpecificOutput;
      if (hso && typeof hso === "object") {
        const ac = (hso as any).additionalContext;
        if (typeof ac === "string") {
          out.additional_context_chars = ac.length;
          out.additional_context_preview = ac.slice(0, 160) + (ac.length > 160 ? "…" : "");
          out.additional_context =
            ac.length > STDOUT_TEXT_CAP ? ac.slice(0, STDOUT_TEXT_CAP) + "…" : ac;
        }
      }
      if (typeof j.continue === "boolean") out.continue = j.continue;
      // Keep structured return for expand — but capped like every other field.
      // stdout can be as large as spawnSync's 32MB maxBuffer, and this object
      // is written verbatim into every JSONL line and the stdout_preview
      // column, so a big return must not bypass the STDOUT_TEXT_CAP contract.
      const serialized = JSON.stringify(j);
      if (serialized.length > STDOUT_TEXT_CAP) {
        out.returned = serialized.slice(0, STDOUT_TEXT_CAP) + "…";
        out.returned_truncated = true;
      } else {
        out.returned = j;
      }
    }
  } catch {
    out.preview = trimmed.slice(0, 160) + (trimmed.length > 160 ? "…" : "");
  }
  return out;
}

export function digest(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function parseDecision(stdout: string, exitCode: number): HookDecision {
  const trimmed = stdout.trim();
  if (trimmed) {
    try {
      const j = JSON.parse(trimmed);
      if (j && typeof j === "object" && typeof j.decision === "string") {
        if (j.decision === "block") return "block";
        if (j.decision === "allow") return "allow";
      }
    } catch {
      /* ignore */
    }
  }
  if (exitCode === 2) return "block"; // Claude Code convention for some hooks
  return null;
}

export function outcomeFor(decision: HookDecision, exitCode: number): HookOutcome {
  if (decision === "block" || exitCode === 2) return "blocked";
  if (exitCode !== 0) return "error";
  return "ok";
}

export interface BuildHookEventOpts {
  rawStdin: string;
  stdinObj?: unknown;
  eventName?: string;
  hookName?: string;
  durationMs?: number;
  stdout?: string;
  exitCode?: number;
  includePayload?: boolean;
  /** False for observe-only taps that wrap no command and so capture nothing. */
  wrapped?: boolean;
}

/** Construct a v1 HookEvent from tap inputs (pure; no I/O). */
export function buildHookEvent(opts: BuildHookEventOpts): HookEvent {
  let stdinObj: unknown = opts.stdinObj;
  if (stdinObj === undefined) {
    try {
      stdinObj = opts.rawStdin ? JSON.parse(opts.rawStdin) : null;
    } catch {
      stdinObj = null;
    }
  }
  const preview = buildStdinPreview(stdinObj);
  const sessionId =
    (stdinObj && typeof stdinObj === "object" && !Array.isArray(stdinObj)
      ? String((stdinObj as any).session_id || "")
      : "") || "unknown";
  const eventName =
    opts.eventName ||
    (stdinObj && typeof stdinObj === "object" && !Array.isArray(stdinObj)
      ? String((stdinObj as any).hook_event_name || "unknown")
      : "unknown");
  const stdout = opts.stdout ?? "";
  const exitCode = opts.exitCode ?? 0;
  const decision = parseDecision(stdout, exitCode);
  const includePayload =
    opts.includePayload === true ||
    process.env.TRACETAP_HOOK_FULL === "1" ||
    process.env.TRACETAP_HOOK_FULL === "true";

  const ev: HookEvent = {
    v: HOOK_EVENT_VERSION,
    ts: new Date().toISOString(),
    session_id: sessionId,
    event: eventName,
    hook_name: opts.hookName,
    duration_ms: opts.durationMs,
    decision,
    stdin_digest: digest(opts.rawStdin),
    stdin_preview: preview,
    stdout_preview: buildStdoutPreview(stdout, opts.wrapped !== false),
    outcome: outcomeFor(decision, exitCode),
    exit_code: exitCode,
  };
  if (includePayload) ev.payload = stdinObj;
  return ev;
}

/**
 * Append one event line to the session hook log. Returns the path written.
 * Logs hold prompt/tool text (full payloads under --full), so the dir and
 * file are created owner-only: 0700 / 0600.
 */
export function appendHookEvent(event: HookEvent, hooksDir = defaultHooksDir()): string {
  ensureDir(hooksDir, 0o700);
  const file = hookLogPath(event.session_id, hooksDir);
  fs.appendFileSync(file, JSON.stringify(event) + "\n", { encoding: "utf-8", mode: 0o600 });
  return file;
}

/**
 * Shell no-ops. `hooks install` emits `... -- true` so the tap has something to
 * exec; it exits 0 and prints nothing by design. Such a tap observes that the
 * event fired but can never capture a returned payload, which is a different
 * situation from a real hook that ran and chose to return nothing.
 */
const NOOP_CMDS = new Set(["true", ":", "/bin/true", "/usr/bin/true"]);

/** True when the tap wraps a real command whose stdout is worth reporting. */
export function wrapsRealCommand(cmd?: string[]): boolean {
  if (!cmd || cmd.length === 0) return false;
  return !(cmd.length === 1 && NOOP_CMDS.has(cmd[0]));
}

export interface TapRunResult {
  event: HookEvent;
  /** Path written, or "" when the log append failed (the tap still re-emits). */
  logPath: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Read stdin, optionally run a wrapped command with the same stdin, log a
 * HookEvent, and return stdout/stderr/exit for the caller to re-emit.
 */
export function runTap(opts: {
  rawStdin: string;
  wrappedCmd?: string[];
  hookName?: string;
  eventName?: string;
  hooksDir?: string;
  includePayload?: boolean;
}): TapRunResult {
  const started = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  if (opts.wrappedCmd && opts.wrappedCmd.length > 0) {
    const [cmd, ...args] = opts.wrappedCmd;
    const result = spawnSync(cmd, args, {
      input: opts.rawStdin,
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
      env: process.env,
      shell: false,
    });
    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
    exitCode = typeof result.status === "number" ? result.status : 1;
    if (result.error) {
      stderr = (stderr ? stderr + "\n" : "") + String(result.error.message || result.error);
      exitCode = 1;
    }
  }

  const durationMs = Date.now() - started;
  const event = buildHookEvent({
    rawStdin: opts.rawStdin,
    eventName: opts.eventName,
    hookName: opts.hookName || (opts.wrappedCmd ? opts.wrappedCmd.join(" ") : "tap"),
    durationMs,
    stdout,
    exitCode,
    includePayload: opts.includePayload,
    wrapped: wrapsRealCommand(opts.wrappedCmd),
  });
  // Best-effort bookkeeping: a failed log write (unwritable dir, full disk)
  // must never eat the wrapped hook's decision. The caller re-emits
  // stdout/stderr/exit code off this result regardless.
  let logPath = "";
  try {
    logPath = appendHookEvent(event, opts.hooksDir ?? defaultHooksDir());
  } catch (err) {
    process.stderr.write(
      `tracetap: hook log write failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  return { event, logPath, stdout, stderr, exitCode };
}

/** Read all stdin bytes (sync). */
export function readStdinSync(): string {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}
