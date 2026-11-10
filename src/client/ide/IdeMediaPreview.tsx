import { lazy, Suspense, useEffect, useState } from "react";
import { Download, Minus, Plus, Scan } from "lucide-react";
import { api } from "../api";
import { fileUrl } from "../ResourcePreview";
import { svgImageUrl } from "../svg-image";
import { fileName } from "./state";
import type { IdeFile, IdeMediaView } from "./types";

const PdfDocument = lazy(() => import("./PdfDocument"));

export default function IdeMediaPreview({
  file,
  kind,
  view,
}: {
  file: IdeFile;
  kind: "image" | "pdf";
  view: IdeMediaView;
}) {
  const [image, setImage] = useState("");
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState<number | "fit">(view.imageZoom ?? "fit");
  useEffect(() => {
    view.imageZoom = zoom;
  }, [zoom, view]);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (kind !== "image") return;
    const controller = new AbortController();
    let objectUrl = "";
    setError("");
    void (async () => {
      // Preserve SVG compatibility with an already-running older backend.
      if (/\.svg$/i.test(file.path)) {
        const data = await api<{ streaming?: boolean }>(
          `/hosts/${encodeURIComponent(file.hostId)}/files/preview?${new URLSearchParams({ path: file.path, cwd: file.root })}`,
          undefined,
          "GET",
          controller.signal,
        );
        if (!data.streaming)
          objectUrl = await svgImageUrl(
            file.hostId,
            file.path,
            controller.signal,
          );
      }
      if (controller.signal.aborted) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        return;
      }
      setImage(objectUrl || fileUrl(file.hostId, file.path, "image"));
    })().catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.hostId, file.path, file.root, kind]);
  const name = fileName(file.path);
  const download = (
    <a
      href={fileUrl(file.hostId, file.path)}
      download={name}
      aria-label="파일 다운로드"
      title="다운로드"
    >
      <Download size={15} />
    </a>
  );
  if (kind === "pdf")
    return (
      <Suspense fallback={<p className="ide-muted">PDF 불러오는 중…</p>}>
        <PdfDocument
          url={fileUrl(file.hostId, file.path, "pdf")}
          name={name}
          view={view}
          download={download}
        />
      </Suspense>
    );
  return (
    <section className="ide-media-preview" aria-label={`이미지 · ${name}`}>
      <div className="ide-media-controls">
        <button
          aria-label="이미지 축소"
          onClick={() =>
            setZoom((z) => Math.max(0.1, (z === "fit" ? 1 : z) / 1.25))
          }
        >
          <Minus size={15} />
        </button>
        <span>
          {zoom === "fit" ? "화면에 맞춤" : `${Math.round(zoom * 100)}%`}
        </span>
        <button
          aria-label="이미지 확대"
          onClick={() =>
            setZoom((z) => Math.min(8, (z === "fit" ? 1 : z) * 1.25))
          }
        >
          <Plus size={15} />
        </button>
        <button aria-label="이미지 화면에 맞춤" onClick={() => setZoom("fit")}>
          <Scan size={15} />
        </button>
        <button onClick={() => setZoom(1)}>100%</button>
        <span className="ide-media-dimensions">
          {dimensions.width > 0 && `${dimensions.width} × ${dimensions.height}`}
        </span>
        {download}
      </div>
      {error ? (
        <p className="ide-error" role="alert">
          {error}
        </p>
      ) : (
        <div className="ide-image-scroll" tabIndex={0}>
          {image ? (
            <img
              src={image}
              alt={name}
              referrerPolicy="no-referrer"
              className={zoom === "fit" ? "fit" : ""}
              style={
                zoom === "fit" ? undefined : { width: dimensions.width * zoom }
              }
              onLoad={(event) =>
                setDimensions({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
              onError={() =>
                setError(
                  "이미지를 불러올 수 없습니다. 파일 형식과 접근 권한을 확인해주세요.",
                )
              }
            />
          ) : (
            <p className="ide-muted">이미지 불러오는 중…</p>
          )}
        </div>
      )}
    </section>
  );
}
