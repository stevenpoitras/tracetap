/**
 * The chunked JSONL reader.
 *
 * The interesting cases are all at the 4 MiB chunk seam — a multi-byte
 * character split across it, a record wider than a whole chunk, a file whose
 * last byte is not a newline — because those are exactly what a whole-file
 * `readFileSync` never had to get right.
 */
import assert from "node:assert/strict";
import { constants as BUFFER_CONSTANTS } from "node:buffer";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";

import { eachLineWithHash, hashFile, parseJsonlFile } from "../dist/jsonl.js";

/** Must match CHUNK_BYTES in src/jsonl.ts — the seam under test. */
const CHUNK = 4 * 1024 * 1024;

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracetap-jsonl-"));
});
after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function write(name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

const lines = (p) => {
  const out = [];
  eachLineWithHash(p, (l) => out.push(l));
  return out;
};

test("splits lines and keeps the last one when the file has no trailing newline", () => {
  assert.deepEqual(lines(write("plain.txt", "a\nb\nc")), ["a", "b", "c"]);
  assert.deepEqual(lines(write("trail.txt", "a\nb\nc\n")), ["a", "b", "c"]);
  // Blank lines are passed through; it is the parser that skips them.
  assert.deepEqual(lines(write("blank.txt", "a\n\nb\n")), ["a", "", "b"]);
  assert.deepEqual(lines(write("empty.txt", "")), []);
});

test("strips the CR of a CRLF but not a bare CR inside a line", () => {
  assert.deepEqual(lines(write("crlf.txt", "a\r\nb\r\n")), ["a", "b"]);
  assert.deepEqual(lines(write("midcr.txt", "a\rb\n")), ["a\rb"]);
});

test("the hash matches the whole-file digest it replaces", () => {
  const body = '{"a":1}\n{"b":"héllo ✅"}\n';
  const p = write("hash.jsonl", body);
  const expected = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  assert.equal(hashFile(p), expected);
  // Same value whether or not the caller is also consuming lines.
  assert.equal(eachLineWithHash(p, () => {}), expected);
  // And byte-identical to hashing the decoded string, which is what the old
  // `createHash().update(readFileSync(p, "utf-8"))` watermark did — so existing
  // index watermarks keep matching and nothing re-indexes on upgrade.
  assert.equal(
    crypto.createHash("sha256").update(fs.readFileSync(p, "utf-8")).digest("hex"),
    expected,
  );
});

test("a multi-byte character straddling the chunk boundary survives", () => {
  // "é" is 2 bytes (0xC3 0xA9). Land it so its first byte is the last byte of
  // chunk 1 and its second byte opens chunk 2 — decoding each half alone would
  // yield two U+FFFD replacements.
  const head = "x".repeat(CHUNK - 1);
  const p = write("split.txt", head + "é" + "y\n");
  const got = lines(p);
  assert.equal(got.length, 1);
  assert.equal(got[0], head + "é" + "y");
  assert.ok(!got[0].includes("�"), "no replacement characters");
});

test("a 4-byte emoji straddling the boundary survives at every offset", () => {
  // "🙂" is 4 bytes; slide it across the seam so each of the three interior
  // split points is exercised.
  for (const back of [1, 2, 3]) {
    const head = "x".repeat(CHUNK - back);
    const p = write(`emoji-${back}.txt`, head + "🙂" + "\n");
    const got = lines(p);
    assert.deepEqual(got, [head + "🙂"], `offset ${back}`);
  }
});

test("a record wider than one chunk is assembled, not truncated", () => {
  const big = { id: "wide", blob: "z".repeat(CHUNK + 1024) };
  const p = write("wide.jsonl", '{"id":"before"}\n' + JSON.stringify(big) + '\n{"id":"after"}\n');
  const { records } = parseJsonlFile(p);
  assert.deepEqual(
    records.map((r) => r.id),
    ["before", "wide", "after"],
  );
  assert.equal(records[1].blob.length, CHUNK + 1024);
});

test("a newline landing exactly on the chunk boundary is not lost or doubled", () => {
  // Last byte of chunk 1 is the newline itself.
  const head = "x".repeat(CHUNK - 1);
  const p = write("nl-seam.txt", head + "\n" + "tail\n");
  assert.deepEqual(lines(p), [head, "tail"]);
});

test("parseJsonlFile skips blank and malformed lines", () => {
  const p = write("mixed.jsonl", '{"a":1}\n\nnot json\n{"a":2}\n{"a":\n{"a":3}\n');
  const { records } = parseJsonlFile(p);
  assert.deepEqual(
    records.map((r) => r.a),
    [1, 2, 3],
  );
});

test("the keep filter drops records before they are retained", () => {
  const p = write("keep.jsonl", [1, 2, 3, 4].map((n) => JSON.stringify({ n })).join("\n") + "\n");
  const { records } = parseJsonlFile(p, (r) => r.n % 2 === 0);
  assert.deepEqual(
    records.map((r) => r.n),
    [2, 4],
  );
  // The hash covers the whole file regardless of what the filter kept.
  assert.equal(parseJsonlFile(p, () => false).contentHash, hashFile(p));
});

test("a missing file throws rather than reporting an empty log", () => {
  // The distinction matters: `loadSessionPairs` must be able to tell "gone"
  // from "held no pairs for this session".
  assert.throws(() => hashFile(path.join(dir, "nope.jsonl")), /ENOENT/);
});

// Writes a >512 MB file, so it is opt-in rather than part of every `npm test`:
//   TRACETAP_BIG_FILE_TEST=1 node --test test/jsonl.test.mjs
// The seam tests above cover the mechanism; this one covers the ceiling itself.
test("reads a file larger than V8's max string length", { skip: !process.env.TRACETAP_BIG_FILE_TEST && "set TRACETAP_BIG_FILE_TEST=1 to run (writes >512MB)" }, () => {
  const MAX = BUFFER_CONSTANTS.MAX_STRING_LENGTH;
  // ~1.5 MB per line x enough lines to clear the ceiling, written by appending
  // so the test never builds the oversized string it is proving unnecessary.
  const line = JSON.stringify({ pad: "q".repeat(1_500_000) }) + "\n";
  const count = Math.ceil(MAX / line.length) + 2;
  const p = path.join(dir, "huge.jsonl");
  const fd = fs.openSync(p, "w");
  try {
    for (let i = 0; i < count; i++) fs.writeSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
  const size = fs.statSync(p).size;
  assert.ok(size > MAX, `fixture must exceed ${MAX} bytes, got ${size}`);
  // The behaviour this whole module exists for: the old path throws here.
  assert.throws(() => fs.readFileSync(p, "utf-8"), { code: "ERR_STRING_TOO_LONG" });

  let seen = 0;
  eachLineWithHash(p, () => seen++);
  assert.equal(seen, count);
  fs.rmSync(p);
});
