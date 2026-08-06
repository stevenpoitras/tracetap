import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  compactionsForSession,
  parseCompactBoundary,
  readCompactionsFromTranscript,
  transcriptPathsFor,
} from "../dist/context/compaction.js";

/**
 * Compactions as Claude Code RECORDS them.
 *
 * The wire-side inference in timeline.ts was 75% false positives against the
 * live index, and no amount of inference recovers `trigger` — whether the agent
 * compacted itself or the user typed /compact. Claude Code writes both down in
 * its own transcript; this reads them.
 *
 * The fixture below is the real shape, taken from a live record.
 */

const BOUNDARY = JSON.stringify({
  type: "system",
  subtype: "compact_boundary",
  sessionId: "2987eb23-ae8b-4317-a8e6-dc6d58538e2c",
  cwd: "/Users/sp/Documents/git/eMachina",
  timestamp: "2026-08-03T06:16:17.792Z",
  compactMetadata: {
    trigger: "auto",
    preTokens: 206493,
    postTokens: 12484,
    cumulativeDroppedTokens: 194009,
    durationMs: 98436,
    preservedSegment: { headUuid: "a51d88ab", anchorUuid: "f56002e3", tailUuid: "6c0ecd63" },
    preservedMessages: { anchorUuid: "f56002e3", uuids: ["a51d88ab", "673e0acb", "6c0ecd63"] },
  },
});

test("a boundary record is parsed into a measurement", () => {
  const r = parseCompactBoundary(BOUNDARY);
  assert.ok(r);
  assert.equal(r.trigger, "auto");
  assert.equal(r.preTokens, 206493);
  assert.equal(r.postTokens, 12484);
  assert.equal(r.droppedTokens, 194009);
  assert.equal(r.cumulativeDroppedTokens, 194009);
  assert.equal(r.durationMs, 98436);
  assert.equal(r.preservedMessages, 3, "the uuid list is counted, not retained");
  assert.equal(r.claudeSessionId, "2987eb23-ae8b-4317-a8e6-dc6d58538e2c");
  assert.equal(r.cwd, "/Users/sp/Documents/git/eMachina");
  // Seconds, matching every other timestamp in the index — `ts` in SECONDS and
  // `durationMs` in MILLISECONDS is a live trap elsewhere in this codebase.
  assert.equal(r.ts, Date.parse("2026-08-03T06:16:17.792Z") / 1000);
});

test("a manual /compact is distinguishable from an automatic one", () => {
  // The whole reason for reading the transcript at all: nothing on the wire
  // says WHY the context shrank.
  const manual = parseCompactBoundary(
    BOUNDARY.replace('"trigger":"auto"', '"trigger":"manual"').replace(
      '"durationMs":98436',
      '"durationMs":98436,"userContext":"task status, questions, key points"',
    ),
  );
  assert.equal(manual.trigger, "manual");
  assert.equal(manual.userContext, "task status, questions, key points");
});

test("an unrecognised trigger is passed through, not coerced", () => {
  // A newer client naming a third trigger is a fact, not a parse failure.
  const r = parseCompactBoundary(BOUNDARY.replace('"trigger":"auto"', '"trigger":"tool-budget"'));
  assert.equal(r.trigger, "tool-budget");
});

test("non-boundary lines and junk yield nothing, and never throw", () => {
  assert.equal(parseCompactBoundary(""), null);
  assert.equal(parseCompactBoundary('{"type":"user","message":{}}'), null);
  assert.equal(parseCompactBoundary("{ this is not json"), null);
  // A torn tail line mentioning the marker must not fail a whole session.
  assert.equal(parseCompactBoundary('{"subtype":"compact_boundary","compactMeta'), null);
  // Marked as a boundary but carrying no sizes: an assertion that something
  // happened, which the inferred path already provides. Not a measurement.
  assert.equal(
    parseCompactBoundary('{"subtype":"compact_boundary","compactMetadata":{"trigger":"auto"}}'),
    null,
  );
});

test("reading a transcript keeps only the boundaries, in file order", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-compact-"));
  const file = path.join(dir, "t.jsonl");
  const later = BOUNDARY.replace("06:16:17.792Z", "07:16:17.792Z").replace(
    '"preTokens":206493',
    '"preTokens":180000',
  );
  fs.writeFileSync(
    file,
    ['{"type":"user"}', BOUNDARY, '{"type":"assistant"}', later, ""].join("\n"),
  );
  const recs = readCompactionsFromTranscript(file);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].preTokens, 206493);
  assert.equal(recs[1].preTokens, 180000);
  assert.deepEqual(readCompactionsFromTranscript(path.join(dir, "missing.jsonl")), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a session id is located across project slugs and deduplicated", () => {
  // One session's transcript can appear under two project slugs (a worktree, a
  // scratchpad cwd). The same boundary must not be counted twice.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-projects-"));
  const uuid = "2987eb23-ae8b-4317-a8e6-dc6d58538e2c";
  for (const slug of ["-Users-sp-a", "-Users-sp-b"]) {
    fs.mkdirSync(path.join(root, slug), { recursive: true });
    fs.writeFileSync(path.join(root, slug, uuid + ".jsonl"), BOUNDARY + "\n");
  }
  assert.equal(transcriptPathsFor(uuid, root).length, 2, "found under both slugs");
  assert.equal(compactionsForSession(uuid, root).length, 1, "same boundary counted once");

  // A value that cannot be a session id never touches the filesystem.
  assert.deepEqual(transcriptPathsFor("../../etc/passwd", root), []);
  assert.deepEqual(transcriptPathsFor("", root), []);
  assert.deepEqual(compactionsForSession("00000000-0000-4000-8000-000000000000", root), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("records come back in time order regardless of file order", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-projects-"));
  const uuid = "2987eb23-ae8b-4317-a8e6-dc6d58538e2c";
  fs.mkdirSync(path.join(root, "-p"), { recursive: true });
  const later = BOUNDARY.replace("06:16:17.792Z", "09:00:00.000Z").replace(
    '"preTokens":206493',
    '"preTokens":100000',
  );
  fs.writeFileSync(path.join(root, "-p", uuid + ".jsonl"), [later, BOUNDARY].join("\n"));
  const recs = compactionsForSession(uuid, root);
  assert.equal(recs.length, 2);
  assert.ok(recs[0].ts < recs[1].ts, "sorted by time, not by position in the file");
  fs.rmSync(root, { recursive: true, force: true });
});
