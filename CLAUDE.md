# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`tracetap` captures the full API traffic of coding-agent harnesses (Claude Code, Codex CLI, Gemini CLI — Devin via local-store import instead, since it can't be proxied) into a JSONL log + self-contained HTML viewer, then builds cross-session tooling on top: a SQLite+FTS5 index, a local dashboard (`serve`), usage/spend reports, an egress secret audit, and ATIF export for Harbor/Terminal-Bench interop.

The core trick (see README "Why this exists" / "Tracing Claude"): these harnesses ship as native single-binaries that can't be loader-patched, so tracetap hooks them at the network layer — it spawns the harness as a child process with its API base URL env var (`ANTHROPIC_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`) pointed at a local plaintext HTTP proxy, which forwards to the real API over TLS while teeing bytes into a JSONL log. No MITM, no certs.

## Commands

```bash
npm run build        # tsc compile, src/ -> dist/
npm run typecheck     # tsc --noEmit
npm test              # npm run build && node --test test/*.test.mjs — ALWAYS builds first
npm run clean         # rm -rf dist
```

Run a single test file: `node --test test/store.test.mjs` (must `npm run build` first — see below).
Run tests matching a name: `node --test --test-name-pattern="<pattern>" test/*.test.mjs`.

**Tests import from `dist/`, not `src/`** — e.g. `test/store.test.mjs` does `require("../dist/store/index.js")`. A test change without a rebuild silently runs against stale JS. If a test result looks wrong, rebuild before trusting it.

`scripts/e2e.sh` is the full end-to-end validation gate for the capture→trajectory→ATIF/Harbor→analytics→redaction→index/search→diff→explore(TUI) pipeline, run against fixtures in `src/trajectory/__fixtures__/` and `src/store/__fixtures__/`. See `VALIDATION.md`.

There's no lint script currently wired up; `tsconfig.json` runs in `strict` mode, so `npm run typecheck` is the main static check.

## Architecture

### Entry point and dispatch

`src/tracetap.ts` is the CLI entry (`bin/tracetap`). It's a plain dispatcher: `claude`/`codex`/`gemini` route to per-tool runners (`src/claude-cli.ts`, `src/codex-cli.ts`, `src/gemini-cli.ts`); everything else (`index`, `search`, `usage`, `audit`, `explore`, `serve`, `hooks`, `devin`) is a **lazy dynamic `import()`** so commands that don't need `better-sqlite3` or the Ink/React TUI deps don't pay for loading them. Follow this pattern when adding a new subcommand.

### Capture layer: proxy + logger

- `src/proxy.ts` — local HTTP proxy in front of the real API host. Strips hop-by-hop headers and `content-length`/`content-encoding` (buffers the response to log it without re-compressing). A `logPathMatcher` decides what gets logged when not in `--include-all-requests` mode (default: `/v1/messages` for Anthropic, `/responses` for Codex/OpenAI).
- `src/logger.ts` — `TrafficLogger` writes `RawPair`s (`{request, response, logged_at}`) to JSONL and optionally renders HTML live via a pluggable `HtmlGenerator` (`HTMLGenerator` for Anthropic, `CodexHTMLGenerator` for Codex, etc.). Header redaction (auth/api-key/cookie/session-token headers) is always on; **body** redaction (`--redact-bodies`) is opt-in on capture but on-by-default for ATIF export.

Devin can't be proxied (no equivalent env-var hook into its binary), so `src/devin/importer.ts` reconstructs sessions from Devin's own local session store instead of live capture.

### Trajectory: the agent-agnostic substrate

`src/trajectory/` normalizes captured `RawPair`s from any of the four harnesses into one shape (`Trajectory`: ordered `Step[]` with `ToolCall`/`Observation` stitching and rolled-up token/cost metrics — see `types.ts`). `index.ts` holds an `adapterFor(pair)` registry that tries adapters in a specific order — **Devin first** (strict `provider: "devin"` marker), **Anthropic last** (its `messages[]` shape is the least specific and would false-match otherwise). Everything downstream — the store, analytics, diff, ATIF export, the explore TUI — consumes `Trajectory`, not raw `RawPair`s. When adding a new traced harness, this adapter registry plus a new `AgentAdapter` implementation is the extension point, not the store or serve layer.

### Store: cross-session index (`src/store/`)

