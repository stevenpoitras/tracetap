// Transcript-imported sessions: recorded compactions instead of inferred ones
// (F1), the per-compaction "why" payload (F2), X-Ray composition rebuilt from
// the transcript (F3), and prices at import (F4).
//
// The fixture under src/claude-transcripts/__fixtures__/compaction is
// SYNTHETIC: generated to the observed record shapes, no real prompts, paths,
// ids or names. It holds context attachments, a response split across records,
// a response resumed after its tool result (a `usage: null` repeat pair), an
// errored call, a manual `compact_boundary` and the compact summary. Its delta
// sizes are chosen so the wire-side detector WOULD report a compaction at the
// call after the 6,302-token one (fewer delta items, and the next row reads 0
// context) - the false positive F1 removes.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { importTranscript, listTranscripts, ownershipFor, IMPORT_FORMAT_VERSION } = require(
  "../dist/claude-transcripts/importer.js",
);
const { importTranscripts } = require("../dist/claude-transcripts-cli.js");
const { transcriptCompositions } = require("../dist/context/transcript-xray.js");
const { explainCompactions } = require("../dist/context/compaction-why.js");
const { Store } = require("../dist/store/index.js");
const { handleRequest, findCompactions, clearXrayMemo } = require("../dist/store/serve.js");

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const FIXTURE_ROOT = path.join(ROOT, "src", "claude-transcripts", "__fixtures__", "compaction");
const F = "ffffffff-0000-4000-8000-000000000006";
const PRICES = { "claude-opus-5-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } };

/** X-Ray's own sizing rule (xray.ts approxTokens), per item. */
const tok = (n) => Math.ceil(n / 4);
const toolUseChars = (name, input) => JSON.stringify({ name, input }).length;

const cleanups = [];
after(() => {
  for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });
});

function importF() {
  const refs = listTranscripts(FIXTURE_ROOT);
  return importTranscript(refs.find((r) => r.sessionId === F), ownershipFor(refs));
}

async function indexed(tag = "x") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tracetap-ctx-${tag}-`));
  cleanups.push(dir);
  const source = path.join(dir, "projects");
  fs.cpSync(FIXTURE_ROOT, source, { recursive: true });
  const outDir = path.join(dir, "out");
  const dbPath = path.join(dir, "index.db");
  const summary = await importTranscripts({ source, outDir, dbPath, prices: PRICES });
  const store = new Store(dbPath, { prices: PRICES });
  const session = store.listSessions().find((s) => s.title === "Synthetic compaction session");
  return { dir, source, outDir, dbPath, store, session, summary };
}

async function get(store, url) {
  clearXrayMemo();
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => handleRequest(store, req, res));
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      http
        .get(`http://127.0.0.1:${port}${url}`, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null });
          });
        })
        .on("error", (e) => {
          server.close();
          reject(e);
        });
    });
  });
}

// ---------------------------------------------------------------------------
// F3: importer emits sized context items and the boundary
// ---------------------------------------------------------------------------

test("importer: context attachments become sized delta items, never their content", () => {
  const imp = importF();
  assert.equal(imp.pairs.length, 7, "a context-only tail does not make a trailing pair");
  const ctx = imp.pairs.flatMap((p) => p.request.body.delta.filter((d) => d.kind === "context"));
  const by = (label) => ctx.find((d) => d.label === label);
  assert.deepEqual(by("skill_listing"), { kind: "context", bucket: "skills", label: "skill_listing", chars: 40 });
  assert.deepEqual(by("instructions"), { kind: "context", bucket: "skills", label: "instructions", chars: 400 });
  assert.deepEqual(by("hook_additional_context"), {
    kind: "context",
    bucket: "hook_inject",
    label: "hook_additional_context",
    chars: 20,
  });
  assert.deepEqual(by("environment"), { kind: "context", bucket: "other", label: "environment", chars: 60 });
  assert.deepEqual(by("compact summary"), { kind: "context", bucket: "other", label: "compact summary", chars: 2000 });
  // Sizes and labels only: the attachment text is not copied into the mirror.
  const wire = JSON.stringify(imp.pairs);
  assert.ok(!wire.includes("a".repeat(40)), "skill listing text is not duplicated");
  assert.ok(!wire.includes("s".repeat(100)), "compact summary text is not duplicated");
  // The hook attachment is still a hook row too.
  assert.ok(imp.pairs.some((p) => (p.request.body.hooks ?? []).some((h) => h.event === "UserPromptSubmit")));
});

