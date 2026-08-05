import * as fs from "fs";
import * as path from "path";

/**
 * Discover Claude Code / Cursor hook definitions under a repo root.
 */

export interface DiscoveredHook {
  /** Stable id for selection: `sourceIndex:event:ordinal`. */
  id: string;
  source: string;
  sourceKind: "claude-plugin" | "claude-settings" | "cursor-hooks";
  event: string;
  matcher?: string;
  type: string;
  command: string;
  /** Command with ${CLAUDE_PLUGIN_ROOT} resolved when possible. */
  resolvedCommand: string;
  timeout?: number;
  /** Suggested short name for --name. */
  suggestedName: string;
  alreadyTracked: boolean;
}

export interface DiscoverResult {
  root: string;
  sources: string[];
  hooks: DiscoveredHook[];
}

const MARKER = "tracetap hooks tap";

const CANDIDATE_FILES = [
  "hooks/hooks.json",
  ".claude-plugin/hooks/hooks.json",
  "plugin/hooks/hooks.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".cursor/hooks.json",
];

function sourceKindFor(rel: string): DiscoveredHook["sourceKind"] {
  if (rel.includes(".cursor/")) return "cursor-hooks";
  if (rel.includes("settings")) return "claude-settings";
  return "claude-plugin";
}

function suggestedName(command: string, event: string, i: number): string {
  const base = path.basename(command.replace(/["']/g, "").split(/\s+/).pop() || event);
  const stem = base.replace(/\.(mjs|js|py|sh|ts)$/i, "");
  const clean = stem.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "") || event;
  return `${clean}`.slice(0, 48) || `hook-${i}`;
}

function resolveCommand(command: string, pluginRoot: string | null): string {
  if (!pluginRoot) return command;
  return command.split("${CLAUDE_PLUGIN_ROOT}").join(pluginRoot);
}

function walkUpFind(start: string, relParts: string[]): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, ...relParts);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Find likely hook definition files under root (and a few well-known relatives). */
export function findHookFiles(root: string): string[] {
  const absRoot = path.resolve(root);
  const found = new Set<string>();
  for (const rel of CANDIDATE_FILES) {
    const p = path.join(absRoot, rel);
    if (fs.existsSync(p)) found.add(path.resolve(p));
  }
  // Also accept a hooks.json discovered by walking up from cwd for plugin roots.
  const up = walkUpFind(absRoot, ["hooks", "hooks.json"]);
  if (up) found.add(up);
  return [...found].sort();
}

function parseHookFile(filePath: string, root: string): DiscoveredHook[] {
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return [];
  }
  const hooksObj = raw?.hooks;
  if (!hooksObj || typeof hooksObj !== "object") return [];

  const rel = path.relative(root, filePath) || path.basename(filePath);
  const kind = sourceKindFor(rel.replace(/\\/g, "/"));
  // Plugin root is the parent of hooks/ when file is hooks/hooks.json
  let pluginRoot: string | null = null;
  if (path.basename(path.dirname(filePath)) === "hooks") {
    pluginRoot = path.dirname(path.dirname(filePath));
  }

  const out: DiscoveredHook[] = [];
  let ordinal = 0;
  for (const [event, matchers] of Object.entries(hooksObj)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      const matcherStr =
        matcher && typeof matcher === "object" && typeof matcher.matcher === "string"
          ? matcher.matcher
          : undefined;
      const list = matcher?.hooks;
      if (!Array.isArray(list)) continue;
      for (const h of list) {
        if (!h || typeof h !== "object") continue;
        const type = String(h.type || "command");
        const command = typeof h.command === "string" ? h.command : "";
        if (!command && type === "command") continue;
        const id = `${rel}:${event}:${ordinal}`;
        const resolved = resolveCommand(command, pluginRoot);
        out.push({
          id,
          source: filePath,
          sourceKind: kind,
          event,
          matcher: matcherStr,
          type,
          command,
          resolvedCommand: resolved,
          timeout: typeof h.timeout === "number" ? h.timeout : undefined,
          suggestedName: suggestedName(command || event, event, ordinal),
          alreadyTracked: command.includes(MARKER) || resolved.includes(MARKER),
        });
        ordinal += 1;
      }
    }
  }
  return out;
}

/** Discover hook commands under a workspace root. */
export function discoverHooks(root = process.cwd()): DiscoverResult {
  const absRoot = path.resolve(root);
  const sources = findHookFiles(absRoot);
  const hooks: DiscoveredHook[] = [];
  for (const file of sources) {
    hooks.push(...parseHookFile(file, absRoot));
  }
  return { root: absRoot, sources, hooks };
}

/** Wrap a shell command so it is observed by tracetap hook-tap. */
export function wrapCommand(
  command: string,
  opts: { name: string; event: string; tracetapBin?: string },
): string {
  if (command.includes(MARKER)) return command;
  const bin = opts.tracetapBin || "tracetap";
  // Use -- so the original command (with quotes) is preserved as argv via shell.
  return `${bin} hooks tap --name ${shellQuote(opts.name)} --event ${shellQuote(opts.event)} -- ${command}`;
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9._/-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export { MARKER };
