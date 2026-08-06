import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CANDIDATE_FILES, MARKER, unwrapCommand, wrapCommand, type DiscoveredHook } from "./discover";
import { ensureDir } from "./paths";

/**
 * Apply / remove tracetap tracking wrappers on discovered hooks.
 *
 * Two modes:
 *   - inject: rewrite the source hooks.json in-place (best for plugin hooks —
 *     single fire, full stdout capture). Creates `*.tracetap.bak`.
 *   - settings: merge observe/wrap entries into ~/.claude/settings.json
 *     (additive; can double-fire if the plugin hook stays enabled).
 */

export type TrackMode = "inject" | "settings";

/** Shared knobs for the track modes. `full` maps 1:1 to the tap's `--full`. */
export interface TrackOptions {
  /** Emit `--full` on the generated tap: store whole hook stdin on each event. */
  full?: boolean;
}

export interface TrackResult {
  mode: TrackMode;
  tracked: number;
  skipped: number;
  files: string[];
  warnings: string[];
}

export interface UninstallResult {
  settingsCleared: boolean;
  filesRestored: string[];
  removedCommands: number;
  /** Read/parse/write failures — surfaced, never swallowed: a silent skip
   *  reads as a clean uninstall while the taps keep firing. */
  errors: string[];
}

function settingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function writeJson(file: string, data: any): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function backupOnce(file: string): string | null {
  const bak = file + ".tracetap.bak";
  if (!fs.existsSync(bak)) {
    fs.copyFileSync(file, bak);
    return bak;
  }
  return null;
}

/**
 * Inject tap wrappers into the source hooks.json files for the selected hooks.
 */
export function trackInject(
  hooks: DiscoveredHook[],
  tracetapBin = "tracetap",
  opts: TrackOptions = {},
): TrackResult {
  const byFile = new Map<string, DiscoveredHook[]>();
  for (const h of hooks) {
    if (h.type !== "command") continue;
    const list = byFile.get(h.source) || [];
    list.push(h);
    byFile.set(h.source, list);
  }

  let tracked = 0;
  let skipped = 0;
  const files: string[] = [];
  const warnings: string[] = [];

  for (const [file, list] of byFile) {
    let data: any;
    try {
      data = readJson(file);
    } catch (err) {
      warnings.push(`skip ${file}: ${(err as Error).message}`);
      skipped += list.length;
      continue;
    }
    if (!data.hooks || typeof data.hooks !== "object") {
      skipped += list.length;
      continue;
    }

    backupOnce(file);
    const selected = new Set(list.map((h) => h.id));
    // Re-walk structure and wrap matching command entries by ordinal id reconstruction.
    let ordinal = 0;
    const relHint = list[0]?.id.split(":")[0] || "";
    for (const [event, matchers] of Object.entries(data.hooks)) {
      if (!Array.isArray(matchers)) continue;
      for (const matcher of matchers as any[]) {
        const hookList = matcher?.hooks;
        if (!Array.isArray(hookList)) continue;
        for (const h of hookList) {
          const id = `${relHint}:${event}:${ordinal}`;
          // Match by event+command against selected hooks (ids may use different rel paths).
          const hit = list.find(
            (d) =>
              d.event === event &&
              d.command === h.command &&
              (selected.has(d.id) || selected.has(id)),
          );
          ordinal += 1;
          if (!hit) continue;
          if (typeof h.command !== "string" || h.command.includes(MARKER)) {
            skipped += 1;
            continue;
          }
          h.command = wrapCommand(h.command, {
            name: hit.suggestedName,
            event: hit.event,
            tracetapBin,
            full: opts.full,
          });
          tracked += 1;
        }
      }
    }
    writeJson(file, data);
    files.push(file);
  }

  return { mode: "inject", tracked, skipped, files, warnings };
}

/**
 * Merge wrapped (or observe) hooks into ~/.claude/settings.json.
 * Warns that plugin hooks may still fire unwrapped alongside these.
 */
