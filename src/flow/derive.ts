import type { HookRow } from "../hooks/types";

/** Minimal step shape (matches store StepText). */
export interface FlowStepInput {
  stepIndex: number;
  role: string;
  message: string;
  reasoning: string;
  toolName: string;
  toolInput: string;
  observation: string;
  errored: boolean;
}

/** Minimal request shape (matches store RequestRow). */
export interface FlowRequestInput {
  seq: number;
  ts: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number | null;
  promptHash: string;
  agentStepIndex: number | null;
  errored: boolean;
}

/**
 * Agent-loop Flow graph: turns → thinking/actions → hooks → tool results.
 * Derived purely from indexed steps + hooks + request rows (no extra capture).
 */

export type FlowNodeKind =
  | "user"
  | "thinking"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "hook"
  | "api_call"
  | "branch";

export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  label: string;
  ts?: number;
  stepIndex?: number;
  requestSeq?: number;
  hookId?: number;
  /** Parent node id for edges (time-order chain + tool_use linkage). */
  parentId?: string;
  /** Child lane for Task/Agent subagent branches. */
  lane?: number;
  detail?: Record<string, unknown>;
  errored?: boolean;
}

export interface FlowEdge {
  from: string;
  to: string;
  kind: "sequence" | "tool" | "hook" | "branch";
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

function preview(text: string, n = 72): string {
  const flat = (text || "").replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : flat.slice(0, n) + "…";
}

const BRANCH_TOOLS = /^(Task|Agent|task|agent|BestOfNRunner|best-of-n)/i;

/**
 * Derive a Flow graph from session steps, optional hooks, and request rows.
 */
export function deriveFlow(opts: {
  steps: FlowStepInput[];
  hooks?: HookRow[];
  requests?: FlowRequestInput[];
}): FlowGraph {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  let lastId: string | undefined;
  let lane = 0;

  const link = (to: string, kind: FlowEdge["kind"] = "sequence", from = lastId) => {
    if (from) edges.push({ from, to, kind });
    lastId = to;
  };

  // Interleave hooks by timestamp against steps (steps lack ts — use request ts when available).
  const hooks = [...(opts.hooks ?? [])].sort((a, b) => a.ts - b.ts);
  let hookCursor = 0;

  const flushHooksBefore = (ts: number | undefined) => {
    while (hookCursor < hooks.length) {
      const h = hooks[hookCursor];
      if (ts != null && h.ts > ts) break;
      const id = `hook-${h.id}`;
      nodes.push({
        id,
        kind: "hook",
        label: `${h.event}${h.hookName ? " · " + h.hookName : ""}`,
        ts: h.ts,
        hookId: h.id,
        parentId: lastId,
        detail: {
          decision: h.decision,
          outcome: h.outcome,
          durationMs: h.durationMs,
          stdinPreview: h.stdinPreview,
          stdoutPreview: h.stdoutPreview,
        },
        errored: h.outcome === "error" || h.decision === "block",
      });
      link(id, "hook");
      hookCursor++;
    }
  };

  // Map agent step index → request seq for api_call annotations.
  const reqByStep = new Map<number, FlowRequestInput>();
  for (const r of opts.requests ?? []) {
    if (r.agentStepIndex != null) reqByStep.set(r.agentStepIndex, r);
  }

  for (const step of opts.steps) {
    const req = reqByStep.get(step.stepIndex);
    if (req) flushHooksBefore(req.ts || undefined);

    if (step.role === "user" || step.role === "system") {
      const id = `step-${step.stepIndex}`;
      nodes.push({
        id,
        kind: step.role === "system" ? "assistant" : "user",
        label: preview(step.message || step.role),
        stepIndex: step.stepIndex,
        parentId: lastId,
        detail: { message: step.message },
      });
      link(id);
      continue;
    }

    // agent step may contain thinking, text, tools, observations
    if (step.reasoning) {
      const id = `think-${step.stepIndex}`;
      nodes.push({
        id,
        kind: "thinking",
        label: preview(step.reasoning),
        stepIndex: step.stepIndex,
        parentId: lastId,
        detail: { reasoning: step.reasoning },
      });
      link(id);
    }

    if (step.message) {
      const id = `asst-${step.stepIndex}`;
      nodes.push({
        id,
        kind: "assistant",
        label: preview(step.message),
        stepIndex: step.stepIndex,
        requestSeq: req?.seq,
        parentId: lastId,
        detail: { message: step.message },
        errored: step.errored,
      });
      link(id);
    }

    if (req) {
      const id = `api-${req.seq}`;
      nodes.push({
        id,
        kind: "api_call",
        label: `API #${req.seq} · ${req.model || "model"}`,
        ts: req.ts || undefined,
        stepIndex: step.stepIndex,
        requestSeq: req.seq,
        parentId: lastId,
        detail: {
          promptTokens: req.promptTokens,
          completionTokens: req.completionTokens,
          durationMs: req.durationMs,
          promptHash: req.promptHash,
        },
        errored: req.errored,
      });
      link(id);
    }

    const toolNames = (step.toolName || "").split(/\s+/).filter(Boolean);
    const toolInputs = (step.toolInput || "").split("\n");
    const observations = (step.observation || "").split("\n");

    for (let i = 0; i < toolNames.length; i++) {
      const name = toolNames[i];
      const isBranch = BRANCH_TOOLS.test(name);
      if (isBranch) lane += 1;
      const callId = `tool-${step.stepIndex}-${i}`;
      let argsPreview = "";
      try {
        const args = toolInputs[i] ? JSON.parse(toolInputs[i]) : null;
        argsPreview = preview(typeof args === "string" ? args : JSON.stringify(args ?? {}));
      } catch {
        argsPreview = preview(toolInputs[i] || "");
      }
      nodes.push({
        id: callId,
        kind: isBranch ? "branch" : "tool_call",
        label: `${name}${argsPreview ? " · " + argsPreview : ""}`,
        stepIndex: step.stepIndex,
        parentId: lastId,
        lane: isBranch ? lane : 0,
        detail: { tool: name, input: toolInputs[i] || "" },
      });
      link(callId, isBranch ? "branch" : "tool");

      const obs = observations[i] || (i === 0 ? step.observation : "");
      if (obs) {
        const rid = `result-${step.stepIndex}-${i}`;
        nodes.push({
          id: rid,
          kind: "tool_result",
          label: preview(obs),
          stepIndex: step.stepIndex,
          parentId: callId,
          lane: isBranch ? lane : 0,
          detail: { observation: obs },
          errored: step.errored,
        });
        edges.push({ from: callId, to: rid, kind: "tool" });
        lastId = rid;
      }
    }
  }

  // Trailing hooks after last step.
  flushHooksBefore(undefined);
  while (hookCursor < hooks.length) {
    const h = hooks[hookCursor++];
    const id = `hook-${h.id}`;
    nodes.push({
      id,
      kind: "hook",
      label: `${h.event}${h.hookName ? " · " + h.hookName : ""}`,
      ts: h.ts,
      hookId: h.id,
      parentId: lastId,
      detail: {
        decision: h.decision,
        outcome: h.outcome,
        durationMs: h.durationMs,
        stdinPreview: h.stdinPreview,
        stdoutPreview: h.stdoutPreview,
      },
      errored: h.outcome === "error" || h.decision === "block",
    });
    link(id, "hook");
  }

  return { nodes, edges };
}
