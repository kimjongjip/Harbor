import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Terminal } from "@xterm/xterm";
import { Markdown } from "./RichMarkdown";
import { api } from "./api";
import { useTheme, terminalTheme } from "./Theme";
import { useTypography } from "./Typography";
import { TerminalDiagramFallback } from "./TerminalDiagramFallback";
import { mermaidFences, nativeDiagramUnsupported } from "./terminal-diagrams";
import { richFragments, type RichFragment } from "./terminal-rich-layout";
import { richSelectionScroll } from "./rich-selection-scroll";
import type { RichTerminalBlock } from "../shared/rich-terminal";
import type { TerminalInfo } from "../shared/types";
import "./terminal-rich.css";

function TypesetBlock({
  block,
  term,
  info,
  fragments = [],
  retainedSlots = 0,
  onRendered,
}: {
  block: RichTerminalBlock;
  term: Terminal;
  info: TerminalInfo;
  fragments?: RichFragment[];
  retainedSlots?: number;
  onRendered(): void;
}) {
  const node = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  const { settings, fontsReady } = useTypography();
  const [raw, setRaw] = useState(false);
  const [revision, setRevision] = useState(0);
  const screen = term.element
    ?.querySelector(".xterm-screen")
    ?.getBoundingClientRect();
  const mount = term.element?.parentElement?.getBoundingClientRect();
  const cellHeight = screen
    ? screen.height / term.rows
    : settings.terminalSize * settings.terminalLineHeight;
  const cellWidth = screen
    ? screen.width / term.cols
    : settings.terminalSize / 2;
  const card = block.placement === "card";
  const width = card
    ? Math.floor(Math.min(900, (screen?.width || 900) - 28))
    : Math.floor(cellWidth * (Math.min(block.columns, term.cols) - 4));
  const colors = terminalTheme(theme);
  const content = useMemo(
    () => (
      <Markdown
        text={block.text}
        location={{ hostId: info.hostId, cwd: block.cwd || info.cwd }}
      />
    ),
    [block.text, block.cwd, info.hostId, info.cwd],
  );

  useEffect(() => {
    const element = node.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout>;
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setRevision((value) => value + 1), 60);
    };
    const mutation = new MutationObserver(changed);
    mutation.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-image-loading"],
    });
    let lastSize = `${element.offsetWidth}:${element.offsetHeight}`;
    const resize = new ResizeObserver(() => {
      const size = `${element.offsetWidth}:${element.offsetHeight}`;
      if (size !== lastSize) {
        lastSize = size;
        changed();
      }
    });
    resize.observe(element);
    return () => {
      clearTimeout(timer);
      mutation.disconnect();
      resize.disconnect();
    };
  }, [block.id]);

  useLayoutEffect(() => {
    if (!node.current || !fontsReady || width <= 0) return;
    const element = node.current;
    let cancelled = false;
    void (async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      for (const image of element.querySelectorAll("img"))
        image.loading = "eager";
      if (
        !block.rows &&
        element.querySelector(
          '[data-image-loading="true"], .mermaid-diagram > p[role="status"]',
        )
      ) {
        await new Promise<void>((resolve) => {
          const selector =
            '[data-image-loading="true"], .mermaid-diagram > p[role="status"]';
          const observer = new MutationObserver(() => {
            if (!element.querySelector(selector)) finish();
          });
          const timer = setTimeout(finish, 2500);
          function finish() {
            clearTimeout(timer);
            observer.disconnect();
            resolve();
          }
          observer.observe(element, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["data-image-loading"],
          });
        });
        if (
          element.querySelector(
            '[data-image-loading="true"], .mermaid-diagram > p[role="status"]',
          )
        )
          throw Error("Media is not ready for native allocation");
      }
      // Later image/diagram changes remeasure through observers. The initial
      // real DOM is already readable; no asynchronous bitmap replaces it.
      const height = Math.ceil(element.getBoundingClientRect().height);
      const rows = Math.ceil(height / cellHeight);
      if (cancelled || !height) return;
      if (height > 8192 || rows > 400)
        throw Error("Typeset allocation exceeds bounds");
      await api(`/terminals/${info.id}/rich/${block.id}/layout`, {
        sessionId: block.sessionId,
        columns: block.columns,
        rows,
        available: true,
      });
      if (!cancelled) onRendered();
    })().catch(() => {
      if (!cancelled)
        void api(`/terminals/${info.id}/rich/${block.id}/layout`, {
          sessionId: block.sessionId,
          columns: block.columns,
          available: false,
        }).catch(() => {});
    });
    return () => {
      cancelled = true;
    };
  }, [
    block.id,
    block.text,
    width,
    cellHeight,
    fontsReady,
    settings.documentSize,
    settings.documentLineHeight,
    info.id,
    revision,
  ]);

  const allocation = Math.max(1, block.rows || 1) * cellHeight;
  return (
    <>
      {Array.from(
        { length: Math.max(1, fragments.length, retainedSlots) },
        (_, slot) => {
          const fragment = fragments[slot];
          const visible = card || !!fragment;
          // Cover glyph overhang at the marker's left edge without touching
          // native text: this extra cell is verified leading whitespace.
          const leadingCover = fragment
            ? Math.min(1, fragment.column) * cellWidth
            : 0;
          const top =
            fragment && screen && mount
              ? screen.top - mount.top + fragment.firstRow * cellHeight
              : 0;
          const left =
            fragment && screen && mount
              ? screen.left -
                mount.left +
                fragment.column * cellWidth -
                leadingCover
              : 0;
          return (
            <article
              key={slot}
              data-terminal-rich={visible ? "true" : undefined}
              data-rich-block={block.id}
              data-rich-fragment={slot}
              aria-hidden={!visible}
              inert={!visible && slot >= retainedSlots}
              className={
                visible
                  ? `terminal-rich-block ${card ? "terminal-rich-card-block" : ""}`
                  : "terminal-rich-measure"
              }
              style={{
                width:
                  (fragment?.columns === undefined
                    ? width
                    : Math.min(width, fragment.columns * cellWidth)) +
                  leadingCover,
                top: visible ? top : 0,
                left: visible ? left : -30000,
                height: card || !fragment ? "auto" : fragment.rows * cellHeight,
                background: colors.background,
                color: colors.foreground,
              }}
            >
              <div
                className="terminal-rich-canvas"
                style={{
                  width,
                  left: leadingCover,
                  height: card || !fragment ? "auto" : allocation,
                  top: card || !fragment ? 0 : -fragment.rowOffset * cellHeight,
                }}
              >
                <div
                  ref={slot === 0 ? node : undefined}
                  className="terminal-rich-content"
                  style={{ width, visibility: raw ? "hidden" : "visible" }}
                >
                  {content}
                </div>
              </div>
              {raw && <pre className="terminal-rich-source">{block.text}</pre>}
              {visible && (
                <button
                  className="terminal-rich-source-toggle"
                  title={raw ? "수식·표 조판 보기" : "이 답변 원문 보기"}
                  onClick={() => setRaw((value) => !value)}
                >
                  {raw ? "조판" : "원문"}
                </button>
              )}
            </article>
          );
        },
      )}
    </>
  );
}