test("importer: the compact_boundary is a delta item carrying the record and what it kept", () => {
  const imp = importF();
  const items = imp.pairs.flatMap((p, seq) =>
    p.request.body.delta.filter((d) => d.kind === "compact_boundary").map((d) => ({ seq, d })),
  );
  assert.equal(items.length, 1);
  const { seq, d } = items[0];
  assert.equal(seq, 6, "rides on the first request after the boundary");
  assert.equal(d.trigger, "manual");
  assert.equal(d.preTokens, 6400);
  assert.equal(d.postTokens, 900);
  assert.equal(d.durationMs, 4000);
  assert.equal(d.preservedMessages, 1);
  assert.equal(d.userContext, "keep the widget notes");
  assert.deepEqual(d.kept, { user: "now refactor".length }, "the preserved prompt, by bucket");
  // Order inside the delta is file order: boundary, then the summary.
  const kinds = imp.pairs[6].request.body.delta.map((x) => x.label ?? x.kind);
  assert.deepEqual(kinds, ["user", "compact_boundary", "compact summary", "user"]);
});

// ---------------------------------------------------------------------------
// F3: running composition
// ---------------------------------------------------------------------------

test("transcript X-Ray: running totals per bucket, unrecorded remainder, overshoot flagged", () => {
  const comp = transcriptCompositions(importF().pairs);
  assert.equal(comp.length, 7);

  // Call 0: what was sent before the first response.
  const c0 = comp[0];
  assert.equal(c0.measured, true);
  assert.equal(c0.realTokens, 3 + 0 + 1000);
  assert.deepEqual(c0.buckets, {
    skills: tok(40) + tok(400),
    hook_inject: tok(20),
    user: tok("build the widget".length),
    unrecorded: 1003 - (tok(40) + tok(400) + tok(20) + tok(16)),
  });
  assert.equal(c0.overshootTokens, 0);

  // Call 1: + thinking, the tool call, and a 10,000-char result. The estimate
  // now exceeds the real 2,102: flagged, never scaled, unrecorded floors at 0.
  const c1 = comp[1];
  assert.equal(c1.buckets.thinking, tok("plan it".length));
  assert.equal(c1.buckets.assistant, tok(toolUseChars("Read", { path: "widget.txt" })));
  assert.equal(c1.buckets.tool_result, tok(10000));
  assert.equal(c1.buckets.unrecorded, 0);
  assert.equal(c1.realTokens, 2102);
  assert.equal(c1.overshootTokens, c1.estimatedTokens - 2102);
  assert.ok(c1.overshootTokens > 0);

  // Call 3 is the usage-null repeat: not a measurement, no remainder.
  assert.equal(comp[3].measured, false);
  assert.equal(comp[3].realTokens, null);
  assert.equal(comp[3].buckets.unrecorded, undefined);

  // Running: tool results accumulate across calls until the boundary.
  assert.equal(comp[4].buckets.tool_result, tok(10000) + tok(8000) + tok(100) + tok(100));
  assert.equal(comp[4].buckets.other, tok(60));
  assert.equal(comp[4].realTokens, 2 + 3000 + 3300);
  assert.equal(comp[4].buckets.unrecorded, 6302 - comp[4].estimatedTokens);

  // Call 6: reset at the boundary to the kept prompt + the summary + new
  // prompts. The `/compact` command line came before the boundary, so it is
  // gone with everything else.
  const c6 = comp[6];
  assert.deepEqual(c6.buckets, {
    user: tok("now refactor".length) + tok("continue".length),
    other: tok(2000),
    unrecorded: 1602 - (tok(12) + tok(8) + tok(2000)),
  });
  assert.equal(c6.buckets.tool_result, undefined, "dropped by the compaction");
  assert.equal(c6.buckets.thinking, undefined);
});

// ---------------------------------------------------------------------------
// F1: recorded compactions, no inference, no zero-usage points
// ---------------------------------------------------------------------------

