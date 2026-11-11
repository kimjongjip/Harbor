import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { Terminal } from "@xterm/xterm";
import type { RichTerminalBlock } from "../shared/rich-terminal";
import {
  mobileFlowParts,
  clipNativeRuns,
  nativeSeparator,
  type FlowPart,
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
import { projectNativeComposition } from "./terminal-native-ime";
import { useTheme } from "./Theme";
import {
  projectNativeRow,
  type NativePanelRectangle,
} from "./mobile/claude-mod-panels";
export type { NativeFlowFrame } from "./terminal-native-flow";

const emptyBlocks: RichTerminalBlock[] = [];
/** Rows [start, split) are newer than saved history; [split, end) is the CLI's live area. */
export interface NativeFlowRange {
  start: number;
  split?: number;
  /** Native widgets and their composer remain visible in xterm outside the reader. */
  end?: number;
  panels?: readonly NativePanelRectangle[];
  /** A previously recognized surface disappeared mid-repaint. Keep the last
   * committed frame briefly; a persistent replacement still becomes visible. */
  defer?: boolean;
}
interface View {
  frame: NativeFlowFrame;
  rows: NativeRun[][];
  start: number;
  split: number;
  cursorOffset: number;
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  blocks: RichTerminalBlock[];
  composerFill?: ReturnType<typeof nativeComposerFill>;
}
// Echo right after a key must not wait; repaint storms (spinners, streamed
// output) are coalesced so other sessions and typing keep the main thread.
const typingWindowMs = 250;
const outputCoalesceMs = 40;
const incompleteFrameGraceMs = 160;

type RowView = ComponentProps<typeof NativeRow>;
// Keep every row in the DOM for continuous selection, but don't ask React to
// reconcile thousands of unchanged row components for a single echoed key.
const NativeRows = memo(
  function NativeRows({ rows }: { rows: RowView[] }) {
    return rows.map((row) => <NativeRow key={row.row} {...row} />);
  },
  (previous, next) =>
    previous.rows.length === next.rows.length &&
    previous.rows.every((row, index) => {
      const other = next.rows[index];
      return (
        row.row === other.row &&
        row.runs === other.runs &&
        row.cursorOffset === other.cursorOffset &&
        row.lineHeight === other.lineHeight &&
        row.separator === other.separator &&
        row.backgroundColor === other.backgroundColor
      );
    }),
);

// The native tail also contains completed answers whose row reservations are
// still on screen. Typing changes the cursor, not those Markdown documents.
const NativeAnswer = memo(function NativeAnswer({
  id,
  text,
  renderAnswer,
}: {
  id: string;
  text?: string;
  renderAnswer?: (text: string) => ReactNode;
}) {
  return (
    <section
      data-rich-block={`native-answer:${id}`}
      data-terminal-rich="true"
      className="terminal-native-answer"
    >
      {text !== undefined ? (
        (renderAnswer?.(text) ?? (
          <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{text}</pre>
        ))
      ) : (
        <span className="muted">답변을 불러오는 중…</span>
      )}
    </section>
  );
});

/** A selectable native buffer projection. It never writes, resizes or replays PTY input. */
export function TerminalNativeFlow({
  term,
  blocks = emptyBlocks,
  active = true,
  frozen = false,
  codexComposer = false,
  startRow = 0,
  workTarget,
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
  startRow?: number | ((frame: NativeFlowFrame) => number | NativeFlowRange);
  /** Optional element (inside a running turn's work group) for rows before split. */
  workTarget?: HTMLElement | null;
  onFrame?(frame: NativeFlowFrame): void;
  onInput?(): void;
  renderAnswer?(text: string): ReactNode;
  onLink?(text: string): void;
}) {
  const { theme } = useTheme();
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
      timer: ReturnType<typeof setTimeout> | undefined,
      lastInput = 0,
      lastCapture = 0;
    let incompleteSince: number | undefined;
    let disposed = false;
    const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
    // Read geometry once, then consume ResizeObserver's already-computed size.
    // Reading clientHeight after every parsed echo flushes pending DOM layout
    // for both xterm and the entire conversation before React can paint it.
    let screenHeight = screen?.clientHeight || 0;
    const inside = (node: Node | null | undefined) =>
      !!node &&
      (!!root.current?.contains(node) ||
        !!(workTarget && workTarget.contains(node)));
    const selected = () => {
      const selection = root.current?.ownerDocument.getSelection();
      return (
        !!selection &&
        !selection.isCollapsed &&
        (inside(selection.anchorNode) || inside(selection.focusNode))
      );
    };
    let hadSelection = selected();
    const capture = () => {
      scheduled = false;
      clearTimeout(timer);
      timer = undefined;
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
        timer = setTimeout(() => {
          timer = undefined;
          schedule();
        }, 60);
        return;
      }
      lastCapture = performance.now();
      const frame = reader.frame();
      const requested =
        typeof latest.current.startRow === "function"
          ? latest.current.startRow(frame)
          : latest.current.startRow;
      const range =
        typeof requested === "number" ? { start: requested } : requested;
      if (range.defer && previous.current) {
        incompleteSince ??= performance.now();
        const remaining =
          incompleteFrameGraceMs - (performance.now() - incompleteSince);
        if (remaining > 0) {
          // Do not publish either half: replacing native rows before their
          // history boundary would still flash the raw diff beneath saved work.
          // More chunks may complete the repaint sooner. This timer also admits
          // a real dialog/shell transition with no subsequent output.
          timer = setTimeout(capture, remaining);
          return;
        }
      }
      incompleteSince = undefined;
      const end = Math.min(
        frame.end,
        Math.max(0, Math.floor(range.end ?? frame.end)),
      );
      const start = Math.min(end, Math.max(0, Math.floor(range.start)));
      const split = Math.min(
        end,
        Math.max(start, Math.floor(range.split ?? start)),
      );
      const displayFrame = end === frame.end ? frame : { ...frame, end };
      const rows = reader.rows(displayFrame, start).map((runs, index) => {
        const row = start + index;
        return range.panels?.some(
          (panel) => row >= panel.top && row < panel.bottom,
        )
          ? projectNativeRow(
              term.buffer.active.getLine(row),
              frame.columns,
              row,
              range.panels,
              term.options.theme || {},
            ).runs
          : runs;
      });
      const old = previous.current;
      const next: View = {
        frame: displayFrame,
        start,
        split,
        rows,
        cursorOffset: nativeFlowCursorOffset(
          term.buffer.active.getLine(frame.cursorRow),
          frame.cursorColumn,
        ),
        fontSize: term.options.fontSize || 14,
        fontFamily: term.options.fontFamily || "monospace",
        lineHeight: Math.max(
          term.options.fontSize || 14,
          screenHeight / term.rows ||
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
        old.frame.bracketedPasteMode !== frame.bracketedPasteMode ||
        old.frame.lines.length !== frame.lines.length ||
        old.frame.lines.some((line, row) => line !== frame.lines[row]) ||
        old.frame.wrapped.some((wrapped, row) => wrapped !== frame.wrapped[row])
      )
        latest.current.onFrame?.(frame);
    };
    function schedule() {
      if (disposed) return;
      const now = performance.now();
      // The parsed buffer is ready independently of painting, and Electron can
      // suspend RAF while occluded, so never wait for a frame here. Typing
      // echoes run at once; other output joins the next short batch.
      const urgent =
        now - lastInput < typingWindowMs ||
        now - lastCapture >= outputCoalesceMs;
      if (scheduled) {
        // A pending batch never gets cancelled; an echo only makes it sooner.
        if (urgent && timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
          queueMicrotask(capture);
        }
        return;
      }
      scheduled = true;
      clearTimeout(timer);
      timer = undefined;
      if (urgent) queueMicrotask(capture);
      else timer = setTimeout(capture, outputCoalesceMs - (now - lastCapture));
    }
    refresh.current = schedule;
    const geometry = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height || 0;
      if (height === screenHeight) return;
      screenHeight = height;
      schedule();
    });
    if (screen) geometry.observe(screen);
    const listeners = [
      term.onWriteParsed(schedule),
      term.onResize(schedule),
      term.onData(() => {
        lastInput = performance.now();
        latest.current.onInput?.();
      }),
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
      geometry.disconnect();
      listeners.forEach((listener) => listener.dispose());
      document.removeEventListener("selectionchange", selectionChanged);
    };
  }, [term, workTarget]);
  useLayoutEffect(() => {
    refresh.current();
  }, [active, frozen, codexComposer, startRow, blocks]);
  useEffect(() => {
    // TerminalPane applies the palette in its layout effect. Idle rows also
    // need a capture, without waiting for output or subscribing to every paint.
    refresh.current();
  }, [theme]);
  const hasView = !!view;
  useLayoutEffect(() => {
    if (!active || frozen || !root.current) return;
    return projectNativeComposition(
      term,
      () => root.current?.querySelector<HTMLElement>("[data-native-cursor]"),
      root.current,
    );
  }, [term, active, frozen, hasView]);
  if (!view || !active) return null;
  const partsFor = (from: number, to: number) => {
    const lines = view.frame.lines.slice(from, to);
    return (
      mobileFlowParts(lines, view.blocks) ||
      lines.map((_, row) => ({ kind: "row" as const, row, start: 0 }))
    ).map((part) =>
      part.kind === "row"
        ? { ...part, row: part.row + from - view.start }
        : part,
    );
  };
  const renderParts = (parts: FlowPart[]) => {
    const nodes: ReactNode[] = [];
    let rows: RowView[] = [];
    const flush = () => {
      if (!rows.length) return;
      nodes.push(<NativeRows key={`rows:${rows[0].row}`} rows={rows} />);
      rows = [];
    };
    for (const part of parts) {
      if (part.kind === "answer") {
        flush();
        nodes.push(
          <NativeAnswer
            key={`rich:${part.id}`}
            id={part.id}
            text={part.block?.text}
            renderAnswer={renderAnswer}
          />,
        );
        continue;
      }
      const row = view.start + part.row;
      if (rows.length && Math.floor(row / 64) !== Math.floor(rows[0].row / 64))
        flush();
      rows.push({
        row,
        runs: part.start
          ? clipNativeRuns(view.rows[part.row] || [], part.start)
          : view.rows[part.row] || [],
        cursorOffset:
          row === view.frame.cursorRow ? view.cursorOffset : undefined,
        lineHeight: view.lineHeight,
        separator: nativeSeparator(view.frame.lines[row] || ""),
        backgroundColor:
          view.composerFill &&
          row >= view.composerFill.first &&
          row <= view.composerFill.last
            ? view.composerFill.color
            : undefined,
      });
    }
    flush();
    return nodes;
  };
  const style = {
    fontFamily: view.fontFamily,
    fontSize: view.fontSize,
    textAlign: "left" as const,
    width: "100%",
    minWidth: 0,
    userSelect: "text" as const,
  };
  const click = (event: ReactMouseEvent<HTMLDivElement>) => {
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
  };
  const work =
    view.split > view.start
      ? renderParts(partsFor(view.start, view.split))
      : null;
  const live = renderParts(partsFor(view.split, view.frame.end));
  return (
    <>
      {work && workTarget
        ? createPortal(
            <div
              className="terminal-native-flow terminal-native-work"
              style={style}
              onClick={click}
            >
              {work}
            </div>,
            workTarget,
          )
        : null}
      <div
        className="terminal-native-flow"
        ref={root}
        style={style}
        onClick={click}
      >
        {!workTarget && work}
        {live}
      </div>
    </>
  );
}
