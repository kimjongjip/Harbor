import test from "node:test";
import assert from "node:assert/strict";
import { readSftpRange } from "./sftp-range";

test("SFTP history ranges pipeline at most eight reads, preserve order and complete short packets", async () => {
  const source = Buffer.from(Array.from({ length: 500000 }, (_, i) => i % 251));
  let active = 0,
    peak = 0;
  const bytes = await readSftpRange(
    async (target, offset, length, position) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((done) => setTimeout(done, position % 3));
      const count = Math.min(length, 7000, source.length - position);
      source.copy(target, offset, position, position + count);
      active--;
      return count;
    },
    123,
    256 * 1024,
  );
  assert.deepEqual(bytes, source.subarray(123, 123 + 256 * 1024));
  assert.equal(peak, 8);
  assert.equal(active, 0);
});
test("EOF returns only available bytes and failures drain outstanding requests before closing", async () => {
  const source = Buffer.alloc(40000, 42);
  const bytes = await readSftpRange(
    async (target, offset, length, position) => {
      const count = Math.max(0, Math.min(length, source.length - position));
      if (count) source.copy(target, offset, position, position + count);
      return count;
    },
    0,
    100000,
  );
  assert.deepEqual(bytes, source);
  let active = 0;
  await assert.rejects(
    readSftpRange(
      async (_target, _offset, _length, position) => {
        active++;
        await new Promise((done) => setTimeout(done, position === 0 ? 0 : 10));
        active--;
        if (position === 0) throw new Error("fixture failure");
        return 32768;
      },
      0,
      256 * 1024,
    ),
    /fixture failure/,
  );
  assert.equal(active, 0);
});