`Store` (in `index.ts`) is a single SQLite DB at `~/.tracetap/index.db` with FTS5 over per-step text, built by walking `TRACE_DIRS = [".claude-trace", ".codex-trace", ".gemini-trace", ".devin-trace"]` in indexed paths. Indexing is idempotent via content-hash watermarking — re-indexing an unchanged log file is a no-op. This is the backbone for `search`, `usage`, `audit`, `explore`, and `serve`; if you're touching cross-session behavior, start here.

`src/store/serve.ts` (`tracetap serve`) is a read-only Node-stdlib HTTP server (no framework) that composes one self-contained HTML dashboard per request from `frontend/serve/{app.html,app.css,app.js}` — no build step, no SPA framework, no external requests from the page. An SSE endpoint live-refreshes it when the index changes underneath. `src/store/cli.ts` is a thin CLI wrapper kept separate so `index`/`search` don't force-load `better-sqlite3` for commands that don't need it.

### Context forensics (`src/context/`)

Three related lenses over "what's actually filling the context window":
- `xray.ts` + `xray-buckets.ts` — partitions each request body into a fixed bucket taxonomy (`XRAY_BUCKETS`: system, tools, skills, hook_inject, user, assistant, thinking, tool_result, other) with per-segment char/token estimates and deltas (new/carried/dropped) between consecutive calls in a session.
- `timeline.ts` — per-API-call context-size timeline, annotating compaction events (pre/post size when the resent transcript shrinks).
- `tooltax.ts` — "dead-tool-tax": since tool schemas ride on *every* request, a declared-but-never-invoked tool is paid for repeatedly. Diffs `body.tools[].name` against the session's actual tool-call histogram to surface the dead set, using the same chars/4 sizing heuristic as X-Ray so the numbers reconcile across features.

### Flow (`src/flow/derive.ts`)

Derives an agent-loop graph (user → thinking/actions → hooks → tool results; node kinds: user/thinking/assistant/tool_call/tool_result/hook/api_call) purely from already-indexed steps + hooks + request rows — no additional capture needed. Consumed by `serve`'s Flow view.

### Hooks capture (`src/hooks/`)

Captures Claude Code / Cursor hook fires so they show up in `serve` alongside turns. `discover.ts` scans a repo for hook definitions (`hooks/hooks.json`, `.claude/settings.json`, `.cursor/hooks.json`); `tap.ts` builds sanitized previews of hook stdin/stdout (keeps structural fields like `session_id`/`tool_name`, truncates and drops secret-prone content) and appends to a log; `configure.ts`/`cli.ts` implement `install`/`track`/`uninstall`.

**Important operational fact** (also called out in `.cursor/skills/track-hooks/SKILL.md`): stopping `tracetap serve` does **not** remove installed hook listeners — they live in `hooks/hooks.json` and/or `~/.claude/settings.json` until `tracetap hooks uninstall --restore <repo>` is run explicitly. Always mention this when installing or tracking hooks for a user.

### ATIF export (`src/atif/`)

Exports tracetap's `Trajectory` model to ATIF v1.7 (`ATIF_SCHEMA_VERSION`), a schema mirroring `harbor.models.trajectories` from the Harbor/Terminal-Bench project 1:1 so exported docs work directly with Harbor's validator/visualizers/SFT-RL pipelines. `from-trajectory.ts` does the mechanical field mapping (cache tokens → `cached_tokens`, etc.); `logprobs`/token-id fields are explicitly omitted since wire captures don't carry them. Export redacts bodies **by default** (unlike raw JSONL capture, which doesn't) since ATIF is meant to be shared outward.

### Frontend

`frontend/dist/index.global.js` is a prebuilt/vendored Lit web-component bundle used by the per-agent static HTML report templates (`frontend/template.html`, `codex-template.html`, `gemini-template.html`) — there is **no in-repo build step or bundler config for it**; it's committed as-is (and, unlike root `dist/`, is *not* gitignored). `frontend/serve/` (`app.html`/`app.css`/`app.js`/`charts.js`) is separate — the `tracetap serve` dashboard, composed server-side at request time by `src/store/serve.ts`, not bundled.

## Conventions worth knowing

- Fixtures live under `src/<module>/__fixtures__/*.jsonl` (real-shaped captured traffic, not synthetic) and are shared across trajectory/store/e2e tests.
- New subcommands should be lazy-`import()`ed from `src/tracetap.ts` if they pull in `better-sqlite3` or Ink/React, matching the existing pattern for `index`/`search`/`usage`/`audit`/`explore`/`serve`/`hooks`/`devin`.
- The adapter-order dependency in `src/trajectory/index.ts` (Devin-first, Anthropic-last) is load-bearing — don't reorder without checking shape-overlap between adapters.
