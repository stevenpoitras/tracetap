import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Default root for tracetap local state: `~/.tracetap`. */
export function defaultTracetapDir(): string {
  return path.join(os.homedir(), ".tracetap");
}

/** Default hook JSONL directory: `~/.tracetap/hooks`. */
export function defaultHooksDir(): string {
  return path.join(defaultTracetapDir(), "hooks");
}

/** Path for one session's append-only hook log. */
export function hookLogPath(sessionId: string, hooksDir = defaultHooksDir()): string {
  const safe = sanitizeSessionId(sessionId);
  return path.join(hooksDir, `${safe}.jsonl`);
}

/** Keep filenames portable: alnum, dash, underscore, colon → underscore. */
export function sanitizeSessionId(sessionId: string): string {
  const s = String(sessionId || "unknown").trim() || "unknown";
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 180);
}

export function ensureDir(dir: string, mode?: number): void {
  fs.mkdirSync(dir, { recursive: true, mode });
}
