import { createHash } from "node:crypto";

const CHUNK = 256 * 1024;
const PAGE_BYTES = 8 * 1024 * 1024;
const RECORD_BYTES = 8 * 1024 * 1024;
type Read = (start: number, length: number) => Promise<string | Buffer>;
export interface ClaudePageCursor {
  at: number;
  size: number;
  modified: number;
  fingerprint: string;
  skip: boolean;
  remaining: number;
}
const invalid = () => new Error("잘못된 Claude 기록 페이지입니다.");
export function decodeClaudePageCursor(cursor?: string): ClaudePageCursor | number {
  if (!cursor) return 0;
  // Open clients may still hold the old message-count cursor after an update.
  if (/^\d{1,8}$/.test(cursor)) return Number(cursor);
  if (!/^claude-v1\.[A-Za-z0-9_-]{1,512}$/.test(cursor)) throw invalid();
  try {
    const value = JSON.parse(Buffer.from(cursor.slice(10), "base64url").toString("utf8"));
    if (!value || ![value.at, value.size, value.remaining].every(Number.isSafeInteger) ||
      value.at < 0 || value.at > value.size || value.size < 0 || value.remaining < 0 || value.remaining > 99999999 ||
      !Number.isFinite(value.modified) || typeof value.skip !== "boolean" || !/^[a-f0-9]{64}$/.test(value.fingerprint)) throw invalid();
    return value;
  } catch { throw invalid(); }
}
export function encodeClaudePageCursor(value: ClaudePageCursor): string {
  return "claude-v1." + Buffer.from(JSON.stringify(value)).toString("base64url");
}
async function range(read: Read, start: number, length: number): Promise<Buffer> {
  const raw = await read(start, length);
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8");
}
/** Check stable bytes at the original snapshot boundaries while allowing append. */
export async function claudeHistoryFingerprint(read: Read, size: number, binding: string): Promise<string> {
  const head = await range(read, 0, Math.min(4096, size));
  const tailStart = Math.max(0, size - 256);
  const tail = await range(read, tailStart, size - tailStart);
  return createHash("sha256").update(binding).update("\0").update(head).update("\0").update(tail).digest("hex");
}

/**
 * Read newest complete JSONL records first. Byte cursors survive appends, and
 * records are decoded only after joining raw chunks so split UTF-8 stays intact.
 * A page reads at most PAGE_BYTES plus one bounded record and one chunk. Huge
 * records are skipped incrementally; their original file is never modified.
 */
export async function readClaudeRecordsBackwards(
  read: Read,
  end: number,
  skipInitial: boolean,
  alive: () => void,
  take: (record: Buffer, start: number) => boolean,
): Promise<{ at: number; skip: boolean; oversized: boolean }> {
  let at = end, scanned = 0, bytes = 0, discarded = skipInitial, oversized = skipInitial;
  let parts: Buffer[] = [];
  const append = (part: Buffer) => {
    bytes += part.length;
    if (bytes > RECORD_BYTES) { discarded = true; oversized = true; parts = []; }
    if (!discarded && part.length) parts.push(part);
  };
  const finish = (start: number) => {
    const stop = !discarded && bytes > 0 && take(Buffer.concat(parts.reverse(), bytes), start);
    parts = []; bytes = 0; discarded = false;
    return stop;
  };
  while (at > 0) {
    alive();
    const start = Math.max(0, at - CHUNK);
    const chunk = await range(read, start, at - start);
    alive();
    // A truncated/replaced file cannot be treated as a complete older page.
    if (chunk.length !== at - start) throw new Error("Claude 기록 파일이 변경됐습니다. 새로고침해 주세요.");
    scanned += chunk.length;
    let right = chunk.length;
    for (let i = chunk.length - 1; i >= 0; i--) {
      if (chunk[i] !== 10) continue;
      append(chunk.subarray(i + 1, right));
      const recordStart = start + i + 1;
      if (finish(recordStart)) return { at: recordStart, skip: false, oversized };
      if (scanned >= PAGE_BYTES && recordStart < end)
        return { at: recordStart, skip: false, oversized };
      right = i;
    }
    append(chunk.subarray(0, right));
    at = start;
    if (at > 0 && scanned >= PAGE_BYTES && (discarded || bytes === 0))
      return { at, skip: discarded, oversized };
  }
  finish(0);
  return { at: 0, skip: false, oversized };
}
