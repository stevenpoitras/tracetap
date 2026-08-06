export { HOOK_EVENT_VERSION } from "./types";
export type { HookEvent, HookRow, HookDecision, HookOutcome } from "./types";
export { defaultHooksDir, defaultTracetapDir, hookLogPath, sanitizeSessionId } from "./paths";
export {
  buildHookEvent,
  buildStdinPreview,
  buildStdoutPreview,
  appendHookEvent,
  runTap,
  digest,
  parseDecision,
  outcomeFor,
} from "./tap";
export { runHooksCli, installSnippet, runHooksInstall, runHooksStatus } from "./cli";
export type { InstallOptions } from "./cli";
export {
  discoverHooks,
  findHookFiles,
  wrapCommand,
  MARKER,
} from "./discover";
export type { DiscoveredHook, DiscoverResult } from "./discover";
export {
  trackInject,
  trackSettings,
  uninstallTracking,
} from "./configure";
export type { TrackMode, TrackOptions, TrackResult, UninstallResult } from "./configure";
