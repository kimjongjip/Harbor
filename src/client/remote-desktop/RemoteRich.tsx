import {
  memo,
  useEffect,
  useRef,
  useState,
  Children,
  isValidElement,
} from "react";
import { createPortal } from "react-dom";
import type { Terminal } from "@xterm/xterm";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { normalizeMath } from "../../shared/links";
import type { RichTerminalBlock } from "../../shared/rich-terminal";
import { richFragments } from "../terminal-rich-layout";
import { MermaidDiagram } from "../MermaidDiagram";
import "katex/dist/katex.min.css";
import "./remote-rich.css";

/** No local API, file bearer token, layout allocation, or untrusted HTML. */
export const RemoteMarkdown = memo(function RemoteMarkdown({
  text,
  onFileLink,
  onAnchor,
}: {
  text: string;
  onFileLink?: (href: string) => boolean;
  onAnchor?: (anchor: string) => void;
}) {
  return (
    <div className="remote-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [rehypeKatex, { strict: false, throwOnError: false, trust: false }],
        ]}
        skipHtml
        components={{
          a: ({ href, children }) =>
            /^https?:\/\//i.test(href || "") ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : href?.startsWith("#") && onAnchor ? (
              <a
                href={href}
                onClick={(event) => {
                  event.preventDefault();
                  onAnchor(href.slice(1));
                }}
              >
                {children}
              </a>
            ) : href && onFileLink && !/^[a-z][a-z\d+.-]*:/i.test(href) ? (
              <a
                href={href}
                onClick={(event) => {
                  event.preventDefault();
                  onFileLink(href);
                }}
              >
                {children}
              </a>
            ) : (
              <span title={href}>{children}</span>
            ),
          pre: ({ children }) => {
            const child = Children.toArray(children)[0];
            if (
              isValidElement<{ className?: string; children?: unknown }>(
                child,
              ) &&
              child.props.className === "language-mermaid"
            )
              return (
                <MermaidDiagram
                  source={String(child.props.children || "").trim()}
                />
              );
            return <pre>{children}</pre>;
          },
          img: ({ alt }) => (
            <span className="remote-rich-image">
              {alt ? `이미지: ${alt}` : "이미지"}
            </span>
          ),
        }}
      >
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  );
});

