# Claude Code transcript import: design

Status: importer built (`feat/claude-transcript-import`, 34e9c0c); fixes F1 to
F4 built and validated on real data 2026-11-11 (see "Validation"). Claude Code
only.

Related: [session debug mode](2026-11-02-session-debug-mode-design.md). That
design captures one session in full on purpose; this one gives every session a
place in the dashboard after the fact. See "Relationship to debug mode".

## Why

tracetap only saw sessions launched through `tracetap claude`. Most Claude Code
sessions on a typical machine never go through it: on the author's machine 73
of 95 local transcripts came from the desktop app, which cannot be wrapped,
plus IDE and SDK sessions. Those sessions were invisible to `serve`, `search`
and `usage`.

Claude Code already writes every session to
`~/.claude/projects/<project-slug>/<session-uuid>.jsonl`, with subagents in
`<session-uuid>/subagents/agent-<id>.jsonl`. Reading those files covers the
missing sessions with no capture step at all.

## Goals

1. Every local Claude Code session, from any entrypoint, appears in the
   dashboard, search and usage reports.
2. A session that was also wire-captured is counted once. The wire copy wins.
3. What the dashboard shows for an imported session is correct, or says
   plainly that it is missing. It never shows a guess as a measurement.
4. Re-running the import is cheap and picks up new and grown sessions.

## Non-goals

- Changing anything under `~/.claude/projects`. The import is read-only.
- Reconstructing the system prompt or tool definitions. Transcripts do not
  record them.
- Codex, Gemini or Devin transcripts. Devin has its own importer.
- Automatic re-import. It shares the open "serve keeps itself indexed" work
  with debug mode (goal 7 there).

## How it works (as built)

`tracetap claude-transcripts import` lists transcripts, converts each into
synthetic `RawPair`s, writes them as JSONL under `.claude-transcripts-trace/`
(added to `TRACE_DIRS`), and indexes them.

- **One pair per API response.** The request carries `provider:
  "claude-transcript"`, session metadata (`meta`: cwd, git branch, entrypoint,
  version, title), an `anchor` (the last item of the previous response) and a
  `delta`: the user prompts and tool results since then. It does not carry the
  whole resent transcript, which would make output quadratic on sessions with
  thousands of calls.
- **Usage is counted once per response id.** Claude Code writes one record per
  content block, each repeating the response's `message.id` and `usage`. The
  pair that counts an id carries its usage; later pairs for the same id carry
  `usage: null`. Records copied into a resumed session's file belong to the
  original transcript and are skipped there.
- **Wire wins.** When a wire capture carries the same
  `x-claude-code-session-id`, the transcript session is marked
  `shadowedByWire`, hidden by default and not counted in usage. The wire
  session is marked `hasTranscript`.
- **Adapter order.** `ClaudeTranscriptAdapter` matches on the explicit
  provider marker, so it sits ahead of the generic Anthropic adapter.
- **Incremental.** Unchanged files are skipped by size and mtime, and indexing
  is idempotent by content hash.
- **Fixtures are synthetic.** The repo is public; no real transcript content is
  committed.

## Findings on real data (2026-11-04 and 2026-11-11)

Checked against one desktop-app session (`3dd03609…`, 871 calls, 9,132 records):

| What the dashboard showed | What is true | Cause |
| --- | --- | --- |
| 7 compactions, trigger unknown | 1 compaction, `manual` (`/compact`), 808,147 → 17,593 tokens, 86 s, 2026-10-09 03:57 UTC | The wire-side detector runs on imported sessions. Every one of the 7 has "after" = 0 tokens |
| X-Ray empty: 0 chars, no buckets on every call | Messages, thinking, tool results and many context attachments are in the transcript | X-Ray only partitions a full resent request body; imported requests carry a delta |
| Session cost blank | Opus 5.5 is priced; `tracetap usage` does price it | The import indexes with the built-in price table, which lacks the model |

Why the detector fails here: it needs "transcript items fell" and "context
fell" between neighbouring calls. For an imported request, `transcriptItems`
counts the delta, not the transcript, so it rises and falls on every turn. And
the 33 rows with `usage: null` (repeats of a counted response) read as 0
context, so any delta that shrinks next to one of them looks like a 500k-token
drop. The earlier guess that subagent calls were mixed in was wrong: this
session has none.

