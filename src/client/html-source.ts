export const HTML_SOURCE_LIMIT = 512 * 1024;

/** Source inspection is bounded even when an older server ignores Range. */
export async function readHtmlSource(url: string, signal: AbortSignal) {
  const response = await fetch(url, {
    signal,
    headers: { Range: `bytes=0-${HTML_SOURCE_LIMIT - 1}` },
  });
  if (
    response.status === 416 &&
    response.headers.get("Content-Range") === "bytes */0"
  ) {
    await response.body?.cancel();
    return { text: "", truncated: false };
  }
  if (!response.ok)
    throw new Error(
      "HTML 원문을 읽지 못했습니다. 새로고침 후 다시 시도해 주세요.",
    );
  const total =
    response.headers.get("Content-Range")?.match(/\/(\d+)$/)?.[1] ??
    response.headers.get("Content-Length");
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0,
    complete = false;
  try {
    while (bytes < HTML_SOURCE_LIMIT) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      const part = value.subarray(0, HTML_SOURCE_LIMIT - bytes);
      parts.push(decoder.decode(part, { stream: true }));
      bytes += part.length;
    }
    if (complete) parts.push(decoder.decode());
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return {
    text: parts.join(""),
    truncated: total ? Number(total) > bytes : !complete,
  };
}