test("timeline: no inferred compactions on a transcript session, one recorded at the right call", async () => {
  const { store, session } = await indexed("tl");
  assert.equal(session.origin, "transcript");
  const sid = session.sessionId;
  // The fixture really would trip the wire-side detector...
  const inferred = findCompactions(store.listRequests(sid));
  assert.deepEqual(inferred.map((c) => c.seq), [5], "the detector fires on the 0-context error row");
  // ...and the timeline does not run it.
  const tl = store.sessionContextTimeline(sid);
  assert.deepEqual(tl.points.map((p) => p.seq), [0, 1, 2, 4, 6], "usage-null rows are not calls");
  assert.equal(tl.compactionCount, 1);
  const marked = tl.points.filter((p) => p.compaction);
  assert.equal(marked.length, 1);
  const c = marked[0];
  assert.equal(c.seq, 6, "first measured main-thread call at/after the record");
  assert.deepEqual(c.compaction.trigger, { kind: "manual", source: "recorded" });
  assert.equal(c.compaction.preContextTokens, 6400);
  assert.equal(c.compaction.postContextTokens, 900);
  assert.equal(c.compaction.droppedTokens, 5500);
  assert.equal(c.compaction.recorded.userContext, "keep the widget notes");
  assert.equal(c.compaction.recorded.durationMs, 4000);
  // Stored composition rides on the timeline points.
  assert.equal(c.buckets.unrecorded, 1602 - (tok(12) + tok(8) + tok(2000)));
  assert.equal(c.approxTokens, 1602, "estimate + unrecorded = the real size");
  const p1 = tl.points.find((p) => p.seq === 1);
  assert.ok(p1.estimateOvershootTokens > 0, "overshoot is flagged on the point");
  store.close();
});

test("recordedCompactions: a transcript session's records come from its own file, per call", async () => {
  const { store, session } = await indexed("rec");
  const rec = store.recordedCompactions(session.sessionId);
  assert.equal(rec.scope, "session");
  assert.equal(rec.subagentOnly, false);
  assert.equal(rec.records.length, 1);
  assert.equal(rec.records[0].seq, 6);
  assert.equal(rec.records[0].trigger, "manual");
  assert.equal(rec.records[0].preTokens, 6400);
  assert.equal(rec.records[0].claudeSessionId, F);
  store.close();
});

test("serve: a transcript session reports no inferred compactions and serves its X-Ray", async () => {
  const { store, session } = await indexed("serve");
  const sid = encodeURIComponent(session.sessionId);
  const s = await get(store, `/api/session/${sid}`);
  assert.equal(s.status, 200);
  assert.deepEqual(s.json.compactions, [], "the wire-side detector does not run");
  assert.equal(s.json.recordedCompactions.records.length, 1);

  const x = await get(store, `/api/session/${sid}/context/6`);
  assert.equal(x.status, 200);
  const b = Object.fromEntries(x.json.buckets.map((r) => [r.bucket, r.approxTokens]));
  assert.equal(b.unrecorded, 1602 - (tok(12) + tok(8) + tok(2000)));
  assert.equal(b.other, tok(2000));
  assert.equal(x.json.totalApproxTokens, 1602);
  assert.equal(x.json.transcript.realTokens, 1602);
  assert.ok(x.json.segments.some((g) => g.kind === "compact summary"));
  assert.ok(x.json.delta, "delta against the previous call");
  assert.ok(x.json.delta.droppedCount > 0, "the compaction dropped items");

  const x1 = await get(store, `/api/session/${sid}/context/1`);
  assert.ok(x1.json.transcript.overshootTokens > 0);
  store.close();
});

// ---------------------------------------------------------------------------
// F2: the "why" payload
// ---------------------------------------------------------------------------

