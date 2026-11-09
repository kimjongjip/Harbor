import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Terminal } from "@xterm/xterm";
import type { RichTerminalBlock } from "../shared/rich-terminal";
import {
  mobileFlowParts,
  clipNativeRuns,
  type NativeRun,
} from "./mobile/terminal-flow";
import {
  NativeFlowReader,
  nativeFlowCursorOffset,
  nativeFlowLinkAt,
  type NativeFlowFrame,
} from "./terminal-native-flow";
import { NativeRow } from "./TerminalNativeRow";
import { nativeComposerFill } from "./terminal-native-composer";
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
  composerFill?: ReturnType<typeof nativeComposerFill>;
}
/** A selectable native buffer projection. It never writes, resizes or replays PTY input. */
export function TerminalNativeFlow({
  term,
  blocks = emptyBlocks,
  active = true,
  frozen = false,
  codexComposer = false,
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
  codexComposer?: boolean;
  startRow?: number | ((frame: NativeFlowFrame) => number);
  onFrame?(frame: NativeFlowFrame): void;
  onInput?(): void;
  renderAnswer?(text: string): ReactNode;
  onLink?(text: string): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View | null>(null);
  const latest = useRef({
    blocks,
    active,
    frozen,
    codexComposer,
    startRow,
    onFrame,
    onInput,
  });
  latest.current = {
    blocks,
    active,
    frozen,
    codexComposer,
    startRow,
    onFrame,
    onInput,
  };
  const previous = useRef<View | null>(null);
  const refresh = useRef(() => {});
  useLayoutEffect(() => {
    previous.current = null;
    const reader = new NativeFlowReader(term);
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
    let hadSelection = selected();
    const capture = () => {
      scheduled = false;
      const hasSelection = selected();
      // A parsed write can observe a selection before selectionchange is
      // delivered. Remember it so clearing that range releases deferred output.
      if (hasSelection) hadSelection = true;
      if (
        disposed ||
        !latest.current.active ||
        latest.current.frozen ||
        hasSelection
      )
        return;
      if (term.modes.synchronizedOutputMode) {
        timer = setTimeout(schedule, 60);
        return;
      }
      const frame = reader.frame();
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
      const rows = reader.rows(frame, start);
      const old = previous.current;
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
        composerFill: latest.current.codexComposer
          ? nativeComposerFill(term, frame)
          : undefined,
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
      // for paint. Parsed writes already arrive in batches; a fixed output
      // timeout here delays every echoed key, even while the terminal is idle.
      if (!scheduled && !disposed) {
        scheduled = true;
        queueMicrotask(capture);
      }
    };
    refresh.current = schedule;
    const listeners = [
      term.onWriteParsed(schedule),
      term.onResize(schedule),
      term.onData(() => latest.current.onInput?.()),
    ];
    const selectionChanged = () => {
      const hasSelection = selected();
      const released = hadSelection && !hasSelection;
      hadSelection = hasSelection;
      // Focus and native textarea caret changes also emit selectionchange.
      // They must not trigger a second full capture for each echoed key.
      if (released) schedule();
    };
    document.addEventListener("selectionchange", selectionChanged);
    schedule();
    return () => {
      disposed = true;
      clearTimeout(timer);
      reader.dispose();
      listeners.forEach((listener) => listener.dispose());
      document.removeEventListener("selectionchange", selectionChanged);
    };
  }, [term]);
  useLayoutEffect(() => {
    refresh.current();
  }, [active, frozen, codexComposer, startRow, blocks]);
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
            backgroundColor={
              view.composerFill &&
              view.start + part.row >= view.composerFill.first &&
              view.start + part.row <= view.composerFill.last
                ? view.composerFill.color
                : undefined
            }
          />
        ),
      )}
    </div>
  );
}