Record types available in that transcript, besides messages: 690
`total_tokens_reminder`, 259 `deferred_tools_record`, 147 `hook_success`, 140
`hook_additional_context`, 52 `environment`, 17 `deferred_tools_delta`, 5
`skill_listing`, 4 `mcp_instructions_delta`, 4 `instructions`, 1
`compact_boundary`, 1 compact summary (`isCompactSummary`).

## Fixes

### F1. Compactions come from Claude Code's records, never from a guess

- For sessions with `origin = "transcript"`, the wire-side detector does not
  run: not in `serve.ts findCompactions`, not in the timeline.
- The compactions are the session's own `compact_boundary` records (already
  parsed by `src/context/compaction.ts`). For an imported session they are
  attributable to a call, because they come from the same file as the calls:
  each record attaches to the first measured main-thread call at or after its
  timestamp. That point carries `compaction.trigger = { kind: <record trigger>,
  source: "recorded" }` and the record's pre/post sizes.
- Rows with no usage (`usage: null`, a repeat of a response already counted)
  are not separate API calls. They are left out of the timeline's points and
  out of any context-size comparison.
- A subagent-only session shows no compactions; the records belong to the
  main thread (existing `subagentOnly` rule).
- Wire sessions are unchanged: the recorded set wins where it exists and stays
  labelled session-wide; the inferred set is the fallback.

### F2. A "why" panel for each compaction

For every compaction, one panel answers "why did this happen, and what filled
the context":

| Field | Source |
| --- | --- |
| Trigger: `auto` (hit the context limit) or `manual` (`/compact`) | record `trigger` |
| Focus text given to `/compact` | record `userContext`, when present |
| The prompt just before it | last non-noise user step before the record time |
| Before, after, dropped, duration, messages kept | record fields |
| Growth since the previous compaction (or session start): calls, wall time, tokens | timeline points |
| Largest contributors since then: top 5 tool results by size, with tool name and the step they came from, plus the largest user and assistant items | steps between the two compactions |

Served by `GET /api/session/<id>/compactions`, computed on the server so the
page stays a renderer. It works for wire sessions too, wherever recorded
records exist; an inferred compaction gets the fields it can support and says
the trigger is unknown.

### F3. X-Ray built from the transcript

- The importer keeps context attachments as sized, non-prompt delta items:
  `{ kind: "context", bucket, label, chars }`. `skill_listing` and
  `instructions` go to `skills`; `hook_additional_context` to `hook_inject`;
  `deferred_tools_*`, `mcp_instructions_delta`, `environment`, `date` and
  similar to `other`. The compact summary text becomes a sized item in
  `other`, and the boundary itself becomes a `{ kind: "compact_boundary" }`
  delta item. Sizes and labels only: content is not duplicated.
- A new builder, `src/context/transcript-xray.ts`, walks a session's pairs in
  order and keeps a running composition: delta items and response blocks
  (text to `assistant`, thinking to `thinking`, tool-use input to
  `assistant`, tool results to `tool_result`, prompts to `user`). At a
  boundary it resets to the summary plus the kept messages.
- For each measured call it reports the buckets in tokens (same chars/4 rule
  as X-Ray, so numbers reconcile) and a new `unrecorded` bucket, labelled "not
  accounted for", equal to the call's real context size minus the estimated
  buckets, never below 0. When the estimate exceeds the real size, the call is
  flagged rather than scaled.
- The remainder is not only the system prompt and tool definitions; the label
  and legend say so. On the validation session the estimate reached 91% of the
  real size on call 1 (system prompt and tools about 9%), then drifted to 54%
  by the last call. The drift is growth the estimate under-counts: thinking
  content transcripts do not keep, and chars/4 reading code and JSON as fewer
  tokens than the tokenizer does. A calibrated tokens-per-char rule would
  narrow it; that is not built.
- Not counted as context: `hook_success` and `hook_non_blocking_error`
  (hook rows only), and the blocks of errored responses (Claude Code's
  client-side placeholder is never sent back to the model).
- This composition is stored at index time as the call's context metrics, and
  `/api/session/<id>/context/<seq>` returns it for imported sessions.

### F4. Session cost is filled in

`tracetap claude-transcripts import` loads prices the same way `tracetap
index` does (`loadPrices`, honouring `--offline`), so `sessions.cost_usd` is
set for every priced model.

