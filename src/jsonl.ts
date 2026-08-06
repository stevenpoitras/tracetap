/**
 * Reading capture logs without ever holding one as a single string.
 *
 * V8 caps a string at `buffer.constants.MAX_STRING_LENGTH` — 536,870,888 bytes
 * on 64-bit Node 22. A long-running agent session blows past that: the log
 * behind one live capture reached 888 MB, at which point
 * `fs.readFileSync(path, "utf-8")` throws `ERR_STRING_TOO_LONG` and every
 * caller that slurps the file fails at once. The failure is quiet in both
 * directions — the indexer's per-file `catch` skipped the file, so new sessions
 * from that repo stopped appearing, and the X-Ray reader's `catch` returned
 * null, which the dashboard renders as "context unavailable / No request body".
 * Neither surface said "this file is too big to read".
 *
 * Nothing about the WORK needs the whole file: a JSONL log is consumed one line
 * at a time, and the same 888 MB file streams in 3.5 s at 36 MB of heap. So the
 * reader is chunked, and the string ceiling now applies per line (1.19 MB at
 * the widest on that capture) rather than per file.
 *
 * Synchronous by design. `indexFile`, `indexHookFile` and `loadSessionPairs`
 * are all sync and reached from sync call sites; `readline` would have turned
 * the store's whole read path async for no gain.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";

/** 4 MiB: large enough that syscall overhead vanishes, small enough to hold. */
const CHUNK_BYTES = 4 * 1024 * 1024;

/** LF. Safe to split on: every byte of a multi-byte UTF-8 sequence is >= 0x80. */
const LF = 0x0a;

/**
 * Stream a file's lines, hashing its bytes as it goes.
 *
 * @param filePath file to read.
 * @param onLine called once per line, in file order, with trailing `\r`
 *   stripped. Empty lines are passed through — callers already skip them.
 * @returns the sha256 of the file's bytes, hex-encoded.
 *
 * The digest is taken over the RAW BYTES, which for any valid UTF-8 file is
 * byte-identical to the old `createHash().update(utf8String)` — so existing
 * content-hash watermarks keep matching and nothing re-indexes on upgrade. A
 * file containing invalid UTF-8 is the one exception: decoding used to fold bad
 * sequences to U+FFFD, so its digest changes and it re-indexes once.
 */
export function eachLineWithHash(
  filePath: string,
  onLine: (line: string) => void,
): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    // Bytes after the last newline of the previous chunk. Held as a Buffer, not
    // a string: a multi-byte character straddling the chunk boundary would
    // decode to U+FFFD twice if each half were stringified on its own.
    let carry: Buffer = Buffer.alloc(0);
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, CHUNK_BYTES, null);
      if (read === 0) break;
      const bytes = chunk.subarray(0, read);
      hash.update(bytes);
      let buf = carry.length ? Buffer.concat([carry, bytes]) : Buffer.from(bytes);
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(LF, start);
        if (nl === -1) break;
        onLine(decodeLine(buf, start, nl));
        start = nl + 1;
      }
      carry = start < buf.length ? Buffer.from(buf.subarray(start)) : Buffer.alloc(0);
      buf = Buffer.alloc(0);
    }
    // A final line with no trailing newline is still a line.
    if (carry.length) onLine(decodeLine(carry, 0, carry.length));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** Decode `buf[start, end)` as UTF-8, dropping a CR that precedes the LF. */
function decodeLine(buf: Buffer, start: number, end: number): string {
  const stop = end > start && buf[end - 1] === 0x0d ? end - 1 : end;
  return buf.toString("utf8", start, stop);
}

/**
 * The sha256 of a file's bytes, hex-encoded, without parsing anything.
 *
 * The watermark check runs against every log on every `index` pass and almost
 * always says "unchanged", so it must not pay for JSON parsing to find out.
 */
export function hashFile(filePath: string): string {
  return eachLineWithHash(filePath, () => {});
}

/**
 * Parse a JSONL file into `T[]`, skipping blank and malformed lines.
 *
 * @param keep optional per-record filter, applied BEFORE the record is
 *   retained. A log holding forty conversations only needs the one being
 *   inspected, and dropping the rest as they are parsed is what keeps peak
 *   memory proportional to the answer instead of to the file.
 * @returns the kept records and the file's content hash, so a caller that needs
 *   both (the indexer's watermark) still reads the file exactly once.
 */
export function parseJsonlFile<T>(
  filePath: string,
  keep?: (record: T) => boolean,
): { records: T[]; contentHash: string } {
  const records: T[] = [];
  const contentHash = eachLineWithHash(filePath, (raw) => {
    const line = raw.trim();
    if (!line) return;
    let parsed: T;
    try {
      parsed = JSON.parse(line) as T;
    } catch {
      return; // Skip malformed lines.
    }
    if (!keep || keep(parsed)) records.push(parsed);
  });
  return { records, contentHash };
}