export default function RemoteRich({
  term,
  blocks,
  sessionId,
}: {
  term?: Terminal;
  blocks: RichTerminalBlock[];
  sessionId?: string;
}) {
  const [, update] = useState(0);
  const [expanded, setExpanded] = useState<string>();
  const layer = useRef<HTMLDivElement>(null);
  const retained = useRef(new Map<string, number>());
  useEffect(() => {
    setExpanded(undefined);
    retained.current.clear();
  }, [term, sessionId]);
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setExpanded(undefined);
      }
    };
    document.addEventListener("keydown", close, true);
    return () => document.removeEventListener("keydown", close, true);
  }, [expanded]);
  useEffect(() => {
    if (!term) return;
    let frame = 0;
    const refresh = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          update((n) => n + 1);
        });
    };
    const subscriptions = [
      term.onRender(refresh),
      term.onScroll(refresh),
      term.onResize(refresh),
      term.buffer.onBufferChange(refresh),
    ];
    const observer = new ResizeObserver(refresh);
    if (term.element?.parentElement)
      observer.observe(term.element.parentElement);
    refresh();
    return () => {
      cancelAnimationFrame(frame);
      subscriptions.forEach((item) => item.dispose());
      observer.disconnect();
    };
  }, [term]);
  useEffect(() => {
    const root = layer.current;
    if (!root || !term) return;
    const selectionChanged = () => {
      const selection = root.ownerDocument.getSelection();
      const next = new Map<string, number>();
      if (
        selection?.rangeCount &&
        !selection.isCollapsed &&
        root.contains(selection.anchorNode)
      ) {
        const range = selection.getRangeAt(0);
        for (const node of root.querySelectorAll<HTMLElement>(
          "[data-rich-block]",
        ))
          if (range.intersectsNode(node))
            next.set(
              node.dataset.richBlock!,
              Math.max(
                next.get(node.dataset.richBlock!) || 0,
                Number(node.dataset.richFragment) + 1,
              ),
            );
      }
      if (JSON.stringify([...next]) !== JSON.stringify([...retained.current])) {
        retained.current = next;
        update((n) => n + 1);
      }
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      const screen = term.element
        ?.querySelector(".xterm-screen")
        ?.getBoundingClientRect();
      const amount =
        event.deltaY *
        (event.deltaMode === 1
          ? 1
          : event.deltaMode === 2
            ? term.rows
            : term.rows / (screen?.height || term.rows * 20));
      if (amount)
        term.scrollLines(Math.sign(amount) * Math.ceil(Math.abs(amount)));
    };
    root.ownerDocument.addEventListener("selectionchange", selectionChanged);
    root.addEventListener("wheel", wheel, { passive: false });
    return () => {
      root.ownerDocument.removeEventListener(
        "selectionchange",
        selectionChanged,
      );
      root.removeEventListener("wheel", wheel);
    };
  }, [term, blocks.length]);
  if (!term?.element?.parentElement) return null;
  const mount = term.element.parentElement;
  const screen = term.element
    .querySelector(".xterm-screen")
    ?.getBoundingClientRect();
  if (!screen?.width || !screen.height) return null;
  const bounds = mount.getBoundingClientRect();
  const height = screen.height / term.rows,
    width = screen.width / term.cols;
  const current = blocks.filter(
    (block) =>
      (!sessionId || block.sessionId === sessionId) &&
      block.renderer === "rows-v2" &&
      block.placement !== "card",
  );
  const lines = Array.from(
    { length: term.rows },
    (_, row) =>
      term.buffer.active
        .getLine(term.buffer.active.viewportY + row)
        ?.translateToString(false) || "",
  );
  // Replay can precede the answer metadata request. Cover only standalone marker
  // reservations during that gap, leaving native text on shared rows intact.
  const pending = new Map<string, RichTerminalBlock>();
  for (const line of lines) {
    const match = /^\s*~HBR:([a-f0-9]{20}):(\d{1,3})~\s*$/.exec(line);
    if (match && !current.some((block) => block.id === match[1]))
      pending.set(match[1], {
        id: match[1],
        sessionId: sessionId || "",
        requestId: "",
        marker: "",
        text: "",
        columns: term.cols,
        viewportRows: term.rows,
        state: "pending",
        renderer: "rows-v2",
        createdAt: 0,
      });
  }
  const source = [...current, ...pending.values()];
  const fragments = richFragments(lines, source);
  const background = term.options.theme?.background || "#ffffff";
  const foreground = term.options.theme?.foreground || "#20242c";
  const full = source.find((block) => block.id === expanded);
  return (
    <>
      {createPortal(
        <div ref={layer} className="remote-rich-layer">
          {source
            .filter(
              (block) =>
                fragments.has(block.id) || retained.current.has(block.id),
            )
            .flatMap((block) => {
              const pieces = fragments.get(block.id) || [];
              return Array.from(
                {
                  length: Math.max(
                    pieces.length,
                    retained.current.get(block.id) || 0,
                  ),
                },
                (_, index) => {
                  const fragment = pieces[index];
                  const leading = fragment
                    ? Math.min(1, fragment.column) * width
                    : 0;
                  const contentWidth = Math.max(
                    1,
                    Math.floor(
                      width * (Math.min(block.columns, term.cols) - 4),
                    ),
                  );
                  return (
                    <article
                      key={`${block.id}:${index}`}
                      className="remote-rich-block"
                      data-rich-block={block.id}
                      data-rich-fragment={index}
                      aria-hidden={!fragment}
                      style={{
                        top: fragment
                          ? screen.top - bounds.top + fragment.firstRow * height
                          : -30000,
                        left: fragment
                          ? screen.left -
                            bounds.left +
                            fragment.column * width -
                            leading
                          : -30000,
                        width:
                          (fragment?.columns === undefined
                            ? contentWidth
                            : Math.min(
                                contentWidth,
                                fragment.columns * width,
                              )) + leading,
                        height: fragment ? fragment.rows * height : 0,
                        background,
                        color: foreground,
                      }}
                    >
                      {block.text ? (
                        <>
                          <div
                            className="remote-rich-canvas"
                            style={{
                              width: contentWidth,
                              left: leading,
                              top: -(fragment?.rowOffset || 0) * height,
                            }}
                          >
                            <RemoteMarkdown text={block.text} />
                          </div>
                          {fragment && (
                            <button
                              className="remote-rich-expand"
                              onClick={() => setExpanded(block.id)}
                            >
                              전체 답변
                            </button>
                          )}
                        </>
                      ) : (
                        fragment && (
                          <span className="remote-rich-pending">
                            완료 답변 불러오는 중…
                          </span>
                        )
                      )}
                    </article>
                  );
                },
              );
            })}
        </div>,
        mount,
      )}
      {full?.text &&
        createPortal(
          <div
            className="remote-rich-dialog-backdrop"
            onClick={() => setExpanded(undefined)}
          >
            <section
              className="remote-rich-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="전체 답변"
              onClick={(event) => event.stopPropagation()}
            >
              <header>
                <strong>전체 답변</strong>
                <button autoFocus onClick={() => setExpanded(undefined)}>
                  닫기
                </button>
              </header>
              <RemoteMarkdown text={full.text} />
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
