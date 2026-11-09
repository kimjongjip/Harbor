import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Terminal } from "@xterm/xterm";
import type { RichTerminalBlock } from "../../shared/rich-terminal";
import { claudeModPanels, projectNativeRow } from "./claude-mod-panels";
import {
  mobileFlowParts,
  nativeRow,
  trimNativeRow,
  nativeSeparator,
  clipNativeRuns,
  terminalContentEnd,
  type NativeRun,
} from "./terminal-flow";

interface ReadingSnapshot {
  lines: string[];
  rows: NativeRun[][];
  modLines: string[];
  modRows: NativeRun[][];
  hidden: boolean[];
}

/** A phone reading projection of the unchanged local terminal buffer. */
export function MobileTerminalRich({
  term,
  blocks,
  active,
  updating,
  following,
  hideMods = false,
  preserveModal = false,
  onFlow,
  renderAnswer,
  renderHistory,
}: {
  term?: Terminal;
  blocks: RichTerminalBlock[];
  active: boolean;
  updating: boolean;
  following: boolean;
  hideMods?: boolean;
  preserveModal?: boolean;
  onFlow(node: HTMLElement | null): void;
  renderAnswer(text: string): ReactNode;
  renderHistory?(beforeTexts: string[]): ReactNode;
}) {
  const [limit, setLimit] = useState(400);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [view, setView] = useState({
    lines: [] as string[],
    rows: [] as NativeRun[][],
    hidden: [] as boolean[],
    start: 0,
    width: 0,
    cellHeight: 0,
    fontSize: 14,
    fontFamily: "monospace",
  });
  const prepend = useRef<{ height: number; top: number } | undefined>(
    undefined,
  );
  const frozen = useRef<ReadingSnapshot | undefined>(undefined);
  const projection = useRef(hideMods && !preserveModal);
  const restoreScroll = useRef<number | undefined>(undefined);
  const screen = term?.element?.querySelector<HTMLElement>(".xterm-screen");
  const scroller = screen?.closest<HTMLElement>(".terminal-scroll");
  useLayoutEffect(() => {
    setLimit(400);
    frozen.current = undefined;
  }, [term]);
  useLayoutEffect(() => {
    if (following) {
      setLimit(400);
      setHistoryOpen(false);
    }
  }, [following]);
  useLayoutEffect(() => {
    if (!term || !screen || !scroller || !active || !updating) return;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capture = (start: number, end: number): ReadingSnapshot => {
      const buffer = term.buffer.active;
      const panels = claudeModPanels(buffer, term.cols, term.rows);
      const result: ReadingSnapshot = {
        lines: [],
        rows: [],
        modLines: [],
        modRows: [],
        hidden: [],
      };
      for (let row = start; row < end; row++) {
        const line = buffer.getLine(row);
        const text = line?.translateToString(true) || "";
        const runs = nativeRow(line, term.cols, 0, term.options.theme || {});
        const masked = panels.some(
          (panel) => row >= panel.top && row < panel.bottom,
        )
          ? projectNativeRow(
              line,
              term.cols,
              row,
              panels,
              term.options.theme || {},
            )
          : undefined;
        result.lines.push(text);
        result.rows.push(runs);
        result.modLines.push(
          masked
            ? masked.runs
                .map((run) => run.text)
                .join("")
                .trimEnd()
            : text,
        );
        result.modRows.push(masked?.runs ?? runs);
        result.hidden.push(masked?.hidden ?? false);
      }
      return result;
    };
    // Pause and capture in the same commit. A delayed animation frame may run
    // after a CLI redraw, even though the phone already shows the paused state.
    if (following) frozen.current = undefined;
    else if (!frozen.current && !term.modes.synchronizedOutputMode)
      frozen.current = capture(0, terminalContentEnd(term.buffer.active));
    const update = () => {
      frame = 0;
      if (!screen.clientHeight || !scroller.clientHeight) return;
      if (term.modes.synchronizedOutputMode) {
        clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          schedule();
        }, 60);
        return;
      }
      const buffer = term.buffer.active;
      if (following) frozen.current = undefined;
      else if (!frozen.current)
        frozen.current = capture(0, terminalContentEnd(buffer));
      const snapshot = frozen.current;
      const end = snapshot?.lines.length ?? terminalContentEnd(buffer);
      const start = Math.max(0, end - limit);
      const source = snapshot ?? capture(start, end);
      const offset = snapshot ? start : 0;
      const filtered = hideMods && !preserveModal;
      if (projection.current !== filtered && !following)
        restoreScroll.current = scroller.scrollTop;
      projection.current = filtered;
      const lines = (filtered ? source.modLines : source.lines).slice(offset);
      const sourceRows = (filtered ? source.modRows : source.rows).slice(
        offset,
      );
      const hidden = filtered ? source.hidden.slice(offset) : [];
      // Every screen uses the phone projection, including tool output and code.
      // xterm remains the unchanged ANSI decoder; no PTY resize/input is sent.
      const parts =
        mobileFlowParts(lines, []) ||
        lines.map((_, row) => ({ kind: "row" as const, row, start: 0 }));
      const rows: NativeRun[][] = [];
      for (const part of parts)
        if (part.kind === "row")
          rows[part.row] = clipNativeRuns(sourceRows[part.row], part.start);
      setView({
        lines,
        rows,
        hidden,
        start,
        width: screen.clientWidth,
        cellHeight: screen.clientHeight / term.rows,
        fontSize: term.options.fontSize || 14,
        fontFamily: term.options.fontFamily || "monospace",
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const output = () => {
      if (!following && frozen.current) return;
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          schedule();
        }, 60);
    };
    const listeners = [term.onWriteParsed(output), term.onResize(schedule)];
    const resize = new ResizeObserver(schedule);
    resize.observe(screen);
    resize.observe(scroller);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      resize.disconnect();
      listeners.forEach((listener) => listener.dispose());
    };
  }, [
    term,
    screen,
    scroller,
    active,
    updating,
    following,
    limit,
    hideMods,
    preserveModal,
  ]);
  useLayoutEffect(() => {
    if (!scroller) return;
    if (prepend.current) {
      scroller.scrollTop =
        prepend.current.top + scroller.scrollHeight - prepend.current.height;
      prepend.current = undefined;
    } else if (restoreScroll.current !== undefined) {
      scroller.scrollTop = restoreScroll.current;
    }
    restoreScroll.current = undefined;
  }, [view, scroller]);
  useLayoutEffect(() => {
    if (!active || !updating || !scroller) return;
    const more = () => {
      if (scroller.scrollTop >= 180 || prepend.current) return;
      if (!view.start) {
        if (!following) setHistoryOpen(true);
        return;
      }
      prepend.current = {
        height: scroller.scrollHeight,
        top: scroller.scrollTop,
      };
      setLimit((value) => value + 400);
    };
    scroller.addEventListener("scroll", more, { passive: true });
    const frame = requestAnimationFrame(more);
    return () => {
      scroller.removeEventListener("scroll", more);
      cancelAnimationFrame(frame);
    };
  }, [active, updating, scroller, view.start, following]);
  const parts =
    mobileFlowParts(view.lines, blocks) ||
    view.lines.map((_, row) => ({ kind: "row" as const, row, start: 0 }));
  if (!term || !scroller || !active || !view.width) return null;
  return createPortal(
    <div
      className="mobile-terminal-flow"
      ref={onFlow}
      style={{
        width: "100%",
        fontSize: view.fontSize,
        fontFamily: view.fontFamily,
      }}
    >
      {historyOpen &&
        renderHistory?.(
          parts.flatMap((part) =>
            part.kind === "answer" && part.block ? [part.block.text] : [],
          ),
        )}
      {historyOpen && renderHistory && (
        <div className="mobile-live-boundary">현재 터미널</div>
      )}
      {view.start > 0 && (
        <div className="mobile-history-more">
          위로 올리면 이전 출력을 불러옵니다
        </div>
      )}
      {parts.map((part) =>
        part.kind === "answer" ? (
          <section
            key={part.id}
            className="mobile-rich-reader"
            data-mobile-rich={part.id}
            aria-label="터미널의 완료 답변"
            style={{
              width: "100%",
              fontSize: Math.max(14, view.fontSize + 1),
            }}
          >
            <div className="mobile-rich-body">
              {part.block ? (
                renderAnswer(part.block.text)
              ) : (
                <p className="muted">답변을 불러오는 중입니다…</p>
              )}
            </div>
          </section>
        ) : view.hidden[part.row] ? null : (
          <div
            key={`row:${view.start + part.row}`}
            className={`mobile-native-row${nativeSeparator(view.lines[part.row]) ? " mobile-native-separator" : ""}`}
            data-native-row={view.start + part.row}
            style={{
              minHeight: view.cellHeight,
              lineHeight: `${view.cellHeight}px`,
            }}
          >
            {!nativeSeparator(view.lines[part.row]) &&
              trimNativeRow(view.rows[part.row] || []).map((run, i) => (
                <span key={i} style={run.style}>
                  {run.text}
                </span>
              ))}
          </div>
        ),
      )}
    </div>,
    scroller,
  );
}
