import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Terminal } from "@xterm/xterm";
import type { RichTerminalBlock } from "../shared/rich-terminal";
import {
  mobileFlowParts,
  clipNativeRuns,
  trimNativeRow,
  type NativeRun,
} from "./mobile/terminal-flow";
import {
  nativeFlowFrame,
  nativeFlowRows,
  nativeFlowCursorOffset,
  nativeFlowLinkAt,
  type NativeFlowFrame,
} from "./terminal-native-flow";
export type { NativeFlowFrame } from "./terminal-native-flow";

const emptyBlocks: RichTerminalBlock[] = [];
interface View {
  frame: NativeFlowFrame;
  rows: NativeRun[][];
  start: number;
  cursorOffset: number;
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  blocks: RichTerminalBlock[];
}
const NativeRow = memo(function NativeRow({
  row,
  runs,
  cursorOffset,
  lineHeight,
}: {
  row: number;
  runs: NativeRun[];
  cursorOffset?: number;
  lineHeight: number;
}) {
  let offset = 0;
  const nodes: ReactNode[] = [];
  const shown = trimNativeRow(runs);
  if (cursorOffset !== undefined) {
    const length = shown.reduce((n, run) => n + run.text.length, 0);
    if (length <= cursorOffset)
      shown.push({
        text: " ".repeat(cursorOffset - length + 1),
        style: runs.at(-1)?.style || {},
      });
  }
  for (const [index, run] of shown.entries()) {
    const local = cursorOffset === undefined ? -1 : cursorOffset - offset;
    if (local >= 0 && local < run.text.length) {
      const width = String.fromCodePoint(run.text.codePointAt(local)!).length;
      nodes.push(
        <span key={index} style={run.style}>
          {run.text.slice(0, local)}
          <span
            data-native-cursor="true"
            style={{
              boxShadow: "inset 0 0 0 1px currentColor",
              background: "color-mix(in srgb, currentColor 15%, transparent)",
            }}
          >
            {run.text.slice(local, local + width)}
          </span>
          {run.text.slice(local + width)}
        </span>,
      );
    } else
      nodes.push(
        <span key={index} style={run.style}>
          {run.text}
        </span>,
      );
    offset += run.text.length;
  }
  return (
    <div
      className="terminal-native-row"
      data-native-row={row}
      data-rich-block={`native-row:${row}`}
      data-terminal-rich="true"
      style={{
        minHeight: lineHeight,
        lineHeight: `${lineHeight}px`,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}
    >
      {nodes}
    </div>
  );
});

/** A selectable native buffer projection. It never writes, resizes or replays PTY input. */
export function TerminalNativeFlow({
  term,
  blocks = emptyBlocks,
  active = true,
  frozen = false,
  startRow = 0,
  onFrame,
  onInput,
  renderAnswer,
  onLink,
}: {
  term: Terminal;
  blocks?: RichTerminalBlock[];
  active?: boolean;
  frozen?: boolean;
  startRow?: number | ((frame: NativeFlowFrame) => number);
  onFrame?(frame: NativeFlowFrame): void;
  onInput?(): void;
  renderAnswer?(text: string): ReactNode;
  onLink?(text: string): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View | null>(null);
  const latest = useRef({ blocks, active, frozen, startRow, onFrame, onInput });
  latest.current = { blocks, active, frozen, startRow, onFrame, onInput };
  const previous = useRef<View | null>(null);
  const refresh = useRef(() => {});
  useLayoutEffect(() => {
    previous.current = null;
    let scheduled = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const selected = () => {
      const selection = root.current?.ownerDocument.getSelection();
      return (
        !!selection &&
        !selection.isCollapsed &&
        (!!root.current?.contains(selection.anchorNode) ||
          !!root.current?.contains(selection.focusNode))
      );
    };
    const capture = () => {
      scheduled = false;
      if (
        disposed ||
        !latest.current.active ||
        latest.current.frozen ||
        selected()
      )
        return;
      if (term.modes.synchronizedOutputMode) {
        timer = setTimeout(schedule, 60);
        return;
      }
      const frame = nativeFlowFrame(term);
      const start = Math.min(
        frame.end,
        Math.max(
          0,
          Math.floor(
            typeof latest.current.startRow === "function"
              ? latest.current.startRow(frame)
              : latest.current.startRow,
          ),
        ),
      );
      const rows = nativeFlowRows(term, frame, start);
      const old = previous.current;
      // Unchanged rows retain their objects and DOM when neighboring output changes.
      for (let index = 0; index < rows.length; index++) {
        const before = old?.rows[start + index - old.start];
        if (before && JSON.stringify(before) === JSON.stringify(rows[index]))
          rows[index] = before;
      }
      const next: View = {
        frame,
        start,
        rows,
        cursorOffset: nativeFlowCursorOffset(
          term.buffer.active.getLine(frame.cursorRow),
          frame.cursorColumn,
        ),
        fontSize: term.options.fontSize || 14,
        fontFamily: term.options.fontFamily || "monospace",
        lineHeight: Math.max(
          term.options.fontSize || 14,
          (term.element?.querySelector<HTMLElement>(".xterm-screen")
            ?.clientHeight || 0) / term.rows ||
            (term.options.fontSize || 14) * (term.options.lineHeight || 1.2),
        ),
        blocks: latest.current.blocks,
      };
      previous.current = next;
      setView(next);
      if (
        !old ||
        old.frame.cursorRow !== frame.cursorRow ||
        old.frame.cursorColumn !== frame.cursorColumn ||
        old.frame.columns !== frame.columns ||
        old.frame.baseY !== frame.baseY ||
        old.frame.bufferType !== frame.bufferType ||
        old.frame.lines.length !== frame.lines.length ||
        old.frame.lines.some((line, row) => line !== frame.lines[row])
      )
        latest.current.onFrame?.(frame);
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = undefined;
      // The parsed terminal buffer is ready independently of browser painting.
      // Electron can suspend RAF while occluded, leaving a history-boundary-only
      // change stale until the next mouse interaction. Coalesce without waiting
      // for paint; stream writes still use the bounded output timer below.
      if (!scheduled && !disposed) {
        scheduled = true;
        queueMicrotask(capture);
      }
    };
    const output = () => {
      if (!timer) timer = setTimeout(schedule, 60);
    };
    refresh.current = schedule;
    const listeners = [
      term.onWriteParsed(output),
      term.onResize(schedule),
      term.onData(() => latest.current.onInput?.()),
    ];
    const selectionChanged = () => {
      if (!selected()) schedule();
    };
    document.addEventListener("selectionchange", selectionChanged);
    schedule();
    return () => {
      disposed = true;
      clearTimeout(timer);
      listeners.forEach((listener) => listener.dispose());
      document.removeEventListener("selectionchange", selectionChanged);
    };
  }, [term]);
  useLayoutEffect(() => {
    refresh.current();
  }, [active, frozen, startRow, blocks]);
  if (!view || !active) return null;
  const lines = view.frame.lines.slice(view.start);
  const parts =
    mobileFlowParts(lines, view.blocks) ||
    lines.map((_, row) => ({ kind: "row" as const, row, start: 0 }));
  return (
    <div
      className="terminal-native-flow"
      ref={root}
      style={{
        fontFamily: view.fontFamily,
        fontSize: view.fontSize,
        textAlign: "left",
        width: "100%",
        minWidth: 0,
        userSelect: "text",
      }}
      onClick={(event) => {
        if (
          (event.target as Element).closest(
            "button,a,summary,input,textarea,[role=button]",
          )
        )
          return;
        const selection = event.currentTarget.ownerDocument.getSelection();
        if (selection && !selection.isCollapsed) return;
        if ((event.ctrlKey || event.metaKey) && onLink) {
          const rowNode = (event.target as Element).closest<HTMLElement>(
            "[data-native-row]",
          );
          const range = event.currentTarget.ownerDocument.caretRangeFromPoint(
            event.clientX,
            event.clientY,
          );
          if (rowNode && range && rowNode.contains(range.startContainer)) {
            const prefix = event.currentTarget.ownerDocument.createRange();
            prefix.selectNodeContents(rowNode);
            prefix.setEnd(range.startContainer, range.startOffset);
            const link = nativeFlowLinkAt(
              view.frame,
              Number(rowNode.dataset.nativeRow),
              prefix.toString().length,
            );
            if (link) {
              event.preventDefault();
              onLink(link);
              return;
            }
          }
        }
        term.focus();
      }}
    >
      {parts.map((part) =>
        part.kind === "answer" ? (
          <section
            key={`rich:${part.id}`}
            data-rich-block={`native-answer:${part.id}`}
            data-terminal-rich="true"
            className="terminal-native-answer"
          >
            {part.block ? (
              (renderAnswer?.(part.block.text) ?? (
                <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
                  {part.block.text}
                </pre>
              ))
            ) : (
              <span className="muted">답변을 불러오는 중…</span>
            )}
          </section>
        ) : (
          <NativeRow
            key={`row:${view.start + part.row}`}
            row={view.start + part.row}
            runs={
              part.start
                ? clipNativeRuns(view.rows[part.row] || [], part.start)
                : view.rows[part.row] || []
            }
            cursorOffset={
              view.start + part.row === view.frame.cursorRow
                ? view.cursorOffset
                : undefined
            }
            lineHeight={view.lineHeight}
          />
        ),
      )}
    </div>
  );
}
