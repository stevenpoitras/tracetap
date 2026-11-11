# Session debug mode: design and user flows

Status: revised after spikes and review, 2026-11-02. Claude Code only.

## Why

The main use of tracing is development work: building skills and plugins,
validating hooks, and troubleshooting context growth and compaction. That work
is about one session at a time.

The controls today are not shaped for that:

- Capture is split across two systems with different scopes. Wire capture is
  per launch (`tracetap claude`). Hook capture is global
  (`tracetap hooks install` edits `~/.claude/settings.json`).
- Getting a full picture takes several steps: install taps, launch through the
  wrapper, run `tracetap index`, start `serve`, then find the session.
- `hooks install --full` stores prompt text and tool inputs from every session
  on the machine, when the person only wanted to look at one.
- Changing payload level means an uninstall followed by an install.
- The dashboard goes stale by default. `serve` only reads the index and refreshes
  when something else writes to it, and nothing does unless the person runs
  `tracetap index` or keeps a hand-written reindex loop alive.

## Goals

1. One command gives a full debug capture of one session: wire traffic, full
   hook payloads, and Claude Code's own hook log.
2. It works for a new session and for one already running.
3. Other sessions are unaffected.
4. Nothing is left behind in global settings.
5. When the session ends, the person gets a direct way into the results.
6. The person never has to run `tracetap index` or start `serve` by hand to see
   a debug session.
7. A running `serve` stays current on its own, for all captures, not just debug.

## Non-goals

- Codex, Gemini, Devin and Cursor support.
- Automatic redaction of hook payloads.
- Retention or cleanup of old captures. Existing logs stay as they are.
- Removing `hooks install`, `hooks track` or plain `tracetap claude`. They keep
  working unchanged.
- New dashboard panes. Results appear in the existing `serve` views.
- Parsing Claude Code's debug file into the dashboard.

## Anti-goals

This has failed, even if it technically works, if:

- A debug session silently captures other sessions.
- `~/.claude/settings.json` is modified by any `tracetap debug` command.
- Full payloads keep being written after the debug session ended.
- A failure in tracetap interrupts or breaks the session being debugged. Attach
  is the one accepted exception while its proxy is alive only for that session:
  see "Attach mechanism".
- A debug run records the same observe event twice. A `hooks track` wrapper and
  an observe tap on one event are not duplicates: they have different
  `hook_name`s, and only the wrapper holds the real hook's output.

## Verified facts

Tested on Claude Code 2.1.316 on 2026-11-02.

| Fact | Evidence |
| --- | --- |
| `--settings <file>` hooks fire for that session | Headless probe: SessionStart, UserPromptSubmit and SessionEnd all fired |
| They add to global hooks rather than replacing them | Global taps fired in the same probe |
| Env vars reach hook commands, so `TRACETAP_HOOK_FULL=1` upgrades existing taps. This design does not use it: it would also reach nested `claude` runs | Hook printed `full=1`; global taps wrote `payload` |
| `--resume <id>` keeps the same session id | Headless resume returned the original id |
| Hook events only display through a session with wire data | `listHooksForSession` and `hookOwnerFor` in `src/store/index.ts` |
| `--debug=hooks --debug-file <path>` names each hook, including plugin hooks, with its exit status | Probe debug log |
| A change to `~/.claude/settings.json` applies to a running session | `hooks install` during a live session; events were logged at once |
| `CLAUDE_CODE_SESSION_ID` is set for child processes of a session | Read from env inside a Bash tool call |
| Claude Code owns `--debug` and tracetap forwards unknown flags | `claude --help`; `tracetap --help` |
| Auto mode refused an agent editing its own session's settings | Probe of `.claude/settings.local.json` was denied |
| `ANTHROPIC_BASE_URL` in a project `settings.local.json` applies to a running session | Real auth, `claude -p` stream-json: turn 1 direct, turn 2 captured through the tracetap proxy with full history. Interactive confirmation used a stub API only |
| Hook additions to that file apply live | Interactive session against a stub API |
| The env value is sticky: deleting the key does not revert it; writing `https://api.anthropic.com` does | Stub API |
| Every live session in the project moves, and a later `--resume` launched while the key exists does too | Stub API |
| `!` commands get `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID`, and trigger one model turn | Interactive stub session |
| A dead proxy gives ECONNREFUSED retries; a bigger retry window recovers on the same port | Background session spike |
| Nested `claude` traffic reaches the debug proxy | Spike A |

