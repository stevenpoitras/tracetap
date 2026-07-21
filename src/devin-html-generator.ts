import * as fs from "fs";
import * as path from "path";
import type { RawPair } from "./types";
import { buildTrajectories } from "./trajectory";
import type { Step, ToolCall, Trajectory } from "./trajectory";
import { analyzeLog } from "./analytics";

/**
 * Self-contained HTML viewer for imported Devin sessions.
 *
 * Unlike the Anthropic viewer (external JS bundle) or the codex/gemini viewers
 * (client-side renderers inlined in a template), this one renders SERVER-SIDE
 * straight from the reconstructed {@link Trajectory}: the synthetic Devin wire
 * has no provider template of its own, and a static transcript keeps the output
 * dependency-free and diffable. Shows the system prompt, each user/agent turn
 * with reasoning, tool calls (pretty-printed args) and their stitched
 * observations, plus per-turn and per-session token/cost analytics.
 */
export class DevinHTMLGenerator {
  async generateHTML(
    pairs: RawPair[],
    outputFile: string,
    options: { title?: string; timestamp?: string; includeAllRequests?: boolean; summary?: string } = {},
  ): Promise<void> {
    const trajectories = buildTrajectories(pairs);
    const stats = analyzeLog(pairs).totals;
    const timestamp = options.timestamp || new Date().toISOString().replace("T", " ").slice(0, -5);
    const title = options.title || `Devin session (${stats.turnCount} turns)`;
    const html = renderDocument(trajectories, pairs, stats, title, timestamp, options.summary);

    const outDir = path.dirname(outputFile);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outputFile, html, "utf-8");
  }

  async generateHTMLFromJSONL(
    jsonlFile: string,
    outputFile?: string,
    includeAllRequests = true,
  ): Promise<string> {
    if (!fs.existsSync(jsonlFile)) throw new Error(`File '${jsonlFile}' not found.`);
    const pairs: RawPair[] = [];
    for (const rawLine of fs.readFileSync(jsonlFile, "utf-8").split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        pairs.push(JSON.parse(line) as RawPair);
      } catch {
        // skip malformed lines
      }
    }
    if (pairs.length === 0) throw new Error(`No valid data found in '${jsonlFile}'.`);
    const out = outputFile || jsonlFile.replace(/\.jsonl$/, ".html");
    await this.generateHTML(pairs, out, { includeAllRequests });
    return out;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderDocument(
  trajectories: Trajectory[],
  pairs: RawPair[],
  stats: ReturnType<typeof analyzeLog>["totals"],
  title: string,
  timestamp: string,
  summary?: string,
): string {
  const model = stats.modelsUsed[0] ?? trajectories[0]?.agent.model ?? "unknown";
  const cost = stats.costUsd == null ? "—" : `$${stats.costUsd.toFixed(4)}`;
  const systemPrompt = firstSystemPrompt(pairs);

  const strip = [
    metric("Model", esc(model)),
    metric("Turns", String(stats.turnCount)),
    metric("Tools", String(stats.toolCallCount)),
    metric("Input", fmt(stats.totalInputTokens)),
    metric("Output", fmt(stats.totalOutputTokens)),
    metric("Cache read", fmt(stats.cacheReadTokens)),
    metric("Cache write", fmt(stats.cacheCreationTokens)),
    metric("Est. cost", cost),
  ].join("");

  const body = trajectories.map((t) => renderTrajectory(t)).join("\n");
  const summaryBanner = summary
    ? `<div class="summary"><h2>Summary</h2><div class="pre">${esc(summary)}</div></div>`
    : "";
  const systemBlock = systemPrompt
    ? `<details class="system"><summary>System prompt (${fmt(systemPrompt.length)} chars)</summary><div class="pre">${esc(systemPrompt)}</div></details>`
    : "";

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head><body>
<header>
  <div class="brand"><span class="dot"></span> tracetap · <span class="agent">devin</span></div>
  <h1>${esc(title)}</h1>
  <div class="ts">Imported ${esc(timestamp)} · from Devin's local session store</div>
  <div class="strip">${strip}</div>
</header>
<main>
${summaryBanner}
${systemBlock}
${body}
</main>
<footer>Reconstructed from <code>sessions.db</code>. Token metrics and the underlying model are as reported by the Devin CLI; USD cost is an approximate estimate.</footer>
</body></html>`;
}

function renderTrajectory(t: Trajectory): string {
  const steps = t.steps.map((s) => renderStep(s)).join("\n");
  return `<section class="traj"><div class="traj-head"><code>${esc(t.sessionId)}</code> · ${esc(t.agent.model)}</div>${steps}</section>`;
}

function renderStep(step: Step): string {
  if (step.role === "user") {
    return `<div class="step user"><div class="role">User</div><div class="pre">${esc(step.message)}</div></div>`;
  }
  const parts: string[] = [];
  if (step.message.trim()) parts.push(`<div class="pre msg">${esc(step.message)}</div>`);
  if (step.reasoningContent && step.reasoningContent.trim()) {
    parts.push(
      `<details class="reasoning"><summary>Reasoning</summary><div class="pre">${esc(step.reasoningContent)}</div></details>`,
    );
  }
  for (const tc of step.toolCalls) parts.push(renderToolCall(tc, step));
  const meta = renderStepMeta(step);
  return `<div class="step agent"><div class="role">Agent${meta}</div>${parts.join("\n") || '<div class="empty">(no content)</div>'}</div>`;
}

function renderToolCall(tc: ToolCall, step: Step): string {
  const args = prettyArgs(tc.arguments);
  const obs = (step.observation?.results ?? [])
    .filter((r) => r.sourceCallId === tc.id)
    .map((r) => r.content)
    .join("\n");
  const obsBlock = obs
    ? `<div class="obs"><div class="obs-label">Result</div><div class="pre">${esc(clip(obs, 8000))}</div></div>`
    : "";
  return `<div class="tool">
  <div class="tool-head"><span class="tool-name">${esc(tc.name)}</span> <span class="tool-id">${esc(tc.id)}</span></div>
  ${args ? `<div class="pre args">${esc(args)}</div>` : ""}
  ${obsBlock}
</div>`;
}

function renderStepMeta(step: Step): string {
  const m = step.metrics;
  if (!m) return "";
  const bits: string[] = [];
  if (m.promptTokens) bits.push(`${fmt(m.promptTokens)} in`);
  if (m.completionTokens) bits.push(`${fmt(m.completionTokens)} out`);
  if (m.cacheReadTokens) bits.push(`${fmt(m.cacheReadTokens)} cache-r`);
  if (m.cacheCreationTokens) bits.push(`${fmt(m.cacheCreationTokens)} cache-w`);
  return bits.length ? ` <span class="tok">${bits.join(" · ")}</span>` : "";
}

function firstSystemPrompt(pairs: RawPair[]): string {
  for (const p of pairs) {
    const s = p?.request?.body?.system;
    if (typeof s === "string" && s.trim()) return s;
  }
  return "";
}

function prettyArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n… [${s.length - max} more chars]` : s;
}