test("GET /api/session/<id>/compactions: trigger, focus, preceding prompt, growth, top contributors", async () => {
  const { store, session } = await indexed("why");
  const r = await get(store, `/api/session/${encodeURIComponent(session.sessionId)}/compactions`);
  assert.equal(r.status, 200);
  assert.equal(r.json.source, "recorded");
  assert.equal(r.json.compactions.length, 1);
  const c = r.json.compactions[0];
  assert.equal(c.seq, 6);
  assert.equal(c.trigger, "manual");
  assert.equal(c.triggerSource, "recorded");
  assert.equal(c.userContext, "keep the widget notes");
  assert.equal(c.precedingPrompt.text, "go on", "the /compact command itself is noise");
  assert.equal(c.preTokens, 6400);
  assert.equal(c.postTokens, 900);
  assert.equal(c.droppedTokens, 5500);
  assert.equal(c.durationMs, 4000);
  assert.equal(c.preservedMessages, 1);
  // Growth since session start: the four measured calls before it.
  assert.equal(c.growth.since, "session start");
  assert.equal(c.growth.calls, 4);
  assert.equal(c.growth.tokens, 6400 - 1003);
  assert.equal(c.growth.wallMs, 59_000);
  // Top tool results in size order, with tool name and step.
  assert.deepEqual(
    c.topToolResults.map((t) => [t.tool, t.chars]),
    [
      ["Read", 10000],
      ["Bash", 8000],
      ["Edit Edit", 201],
    ],
  );
  assert.ok(c.topToolResults.every((t) => Number.isInteger(t.stepIndex)));
  assert.equal(c.largestUser.chars, "build the widget".length);
  assert.ok(c.largestAssistant && c.largestAssistant.chars > 0);
  store.close();
});

test("explainCompactions: an inferred compaction says the trigger is unknown", () => {
  const out = explainCompactions({
    source: "inferred",
    scope: "session",
    subagentOnly: false,
    events: [{ seq: 2, ts: 30, trigger: "unknown", triggerSource: "inferred", preTokens: 9000, postTokens: 1000 }],
    points: [
      { seq: 0, ts: 10, contextTokens: 4000 },
      { seq: 1, ts: 20, contextTokens: 9000 },
      { seq: 2, ts: 30, contextTokens: 1000 },
    ],
    requests: [
      { seq: 0, ts: 10, agentStepIndex: 2 },
      { seq: 1, ts: 20, agentStepIndex: 3 },
      { seq: 2, ts: 30, agentStepIndex: 5 },
    ],
    steps: [
      { stepIndex: 1, role: "user", message: "do it", observation: "", toolName: "", reasoning: "", toolInput: "" },
      { stepIndex: 2, role: "agent", message: "", observation: "abc", toolName: "Read", reasoning: "", toolInput: "{}" },
      { stepIndex: 3, role: "agent", message: "done", observation: "", toolName: "", reasoning: "", toolInput: "" },
      { stepIndex: 4, role: "user", message: "next", observation: "", toolName: "", reasoning: "", toolInput: "" },
      { stepIndex: 5, role: "agent", message: "ok", observation: "", toolName: "", reasoning: "", toolInput: "" },
    ],
  });
  const c = out.compactions[0];
  assert.equal(c.trigger, "unknown");
  assert.equal(c.triggerSource, "inferred");
  assert.equal(c.userContext, null);
  assert.equal(c.precedingPrompt.text, "do it");
  assert.equal(c.growth.calls, 2);
  assert.equal(c.growth.tokens, 9000 - 4000);
  assert.deepEqual(c.topToolResults.map((t) => t.tool), ["Read"]);
});

// ---------------------------------------------------------------------------
// F4 + rollout
// ---------------------------------------------------------------------------

test("cost is set at import when the price table has the model", async () => {
  const { store, session } = await indexed("cost");
  assert.ok(session.costUsd > 0, `cost ${session.costUsd}`);
  store.close();
});

test("an importer format change rewrites mirrors whose transcript did not change", async () => {
  const { source, outDir, dbPath, store } = await indexed("fmt");
  store.close();
  const again = await importTranscripts({ source, outDir, dbPath, prices: PRICES });
  assert.equal(again.written, 0, "unchanged transcript, same format: skipped");
  // A mirror built by an older importer format.
  const statePath = path.join(outDir, ".import-state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const name = Object.keys(state.mirrors)[0];
  assert.equal(state.mirrors[name].fmt, IMPORT_FORMAT_VERSION);
  state.mirrors[name].fmt = IMPORT_FORMAT_VERSION - 1;
  fs.writeFileSync(statePath, JSON.stringify(state));
  // Simulate the old bytes on disk too, so the rewrite is observable.
  fs.appendFileSync(path.join(outDir, name), "\n");
  const third = await importTranscripts({ source, outDir, dbPath, prices: PRICES });
  assert.equal(third.written, 1, "rebuilt despite an unchanged size+mtime signature");
});