### Not verified

Run these first, by a person, because attach depends on them:

- The live switch in a real interactive session on real auth.
- Whether auto mode refuses `! tracetap debug attach`, and whether a gateway
  billing notice appears (seen once in a stub run; it needed Enter).
- Why proxied sessions use more prompt tokens: about 32% on this setup, headless,
  even with logging off. Find the cause before trusting context numbers.
- `settings.local.json` location for worktrees and subdirectories.
- Whether a server-managed settings lookup is skipped with a custom base URL.
  Binary strings suggest so; untested.

## Command surface

The name `--debug` is taken by Claude Code, so this is a subcommand.

```
tracetap debug [CLAUDE_ARGS...]      Launch Claude Code with full debug capture
tracetap debug attach [--session id] Full hook capture for a running session
tracetap debug stop [--session id]   End capture for a session and clean up
tracetap debug status                Show what is being captured right now
```

`attach`, `stop` and `status` are reserved first arguments. Anything else goes
to `claude`, the same forwarding rule `tracetap claude` uses. `--run-with`
forces forwarding as it does there.

`status` is read-only. `stop` on a launched session turns off hook payloads and
says that wire capture continues until the session exits, because the proxy
cannot be removed from a running session without breaking it.

## Run, session and arming

A **run** is one launch or one attach. tracetap creates a run id up front, and
every debug file and summary is keyed by it, because the session id is unknown
before launch for `-c` or a bare `--resume`, and `/clear` can change it.

An **arm mark** in `~/.tracetap/debug/` holds run id, kind, session id, owner pid
and owner start time. Taps check it, including global taps.

- **Launch:** an arming tap on SessionStart in the `--settings` file writes the
  mark and adds the id to the run manifest, including after `/clear`. `--settings`
  is not inherited, so a nested `claude` run is never armed.
- **Attach:** the command writes the mark directly and adds a SessionEnd tap.
- **Disarm:** SessionEnd or a dead owner. For attach, also a SessionStart with
  `source` of `resume`, `clear` or `fork`, never `compact`.
- A run only removes marks of its own run.

The in-session and launch paths stay separate verbs. `tracetap debug` always
launches, and inside a session it fails loudly rather than arming the parent.

A person's own `--settings` is merged into the generated file, and their
`--debug-file` is honoured.

## Attach mechanism

Attach keeps the proxy out of normal sessions and uses it only for the attached
one. While attached, that session depends on the proxy, which is the accepted
exception to the failure anti-goal:

- The proxy runs detached, separate from any terminal.
- If it dies, it restarts on the same port. The supervisor is required, and
  recovery by this route is still unproven for interactive sessions.
- Wire logging filters on `x-claude-code-session-id` against the run manifest, so
  a sibling or nested session passes through unlogged. This applies to launch too.

Rejected: an always-on `claude` alias (a proxy crash ends sessions, and a broken
install stops `claude` launching) and `claude --bg --resume` (a live session gets
a diverging copy). tmux `respawn-pane` and an opt-in shell function work as
restart routes and are deferred. A pre-installed `/trace` command is a later
shortcut for `attach`.

## User flows

### 1. Debug a plugin or skill from a fresh session

```
$ tracetap debug --plugin-dir ./my-plugin
```

1. tracetap writes a per-session settings file with taps for the events in
   "Captured data" and starts the proxy.
2. It launches `claude` with `--settings`, `--debug=hooks` and `--debug-file`,
   plus the person's own arguments. If the person passes their own `--debug`,
   theirs wins.
3. The person works normally. A one-line notice says the session is captured
   with full payloads.
4. On exit tracetap indexes this run's logs only, then prints the summary below.
   Counts cover this run, not earlier runs of the same session. If `/clear`
   created more session ids, the summary lists each one.
