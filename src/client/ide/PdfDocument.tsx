import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Minus,
  Plus,
  Scan,
  Search,
} from "lucide-react";
import { getDocument, GlobalWorkerOptions, version } from "pdfjs-dist";
import type { PDFViewer, EventBus } from "pdfjs-dist/web/pdf_viewer.mjs";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import type { IdeMediaView } from "./types";

GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfDocument({
  url,
  name,
  download,
  view,
}: {
  url: string;
  name: string;
  download: ReactNode;
  view: IdeMediaView;
}) {
  const container = useRef<HTMLDivElement>(null);
  const viewer = useRef<PDFViewer | undefined>(undefined);
  const events = useRef<EventBus | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [scale, setScale] = useState(100);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [password, setPassword] = useState("");
  const [passwordNeeded, setPasswordNeeded] = useState(false);
  const passwordReply = useRef<((password: string) => void) | undefined>(
    undefined,
  );
  useEffect(() => {
    let cancelled = false;
    let instance: PDFViewer | undefined;
    let observer: ResizeObserver | undefined;
    const initialPage = view.pdfPage || 1;
    const initialScale = view.pdfScale ?? "page-width";
    const base = `/pdfjs/${version}/`;
    const task = getDocument({
      url,
      cMapUrl: base + "cmaps/",
      cMapPacked: true,
      standardFontDataUrl: base + "standard_fonts/",
      wasmUrl: base + "wasm/",
      iccUrl: base + "iccs/",
      disableAutoFetch: true,
      disableStream: true,
    });
    task.onPassword = (reply: (value: string) => void) => {
      if (!cancelled) {
        passwordReply.current = reply;
        setPasswordNeeded(true);
      }
    };
    // Load after the core initializes pdfjsLib; this stays outside the startup bundle.
    void (async () => {
      const { PDFViewer, EventBus, PDFLinkService, PDFFindController } =
        await import("pdfjs-dist/web/pdf_viewer.mjs");
      if (cancelled || !container.current) return;
      const bus = new EventBus();
      const links = new PDFLinkService({
        eventBus: bus,
        externalLinkTarget: 2,
      });
      const find = new PDFFindController({ eventBus: bus, linkService: links });
      instance = new PDFViewer({
        container: container.current,
        eventBus: bus,
        linkService: links,
        findController: find,
        annotationMode: 1,
        maxCanvasPixels: 12 * 1024 * 1024,
      });
      viewer.current = instance;
      events.current = bus;
      links.setViewer(instance);
      bus.on("pagesinit", () => {
        if (!cancelled && instance) {
          if (typeof initialScale === "number")
            instance.currentScale = initialScale;
          else instance.currentScaleValue = initialScale;
          instance.currentPageNumber = Math.min(
            initialPage,
            instance.pagesCount,
          );
        }
      });
      bus.on("pagechanging", (e: { pageNumber: number }) => {
        if (!cancelled) {
          setPage(e.pageNumber);
          view.pdfPage = e.pageNumber;
        }
      });
      bus.on("scalechanging", (e: { scale: number }) => {
        if (!cancelled) {
          setScale(Math.round(e.scale * 100));
          view.pdfScale =
            instance?.currentScaleValue === "page-width"
              ? "page-width"
              : e.scale;
        }
      });
      bus.on("pagerendered", (e: { error?: Error }) => {
        if (!cancelled && e.error) setError(e.error.message);
      });
      const pdf = await task.promise;
      if (cancelled) return;
      setPages(pdf.numPages);
      instance.setDocument(pdf);
      links.setDocument(pdf);
      observer = new ResizeObserver(() => {
        if (!cancelled && instance?.pagesCount) {
          if (instance.currentScaleValue === "page-width")
            instance.currentScaleValue = "page-width";
          instance.update();
        }
      });
      observer.observe(container.current);
    })().catch((e) => {
      if (!cancelled) setError(e.message || "PDF를 불러올 수 없습니다.");
    });
    // Handle a failure even if the viewer module is still loading.
    void task.promise.catch(() => {});
    return () => {
      cancelled = true;
      observer?.disconnect();
      instance?.setDocument(null!);
      viewer.current = undefined;
      events.current = undefined;
      passwordReply.current = undefined;
      void task.destroy().catch(() => {});
    };
  }, [url]);
  function search(backwards = false) {
    events.current?.dispatch("find", {
      source: viewer.current,
      type: "again",
      query,
      phraseSearch: true,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: backwards,
    });
  }
  return (
    <section
      className="ide-media-preview ide-pdf-preview"
      aria-label={`PDF · ${name}`}
    >
      <div className="ide-media-controls">
        <button
          aria-label="PDF 이전 페이지"
          disabled={page <= 1}
          onClick={() => {
            if (viewer.current) viewer.current.currentPageNumber = page - 1;
          }}
        >
          <ChevronLeft size={15} />
        </button>
        <input
          aria-label="PDF 페이지"
          type="number"
          min={1}
          max={pages || 1}
          value={page}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (viewer.current && n >= 1 && n <= pages)
              viewer.current.currentPageNumber = n;
          }}
        />
        <span>/ {pages || "…"}</span>
        <button
          aria-label="PDF 다음 페이지"
          disabled={page >= pages}
          onClick={() => {
            if (viewer.current) viewer.current.currentPageNumber = page + 1;
          }}
        >
          <ChevronRight size={15} />
        </button>
        <button
          aria-label="PDF 축소"
          disabled={!pages}
          onClick={() => {
            if (viewer.current)
              viewer.current.currentScale = Math.max(
                0.25,
                viewer.current.currentScale / 1.2,
              );
          }}
        >
          <Minus size={15} />
        </button>
        <span>{scale}%</span>
        <button
          aria-label="PDF 확대"
          disabled={!pages}
          onClick={() => {
            if (viewer.current)
              viewer.current.currentScale = Math.min(
                4,
                viewer.current.currentScale * 1.2,
              );
          }}
        >
          <Plus size={15} />
        </button>
        <button
          aria-label="PDF 너비에 맞춤"
          disabled={!pages}
          onClick={() => {
            if (viewer.current) viewer.current.currentScaleValue = "page-width";
          }}
        >
          <Scan size={15} />
        </button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
        >
          <input
            aria-label="PDF 내용 찾기"
            placeholder="내용 찾기"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button aria-label="PDF 찾기" disabled={!pages}>
            <Search size={15} />
          </button>
        </form>
        {download}
      </div>
      {passwordNeeded && (
        <form
          className="ide-media-controls"
          onSubmit={(e) => {
            e.preventDefault();
            passwordReply.current?.(password);
            setPassword("");
            setPasswordNeeded(false);
          }}
        >
          <label>
            PDF 암호{" "}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          </label>
          <button>열기</button>
        </form>
      )}
      {error && (
        <p className="ide-error" role="alert">
          {error}
        </p>
      )}
      <div className="ide-pdf-stage">
        <div className="ide-pdf-scroll" ref={container} tabIndex={0}>
          <div className="pdfViewer" />
        </div>
      </div>
    </section>
  );
}
