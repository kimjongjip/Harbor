import { useEffect, useState } from "react";
import { useTheme } from "./Theme";
import "./mermaid-diagram.css";

let queue = Promise.resolve();
let nextId = 0;
function renderDiagram(source: string, dark: boolean) {
  const result = queue.then(async () => {
    if (source.length > 50_000)
      throw new Error("다이어그램이 너무 큽니다. 코드를 나누어 주세요.");
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: dark ? "dark" : "default",
      maxTextSize: 50_000,
      maxEdges: 500,
      flowchart: { htmlLabels: false },
    });
    const id = `harbor-mermaid-${++nextId}`;
    try {
      return (await mermaid.render(id, source)).svg;
    } finally {
      // Mermaid may leave its measurement container after a parse error.
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function MermaidDiagram({
  source,
  onLink,
}: {
  source: string;
  onLink?: (href: string) => void;
}) {
  const { theme } = useTheme();
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(1);
  const [naturalWidth, setNaturalWidth] = useState(800);
  useEffect(() => {
    let active = true;
    setSvg("");
    setError("");
    setZoom(1);
    void renderDiagram(source, theme === "dark").then(
      (value) => {
        if (active) {
          const element = new DOMParser().parseFromString(
            value,
            "text/html",
          ).querySelector("svg");
          const width = Number(
            element
              ?.getAttribute("viewBox")
              ?.trim()
              .split(/[\s,]+/)[2],
          );
          setNaturalWidth(Number.isFinite(width) && width > 0 ? width : 800);
          setSvg(value);
        }
      },
      (reason) => {
        if (active)
          setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [source, theme]);
  return (
    <figure className="mermaid-diagram">
      <figcaption>
        <span>Mermaid 다이어그램</span>
        {svg && (
          <div className="mermaid-controls">
            <button
              type="button"
              aria-label="흐름도 축소"
              disabled={zoom <= 0.5}
              onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
            >
              −
            </button>
            <button
              type="button"
              aria-label="흐름도 원래 크기"
              onClick={() => setZoom(1)}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              aria-label="흐름도 확대"
              disabled={zoom >= 3}
              onClick={() => setZoom((value) => Math.min(3, value + 0.25))}
            >
              +
            </button>
          </div>
        )}
      </figcaption>
      {svg ? (
        <div
          className="mermaid-viewport"
          tabIndex={0}
          aria-label="다이어그램 그림"
        >
          <div
            className="mermaid-svg"
            style={{ width: `min(${zoom * 100}%, ${naturalWidth * zoom}px)` }}
            onClickCapture={(event) => {
              const anchor =
                event.target instanceof Element
                  ? event.target.closest("a")
                  : null;
              if (!anchor) return;
              event.preventDefault();
              event.stopPropagation();
              const href =
                anchor.getAttribute("href") ||
                anchor.getAttribute("xlink:href");
              if (href && !href.startsWith("#")) onLink?.(href);
            }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      ) : error ? (
        <div className="mermaid-error" role="status">
          <b>다이어그램을 그리지 못했습니다.</b>
          <p>아래 코드를 확인해 주세요. 나머지 문서는 계속 볼 수 있습니다.</p>
          <pre>{error}</pre>
        </div>
      ) : (
        <p role="status">다이어그램을 그리는 중…</p>
      )}
      <details open={error ? true : undefined}>
        <summary>다이어그램 코드</summary>
        <pre>
          <code>{source}</code>
        </pre>
      </details>
    </figure>
  );
}