function AnswerCard({
  blocks,
  term,
  info,
  onRendered,
  hidden = false,
}: {
  blocks: RichTerminalBlock[];
  term: Terminal;
  info: TerminalInfo;
  onRendered(): void;
  hidden?: boolean;
}) {
  const legacy = info.agentKind === "claude";
  const [collapsed, setCollapsed] = useState(legacy);
  const [selectedId, setSelectedId] = useState<string>();
  const selected =
    blocks.find((block) => block.id === selectedId) ||
    blocks[blocks.length - 1];
  if (!selected) return null;
  return (
    <section
      className={`terminal-rich-card ${collapsed ? "collapsed" : ""}`}
      aria-label="완료 답변 조판 보기"
      data-terminal-rich="true"
      style={hidden ? { display: "none" } : undefined}
    >
      <header>
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? "▸" : "▾"} 완료 답변 조판 보기
        </button>
        {!collapsed && (
          <select
            aria-label="조판할 완료 답변"
            value={selected.id}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {blocks.map((block, index) => (
              <option key={block.id} value={block.id}>
                답변 {index + 1}
              </option>
            ))}
          </select>
        )}
      </header>
      {!collapsed && (
        <div className="terminal-rich-card-body">
          <TypesetBlock
            key={selected.id}
            block={{ ...selected, placement: "card" }}
            term={term}
            info={info}
            onRendered={onRendered}
          />
        </div>
      )}
    </section>
  );
}