function metric(label: string, value: string): string {
  return `<div class="m"><div class="m-l">${label}</div><div class="m-v">${value}</div></div>`;
}

function fmt(n: number): string {
  return (n || 0).toLocaleString("en-US");
}

function esc(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0d1117;color:#c9d1d9;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
code{font-family:"SF Mono",ui-monospace,Menlo,monospace;font-size:.9em}
header{padding:20px 24px;border-bottom:1px solid #21262d;background:#010409;position:sticky;top:0;z-index:5}
.brand{font-size:12px;letter-spacing:.04em;color:#8b949e;text-transform:uppercase}
.brand .agent{color:#d2a8ff;font-weight:600}
.brand .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#3fb950;margin-right:4px}
h1{margin:6px 0 2px;font-size:20px;color:#e6edf3}
.ts{color:#6e7681;font-size:12px}
.strip{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.m{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:6px 12px;min-width:78px}
.m-l{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#8b949e}
.m-v{font-size:15px;color:#e6edf3;font-variant-numeric:tabular-nums}
main{max-width:920px;margin:0 auto;padding:20px 24px 60px}
.summary,.system{background:#161b22;border:1px solid #21262d;border-radius:10px;padding:12px 16px;margin-bottom:16px}
.summary h2{margin:0 0 6px;font-size:14px;color:#e6edf3}
details summary{cursor:pointer;color:#8b949e;font-size:13px}
.system[open] summary{margin-bottom:8px}
.traj{margin-bottom:22px}
.traj-head{font-size:12px;color:#8b949e;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #21262d}
.step{border:1px solid #21262d;border-radius:10px;padding:12px 14px;margin:10px 0;background:#0f141b}
.step.user{background:#0d1a2b;border-color:#1f3a5f}
.role{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#8b949e;margin-bottom:8px;display:flex;gap:8px;align-items:center}
.step.user .role{color:#6cb6ff}
.step.agent .role{color:#d2a8ff}
.tok{color:#6e7681;text-transform:none;letter-spacing:0;font-size:11px}
.pre{white-space:pre-wrap;word-break:break-word;font-family:"SF Mono",ui-monospace,Menlo,monospace;font-size:12.5px;line-height:1.5}
.msg{color:#e6edf3;margin-bottom:8px}
.reasoning{margin:6px 0}
.reasoning .pre{color:#a6a19a;background:#12100c;border-left:2px solid #6e5a2f;padding:8px 10px;border-radius:0 6px 6px 0}
.tool{border:1px solid #26303c;border-radius:8px;margin:8px 0;overflow:hidden;background:#0b1017}
.tool-head{background:#161b22;padding:6px 10px;font-size:12px;border-bottom:1px solid #21262d}
.tool-name{color:#7ee787;font-weight:600}
.tool-id{color:#6e7681;font-size:11px}
.args{padding:8px 10px;color:#c9d1d9;background:#0b1017}
.obs{border-top:1px solid #21262d}
.obs-label{font-size:10px;text-transform:uppercase;color:#8b949e;padding:5px 10px 0}
.obs .pre{padding:4px 10px 8px;color:#adbac7}
.empty{color:#6e7681;font-style:italic}
footer{max-width:920px;margin:0 auto;padding:0 24px 40px;color:#6e7681;font-size:11px}
`;