5. The per-session settings file is deleted.

```
Debug capture complete
  session   c2172616-…  (4 min, 38 requests, 112 hook events)
  open      http://127.0.0.1:4000/#session/<wire-session-id>
  hook log  ~/.tracetap/debug/<run-id>/hooks.log
```

If `serve` is not running, `debug` starts it (see "Indexing and the dashboard"),
so the `open` link always works.

The HTML report does not open in this mode, since the dashboard is where results
live.

### 2. Validate a hook headlessly

```
$ tracetap debug -p "edit README.md" --plugin-dir ./my-plugin
```

Same as flow 1 without a terminal UI. The exit code is Claude Code's. The
summary goes to stderr so stdout stays usable by scripts.

### 3. Notice a problem in a running session

Inside the session, the person types:

```
! tracetap debug attach
```

1. tracetap reads `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID`, and starts a detached
   proxy that exits when that Claude process exits.
2. It writes the base URL and session-pinned taps to the project's
   `.claude/settings.local.json`.
3. Claude Code applies the file. The bang turn itself may still go direct.
4. As soon as the first request from this session reaches the proxy, tracetap
   removes the env key, so later launches and other sessions don't pick it up.
5. It confirms:

```
Full capture on for f3984b26-… (wire and hooks), including earlier context.
Stop with: tracetap debug stop
```

Wire history is complete from the first captured request, because the transcript
is resent. Earlier assistant steps and tool calls may not appear as steps, and
tokens and cost cover captured requests only.

If another live session is detected in the project, attach warns before
switching. If auto mode refuses the write, the message tells the person to run
it themselves. tracetap does not try to detect who ran it.

From another terminal: `tracetap debug attach --session <id>`, run in the project.
Without an id, outside a session, `attach` lists recent sessions and exits: a
wrong guess captures the wrong session.

`tracetap debug stop` writes `https://api.anthropic.com` (or the session's prior
base URL) to the same key, waits for it to apply, then removes the key and taps.

### 4. Troubleshoot context or compaction mid-session

1. The person attaches as in flow 3, or uses `tracetap debug --resume <id>`.
2. X-Ray and the timeline have the context from the first captured request.
3. PreCompact and PostCompact events line up with the context drop.

Compaction must not end a capture: it fires SessionStart with `source=compact`
under the same session id.

A debug run's hooks must show on the same view as that run's wire traffic, and
the summary link must land there. Today `hookOwnerFor` elects one row per session
uuid, and hook logs hold every run of a uuid, so this needs a per-run store query
(log path plus time window). Store changes are in scope.

### 5. Check what is being captured

```
$ tracetap debug status
Active debug captures
  f3984b26-…  attached   hooks   /path/to/project   12 min
Leftover taps: none
Global taps: installed, metadata only
```

`status` is the answer to "is this thing still recording?", and it reports
global taps too, so nothing is hidden.

### 6. Global taps are already installed

`debug` always adds its own taps and does not parse user settings. Duplicate
observe events are collapsed at index time on session, event and `stdin_digest`.
The arm mark also raises existing taps to full payloads for the armed session.

### 7. A session crashes or the terminal closes

The arm mark is owned by a run and records the owner's process id and start time.
A tap treats a mark with a dead owner as unarmed and deletes it. For launch the
owner is the tracetap parent; for attach it is the Claude process.

The detached proxy exits with its owner and removes any taps and env key still in
`settings.local.json`. If that cleanup can't run, `status` reports the leftovers
and the next `debug` command removes those whose owner is dead. `status` itself
changes nothing. A dead owner means a later `--resume` is never captured.

## Indexing and the dashboard

`serve` keeps its own index current, and `tracetap debug` makes sure `serve` is
up. These are the designer's calls.

- **`serve` indexes while it runs.** It starts `tracetap index` as a child
  process on an interval, using the existing content-hash check so an unchanged
  log is skipped. The SSE refresh then works as it does today, because the index
  file changes.