export function TerminalRich({
  term,
  info,
  blocks,
}: {
  term: Terminal;
  info: TerminalInfo;
  blocks: RichTerminalBlock[];
}) {
  const [frame, setFrame] = useState(0);
  const currentSession = info.agentSessionId || info.resumeThreadId;
  const hasDiagramCard = useMemo(
    () =>
      blocks.some(
        (block) =>
          (!currentSession || block.sessionId === currentSession) &&
          (block.placement === "card" || block.renderer !== "rows-v2") &&
          mermaidFences(block.text).length > 0,
      ),
    [blocks, currentSession],
  );
  const layer = useRef<HTMLDivElement>(null);
  // Keep the DOM nodes that own the browser's selection when their reservation
  // scrolls out of view. Removing them collapses even an unfinished drag range.
  const selectedFragments = useRef(new Map<string, number>());
  useEffect(() => {
    const root = layer.current;
    if (!root) return;
    const changed = () => {
      const selection = root.ownerDocument.getSelection();
      const next = new Map<string, number>();
      if (
        selection &&
        !selection.isCollapsed &&
        selection.rangeCount &&
        root.contains(selection.anchorNode)
      ) {
        const range = selection.getRangeAt(0);
        for (const node of root.querySelectorAll<HTMLElement>(
          "[data-rich-block]",
        )) {
          const id = node.dataset.richBlock!;
          if (!range.intersectsNode(node)) continue;
          next.set(
            id,
            Math.max(
              next.get(id) || 0,
              Number(node.dataset.richFragment || 0) + 1,
            ),
          );
        }
      }
      const keys = (map: Map<string, number>) => JSON.stringify([...map]);
      const repaint = keys(next) !== keys(selectedFragments.current);
      selectedFragments.current = next;
      if (repaint) setFrame((v) => v + 1);
    };
    root.ownerDocument.addEventListener("selectionchange", changed);
    return () =>
      root.ownerDocument.removeEventListener("selectionchange", changed);
  }, [term]);
  useEffect(() => {
    let scheduled = 0;
    const update = () => {
      if (!scheduled)
        scheduled = requestAnimationFrame(() => {
          scheduled = 0;
          setFrame((value) => value + 1);
        });
    };
    const subscriptions = [
      term.onWriteParsed(update),
      term.onRender(update),
      term.onScroll(update),
      term.onResize(update),
      term.buffer.onBufferChange(update),
    ];
    const resize = new ResizeObserver(update);
    const root = term.element?.parentElement;
    if (root) resize.observe(root);
    update();
    return () => {
      cancelAnimationFrame(scheduled);
      subscriptions.forEach((sub) => sub.dispose());
      resize.disconnect();
    };
  }, [term]);
  useEffect(() => {
    const root = layer.current;
    if (!root) return;
    const selectionReader = richSelectionScroll(root);
    const wheel = (event: WheelEvent) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        (event.target as Element).closest(
          ".terminal-rich-source, .terminal-rich-card",
        )
      )
        return;
      if (selectionReader.handleWheel(event)) return;
      const canvas = (event.target as Element).closest(".terminal-rich-canvas");
      if (
        canvas &&
        ((event.deltaY > 0 &&
          canvas.scrollTop + canvas.clientHeight < canvas.scrollHeight - 2) ||
          (event.deltaY < 0 && canvas.scrollTop > 0))
      )
        return;
      const selection = root.ownerDocument.getSelection();
      if (
        selection &&
        !selection.isCollapsed &&
        root.contains(selection.anchorNode)
      ) {
        event.preventDefault();
        event.stopPropagation();
        const height =
          term.element?.querySelector(".xterm-screen")?.getBoundingClientRect()
            .height || term.rows * 20;
        const lines =
          event.deltaY *
          (event.deltaMode === 1
            ? 1
            : event.deltaMode === 2
              ? term.rows
              : term.rows / height);
        term.scrollLines(Math.sign(lines) * Math.ceil(Math.abs(lines)));
        return;
      }
      const viewport = term.element?.querySelector(".xterm-viewport");
      if (!viewport) return;
      event.preventDefault();
      event.stopPropagation();
      viewport.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: event.clientX,
          clientY: event.clientY,
          deltaY: event.deltaY,
          deltaX: event.deltaX,
          deltaMode: event.deltaMode,
        }),
      );
    };
    root.addEventListener("wheel", wheel, { passive: false });
    return () => {
      selectionReader.dispose();
      root.removeEventListener("wheel", wheel);
    };
  }, [term]);
  const root = term.element?.parentElement;
  if (!root) return null;
  const current = blocks.filter(
    (block) => !currentSession || block.sessionId === currentSession,
  );
  const buffer = term.buffer.active;
  const lines = Array.from(
    { length: term.rows },
    (_, row) =>
      buffer.getLine(buffer.viewportY + row)?.translateToString(false) || "",
  );
  const fragments = richFragments(lines, current);
  const native = current.filter(
    (b) =>
      b.placement !== "card" &&
      b.renderer === "rows-v2" &&
      // A docked Claude Mods pane narrows the transcript without resizing the
      // PTY. Measure that pending width before markers exist, or native Claude
      // can never receive the height ACK needed to paint its reservation.
      ((b.columns >= 40 &&
        b.columns <= term.cols &&
        b.viewportRows === term.rows) ||
        fragments.has(b.id) ||
        selectedFragments.current.has(b.id)),
  );
  const pending = new Set(
    native
      .filter((b) => !b.rows)
      .slice(-4)
      .map((b) => b.id),
  );
  const cards = current.filter(
    (b) => b.placement === "card" || b.renderer !== "rows-v2",
  );
  const needsDiagramFallback =
    info.agentKind === "codex" &&
    !!currentSession &&
    !hasDiagramCard &&
    nativeDiagramUnsupported(lines);
  return createPortal(
    <div ref={layer} className="terminal-rich-layer" data-frame={frame}>
      {native
        .filter(
          (b) =>
            fragments.has(b.id) ||
            pending.has(b.id) ||
            selectedFragments.current.has(b.id),
        )
        .map((block) => (
          <TypesetBlock
            key={block.id}
            block={block}
            term={term}
            info={info}
            fragments={fragments.get(block.id)}
            retainedSlots={selectedFragments.current.get(block.id)}
            onRendered={() => setFrame((value) => value + 1)}
          />
        ))}
      <AnswerCard
        blocks={cards}
        term={term}
        info={info}
        onRendered={() => setFrame((value) => value + 1)}
        hidden={needsDiagramFallback}
      />
      {info.agentKind === "codex" && currentSession && !hasDiagramCard && (
        <TerminalDiagramFallback
          key={`${info.id}:${info.hostId}:${currentSession}`}
          info={info}
          visible={needsDiagramFallback}
        />
      )}
    </div>,
    root,
  );
}
