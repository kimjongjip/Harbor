/** Bounded pipelined SFTP reads. Each worker owns a disjoint byte range, and
 * short packets are completed before advancing. All reads settle before the
 * caller closes the handle, including failures. */
export async function readSftpRange(
  read: (
    target: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<number>,
  start: number,
  length: number,
): Promise<Buffer> {
  const target = Buffer.alloc(length);
  const chunk = 32768;
  let next = 0,
    end = length,
    failed = false;
  const worker = async () => {
    try {
      while (!failed && next < length) {
        const offset = next;
        next += chunk;
        const limit = Math.min(length, offset + chunk);
        let at = offset;
        while (!failed && at < limit) {
          const count = await read(target, at, limit - at, start + at);
          if (!Number.isInteger(count) || count < 0 || count > limit - at)
            throw new Error("Invalid SFTP read length");
          if (!count) {
            end = Math.min(end, at);
            break;
          }
          at += count;
        }
      }
    } catch (error) {
      failed = true;
      throw error;
    }
  };
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(8, Math.ceil(length / chunk)) }, worker),
  );
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
  return target.subarray(0, end);
}