export function trackSettings(
  hooks: DiscoveredHook[],
  tracetapBin = "tracetap",
  opts: TrackOptions = {},
): TrackResult {
  const sp = settingsPath();
  let existing: any = {};
  if (fs.existsSync(sp)) {
    try {
      existing = readJson(sp);
    } catch (err) {
      return {
        mode: "settings",
        tracked: 0,
        skipped: hooks.length,
        files: [],
        warnings: [`Could not parse ${sp}: ${(err as Error).message}`],
      };
    }
  }

  backupOnce(sp);
  const out = { ...existing, hooks: { ...(existing.hooks || {}) } };
  let tracked = 0;
  let skipped = 0;
  const warnings: string[] = [];

  for (const h of hooks) {
    if (h.type !== "command") {
      skipped += 1;
      continue;
    }
    const cmd = wrapCommand(h.resolvedCommand || h.command, {
      name: h.suggestedName,
      event: h.event,
      tracetapBin,
      full: opts.full,
    });
    if ((h.resolvedCommand || h.command).includes(MARKER)) {
      skipped += 1;
      continue;
    }
    const entry = {
      matcher: h.matcher,
      hooks: [
        {
          type: "command",
          command: cmd,
          ...(h.timeout != null ? { timeout: h.timeout } : {}),
        },
      ],
    };
    // Strip undefined matcher
    if (!entry.matcher) delete (entry as any).matcher;

    const arr = Array.isArray(out.hooks[h.event]) ? [...out.hooks[h.event]] : [];
    const already = JSON.stringify(arr).includes(cmd);
    if (already) {
      skipped += 1;
      continue;
    }
    arr.push(entry);
    out.hooks[h.event] = arr;
    tracked += 1;
    if (h.sourceKind === "claude-plugin") {
      warnings.push(
        `${h.suggestedName}: also still fires from plugin ${h.source} — prefer 'inject' mode to avoid double-run`,
      );
    }
  }

  ensureDir(path.dirname(sp));
  writeJson(sp, out);
  return { mode: "settings", tracked, skipped, files: [sp], warnings };
}

/**
 * Remove tracetap tap wrappers from settings.json and restore any
 * `*.tracetap.bak` files trackInject created under root — plugin hooks.json,
 * project settings, and cursor hooks alike. Sources whose backup is gone get
 * their wrappers unwrapped in place instead.
 */
export function uninstallTracking(opts?: { restoreBackupsUnder?: string }): UninstallResult {
  let settingsCleared = false;
  let removedCommands = 0;
  const filesRestored: string[] = [];
  const errors: string[] = [];

  const sp = settingsPath();
  if (fs.existsSync(sp)) {
    try {
      const data = readJson(sp);
      if (data.hooks && typeof data.hooks === "object") {
        for (const [event, matchers] of Object.entries(data.hooks)) {
          if (!Array.isArray(matchers)) continue;
          const next = [];
          for (const matcher of matchers) {
            if (!matcher?.hooks || !Array.isArray(matcher.hooks)) {
              next.push(matcher);
              continue;
            }
            const kept = matcher.hooks.filter((h: any) => {
              const hit = typeof h.command === "string" && h.command.includes(MARKER);
              if (hit) removedCommands += 1;
              return !hit;
            });
            if (kept.length === 0) continue; // drop empty matcher
            next.push({ ...matcher, hooks: kept });
          }
          if (next.length) data.hooks[event] = next;
          else delete data.hooks[event];
        }
        writeJson(sp, data);
        settingsCleared = true;
      }
    } catch (err) {
      errors.push(`could not clean ${sp}: ${(err as Error).message}`);
    }
  }

  const root = opts?.restoreBackupsUnder ? path.resolve(opts.restoreBackupsUnder) : null;
  if (root && fs.existsSync(root)) {
    // trackInject rewrites (and backs up) any CANDIDATE_FILES source, so every
    // one of them is a restore candidate — not just the plugin hooks.json.
    for (const rel of CANDIDATE_FILES) {
      const target = path.join(root, rel);
      const bak = target + ".tracetap.bak";
      if (fs.existsSync(bak)) {
        try {
          fs.copyFileSync(bak, target);
          filesRestored.push(target);
        } catch (err) {
          errors.push(`could not restore ${target}: ${(err as Error).message}`);
        }
        continue;
      }
      // No backup: unwrap remaining tap wrappers in place. Inject wrapped the
      // only copy of the user's hook, so strip the wrapper, never the hook.
      removedCommands += unwrapFile(target, errors);
    }
  }

  return { settingsCleared, filesRestored, removedCommands, errors };
}

/** Replace wrapped commands in one hook file with their originals. */
function unwrapFile(file: string, errors: string[]): number {
  if (!fs.existsSync(file)) return 0;
  let data: any;
  try {
    data = readJson(file);
  } catch (err) {
    errors.push(`could not parse ${file}: ${(err as Error).message}`);
    return 0;
  }
  if (!data?.hooks || typeof data.hooks !== "object") return 0;
  let changed = 0;
  for (const matchers of Object.values(data.hooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers as any[]) {
      if (!Array.isArray(matcher?.hooks)) continue;
      for (const h of matcher.hooks) {
        if (typeof h?.command !== "string" || !h.command.includes(MARKER)) continue;
        const original = unwrapCommand(h.command);
        if (original == null) continue;
        h.command = original;
        changed += 1;
      }
    }
  }
  if (changed) {
    try {
      writeJson(file, data);
    } catch (err) {
      errors.push(`could not write ${file}: ${(err as Error).message}`);
      return 0;
    }
  }
  return changed;
}

export { settingsPath };