### As built

- Recorded compactions for imported sessions are stored at index time in a
  `transcript_compactions` table, attached to the first pair with usage at or
  after each record, with the preceding prompt resolved from the deltas.
  `recordedCompactions` returns them with `scope: "session"` and a `seq`; wire
  sessions still read `~/.claude/projects` and stay session-wide.
- `requests.measured` marks rows with usage. The transcript timeline drops
  unmeasured rows, including errored `<synthetic>` placeholders.
- Fleet analytics count imported sessions' recorded compactions instead of
  running the detector on them.
- The why payload comes from `src/context/compaction-why.ts`
  (`explainCompactions`, pure) via `Store.compactionInsights()`. For wire
  sessions and inferred compactions, steps carry no timestamps, so "before"
  ends at the step of the last call before the compaction.
- `SCHEMA_VERSION` 12 → 13; importer `IMPORT_FORMAT_VERSION` 2, recorded per
  mirror as `fmt` so older mirrors are rewritten.

## Validation (2026-11-11)

Real session `3dd03609…` imported into a temporary index (not the live one),
`--offline` prices from the local cache:

| Check | Result |
| --- | --- |
| Compactions | 1, `manual`, recorded, 808,147 → 17,593 tokens, 86 s, at call 475. Previously 7 inferred |
| Timeline | 821 points (871 rows minus 50 unmeasured), compaction count 1, peak 807,349 |
| X-Ray | buckets on all 821 points; 27 calls flagged as overshoot |
| Why panel | trigger, preceding prompt, sizes, duration, 2 messages kept, growth of 736k tokens over 439 calls, top 5 tool results, largest user and assistant items; renders in the X-Ray pane with no console errors |
| Cost | main thread $141.49 (was blank) |
| Tests | typecheck clean; `npm test` 455 tests, 453 pass, 0 fail, 2 skipped |

## Rollout

- F1, F3 and F4 change what is stored, so `SCHEMA_VERSION` goes up by one and
  the importer's output format version goes up so existing outputs are
  rewritten. The next import and index rebuilds imported sessions.
- Back up `~/.tracetap/index.db` before the first rebuild, as was done for the
  first import (`index.db.pre-transcripts.bak`).
- Restarting the running `serve` on a new build opens the live index at
  schema 13, which drops and rebuilds every index table from the logs. Existing
  transcript mirrors are format 1 until `claude-transcripts import` rewrites
  them, so run the import after the rebuild.

## Testing

All with synthetic fixtures:

- A fixture with a `compact_boundary`, a compact summary, context
  attachments, a response split across records, and an errored call.
- No inferred compactions for a transcript session, even when the delta sizes
  would trigger the detector.
- The recorded compaction attaches to the right call with `source:
  "recorded"`.
- Zero-usage repeat rows are absent from the timeline.
- The why-panel payload: trigger, focus text, preceding prompt, growth, top
  contributors in size order.
- Transcript X-Ray: running totals per bucket, reset at the boundary,
  `unrecorded` = real size minus estimates, floor at 0 and flagged.
- Cost is non-null when the price table has the model.
- Existing wire-session tests unchanged.

## Relationship to debug mode

- Debug mode is the full-fidelity path: wire traffic shows the exact system
  prompt, tool definitions and every request; full hook payloads show what
  each hook received. Transcript import is the always-there path with known
  gaps (no system prompt, no tool definitions, hook metadata only).
- The debug spec's open question "where do attach-only results appear, given
  hooks only display through a session with wire data" now has a candidate
  answer: an imported session can host them. Not decided here.
- Both depend on `serve` keeping itself indexed. That work should cover the
  transcript import as well as wire logs.

## Open questions

- Calibrate the tokens-per-char rule for transcript X-Ray, or keep chars/4
  for parity with the wire X-Ray?
- The X-Ray compaction header for inferred (wire) compactions reads
  `prePromptTokens` / `postPromptTokens`, which do not exist. Left as is to
  keep wire behaviour unchanged here.

- Imported spend ($3,702) vs the earlier figure ($2,617) differ and are not
  explained yet.
- The proxy raised prompt tokens by about 32% in headless tests (debug spec).
  Comparing a wire capture and the transcript of the same session would show
  where that comes from.
