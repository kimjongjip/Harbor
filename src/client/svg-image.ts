import { getToken } from "./api";

// Older backends classify SVG as text. Read the complete file through their
// existing download route, and render only as an inert <img>, never inline HTML.
export async function svgImageUrl(hostId: string, path: string, signal: AbortSignal) {
  const response = await fetch(`/api/hosts/${encodeURIComponent(hostId)}/files/download?${new URLSearchParams({ path })}`, {
    headers: { "X-Harbor-Token": getToken() }, signal,
  });
  if (!response.ok) throw new Error(`SVG 파일을 불러오지 못했습니다 (${response.status}).`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SVG 파일 내용이 없습니다.");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 20 * 1024 * 1024) throw new Error("SVG 미리보기는 20MB까지 지원합니다.");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const blob = new Blob(chunks, { type: "image/svg+xml" });
  const document = new DOMParser().parseFromString(await blob.text(), "image/svg+xml");
  if (document.querySelector("parsererror") || document.documentElement.localName !== "svg" || document.documentElement.namespaceURI !== "http://www.w3.org/2000/svg")
    throw new Error("올바른 SVG 이미지 파일이 아닙니다.");
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  return URL.createObjectURL(blob);
}
