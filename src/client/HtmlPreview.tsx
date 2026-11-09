import { useEffect, useState } from "react";
import { api } from "./api";
import { readHtmlSource } from "./html-source";

export function HtmlPreview({
  hostId,
  path,
  name,
}: {
  hostId: string;
  path: string;
  name: string;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [source, setSource] = useState<{
    text: string;
    truncated: boolean;
  } | null>(null);
  const [showSource, setShowSource] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    setUrl("");
    setError("");
    setSource(null);
    void api<{ url: string }>(
      `/hosts/${hostId}/files/html`,
      { path },
      "POST",
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setUrl(result.url);
      })
      .catch((e) => {
        if (!cancelled)
          setError(
            controller.signal.aborted
              ? "HTML 연결 시간이 초과됐습니다. 다시 시도해 주세요."
              : e.message,
          );
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [hostId, path, revision]);
  useEffect(() => {
    if (!showSource || !url || source !== null) return;
    const controller = new AbortController();
    void readHtmlSource(url, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setSource(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [showSource, url, source]);
  return (
    <section className="html-file-preview" aria-label="HTML 문서">
      <div className="preview-markdown-toolbar">
        <button
          className="button secondary small"
          onClick={() => setShowSource((value) => !value)}
        >
          {showSource ? "웹페이지 보기" : "원문 보기"}
        </button>
        <button
          className="button secondary small"
          onClick={() => setRevision((value) => value + 1)}
        >
          새로고침
        </button>
      </div>
      {error ? (
        <div className="inline-error" role="alert">
          {error}
        </div>
      ) : !url ? (
        <p role="status">HTML 문서를 불러오고 있습니다…</p>
      ) : showSource ? (
        <>
          {source?.truncated && (
            <p className="preview-data-notice" role="status">
              원문은 처음 512KB만 표시합니다. 웹페이지 보기는 전체 문서를
              사용하며, 전체 원문은 다운로드할 수 있습니다.
            </p>
          )}
          <pre className="html-source">
            {source?.text ?? "원문을 불러오고 있습니다…"}
          </pre>
        </>
      ) : (
        <iframe
          title={`HTML 미리보기 · ${name}`}
          src={url}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
        />
      )}
    </section>
  );
}