- **A child process, not in-process.** `better-sqlite3` is synchronous, so
  indexing inside the server would block requests. The HTTP surface stays
  read-only.
- **`debug` starts `serve` if it is down.** It checks the port, starts a detached
  `serve` if nothing answers, and reuses one that is already there. It says so
  once. If a different program holds the port, it says so and skips the link.
- **The dashboard keeps running** after the debug session ends, so the link
  stays valid. `tracetap serve --stop` ends it. Nothing is installed to start at
  login.
- **`debug` still indexes its own run at exit**, so results are there immediately
  rather than after the next interval.
- **Indexing gates on mtime and size before hashing.** `hashFile` reads every byte
  of every log today, which an interval can't afford.

The walk behind a default `tracetap index` covers the working directory and the
home directory. Its cost on a large home directory has not been measured. The
builder must measure it and choose an interval or narrower roots so an idle
`serve` stays cheap.

## Captured data

| Data | Launch | Attach |
| --- | --- | --- |
| Wire traffic | yes | from attach onward, with resent history |
| Full hook payloads | yes | from attach onward |
| Claude Code hook log | yes | no |

Hook events tapped: the six in `INSTALL_TAPS`, plus SessionStart and
SessionEnd. Add SubagentStop if it proves observable.

Rows with a payload count as signal: the hooks pane must not hide them and
`hooks prune` must not delete them, even though observe taps are `observeOnly`.

Observe taps show that an event fired and what it received. They do not show
what a person's real hook returned. Claude Code's hook log covers exit status
for every hook, and `hooks track` remains the way to record a real hook's
output.

## Storage

Existing locations stay in use so that indexing keeps working:

- Wire logs: `.claude-trace/` in the working directory.
- Hook events: `~/.tracetap/hooks/<session>.jsonl`.
- New: `~/.tracetap/debug/` for per-session settings, arm marks and Claude
  Code's hook logs.

`.claude-trace/` is ignored in this repo, but plugin development happens in
other repos. If the directory is not git-ignored, `tracetap debug` warns at
launch, because a debug capture holds unredacted prompts. It does not edit the
person's `.gitignore`.

## Privacy

Debug captures store unredacted prompt text, tool inputs and file contents, and
wire logs can include Claude's side calls, such as titles of other sessions. The
launch notice says so once per session.

- `index.db`, its WAL, wire logs and HTML reports are created 0600, and
  `~/.tracetap` is tightened to 0700. Payloads are copied into `index.db`.
- `serve` rejects unexpected Host values, because it now stays running.
- `--redact-bodies` also applies `redactValue` to hook payloads.
- `audit` covers hook logs.

## Failure behaviour

Capture must never get in the way of the session:

- Taps never block: an unreadable arm mark means unarmed. Today a tap can exit 1
  on a spawn or parse failure, which can't block a session but may show an error.
- The summary warns if the arming tap never fired, for example when
  `disableAllHooks` or policy stopped hooks.
- If the proxy cannot start, `tracetap debug` exits before launching Claude
  Code, with an error. It does not launch uncaptured, since the person would
  believe they had a capture.
- If indexing fails at exit, the summary says so and gives the log paths.
- `attach` never rewrites a `settings.local.json` it cannot parse. It reports
  the problem and changes nothing.
- Launcher output goes to stderr in debug mode, and `run()` in `src/claude-cli.ts`
  must return its exit code and log path rather than calling `process.exit`.

## Rollout

Decided here, as the designer's call:

- After this ships, the docs recommend `tracetap debug` for debugging.
  `hooks install` is described as optional background metadata.
- `hooks install --full` keeps working, with a note pointing at `tracetap debug`.
- The current machine has global `--full` taps from today's testing. Removing
  them is a manual step for the owner.

## Left to the builder

- Module layout. Expected: `src/debug/` with a lazy `import()` from
  `src/tracetap.ts`, reusing the `claude-cli.ts` launch path.
- How taps are pinned to a session (a flag on `hooks tap` is the obvious form).
- Arm mark format.
- A store API from log path and session uuid to the owning wire session, for the
  `#session/<id>` link.
- Exact wording of messages.
