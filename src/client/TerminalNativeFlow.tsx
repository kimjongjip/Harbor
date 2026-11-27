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
import { agyComposerStart, claudeWorkTimer } from "./terminal-native-chrome";
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
  promptHistory?: boolean;
  split?: number;
  /** Native widgets and their composer remain visible in xterm outside the reader. */
  end?: number;
  panels?: readonly NativePanelRectangle[];
  /** A previously recognized surface disappeared mid-repaint. Keep the last
   * committed frame briefly; a persistent replacement still becomes visible. */
  defer?: boolean | "repaint";
}
interface View {
  /** Last ordinary frame; never chain snapshots as the user moves up/down. */
  historyBase?: View;
  outputBase?: View;
  historyIdentity?: object;
  outputSize:number;
  promptHistory?: boolean;
  historyHeight?: number;
  frame: NativeFlowFrame;
  rows: NativeRun[][];
  start: number;
  split: number;
  cursorOffset: number;
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  blocks: RichTerminalBlock[];
  agyPromptRow?: number;
  agyCaret?: { row: number; offset: number };
  composerFill?: ReturnType<typeof nativeComposerFill>;
}
// Echo right after a key must not wait; repaint storms (spinners, streamed
// output) are coalesced so other sessions and typing keep the main thread.
const typingWindowMs = 250;
const outputCoalesceMs = 40;
const incompleteFrameGraceMs = 160;
const maxSynchronizedPaintMs = 1000;

function composerStart(view: View) {
  const { lines, end, baseY } = view.frame;
  for (let row = end - 1; row >= Math.max(view.split, baseY); row--) {
    if (/^\s{0,2}[❯›»>](?:\s|$)/u.test(lines[row]))
      return row > view.split && nativeSeparator(lines[row - 1])
        ? row - 1
        : row;
  }
  return end;
}

type RowView = ComponentProps<typeof NativeRow>;
// Keep every row in the DOM for continuous selection, but don't ask React to
// reconcile thousands of unchanged row components for a single echoed key.
const NativeRows = memo(
  function NativeRows({ rows, origin=0 }: { rows: RowView[]; origin?: number }) {
    return rows.map((row) => <NativeRow key={row.row-origin} {...row} />);
  },
  (previous, next) =>
    previous.origin === next.origin && previous.rows.length === next.rows.length &&
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
  renderedAnswers,
  blocks = emptyBlocks,
  active = true,
  frozen = false,
  nativeInteraction = false,
  onFrozenFrame,
  observeFrame,
  codexComposer = false,
  agyComposer = false,
  historyIdentity,
  startRow = 0,
  workTarget,
  onFrame,
  onInput,
  renderAnswer,
  onLink,
}: {
  term: Terminal;
  renderedAnswers?: {
    sessionId: string;
    messages: ReadonlyMap<string, string>;
  };
  blocks?: RichTerminalBlock[];
  active?: boolean;
  frozen?: boolean;
  nativeInteraction?: boolean;
  onFrozenFrame?(): void;
  observeFrame?(frame: NativeFlowFrame): void;
  codexComposer?: boolean;
  agyComposer?: boolean;
  historyIdentity?: object;
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
  const composer = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View | null>(null);
  const latest = useRef({
    historyIdentity,
    agyComposer,
    observeFrame,
    onFrozenFrame,
    blocks,
    active,
    frozen,
    codexComposer,
    startRow,
    onFrame,
    onInput,
    workTarget,
  });
  latest.current = {
    historyIdentity,
    agyComposer,
    observeFrame,
    onFrozenFrame,
    blocks,
    active,
    frozen,
    codexComposer,
    startRow,
    onFrame,
    onInput,
    workTarget,
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
    let partialOutputSince: number | undefined;
    let partialEditorSince: number | undefined;
    let syncSince: number | undefined;
    let incompleteSince: number | undefined;
    let pasteStarted = -Infinity,
      lastPasteOutput = -Infinity;
    let incompleteScreen: string | undefined;
    let disposed = false;
    const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
    // Read geometry once, then consume ResizeObserver's already-computed size.
    // Reading clientHeight after every parsed echo flushes pending DOM layout
    // for both xterm and the entire conversation before React can paint it.
    // A resize notification precedes ResizeObserver. Retain a cell's height,
    // not the old screen height divided by the NEW row count for that frame.
    let cellHeight = (screen?.clientHeight || 0) / term.rows;
    const inside = (node: Node | null | undefined) =>
      !!node &&
      (!!root.current?.contains(node) ||
        !!latest.current.workTarget?.contains(node));
    const selected = () => {
      const selection = root.current?.ownerDocument.getSelection();
      return (
        !!selection &&
        !selection.isCollapsed &&
        (inside(selection.anchorNode) || inside(selection.focusNode))
      );
    };
    let hadSelection = selected();
    const capture = (atFrameEnd = false) => {
      scheduled = false;
      clearTimeout(timer);
      timer = undefined;
      const hasSelection = selected();
      // A parsed write can observe a selection before selectionchange is
      // delivered. Remember it so clearing that range releases deferred output.
      if (hasSelection) hadSelection = true;
      if (disposed || !latest.current.active) return;
      // Codex can replace the placeholder, paste badge and cursor in separate
      // writes. Commit the settled rows together, even if the last write is quiet.
      const now = performance.now();
      const remaining =
        Math.min(pasteStarted + incompleteFrameGraceMs, lastPasteOutput + outputCoalesceMs) - now;
      if (!atFrameEnd && remaining > 0) {
        timer = setTimeout(capture, remaining);
        return;
      }
      if (atFrameEnd || !term.modes.synchronizedOutputMode) syncSince = undefined;
      else {
        // A dropped end-of-paint marker must not hold the reader indefinitely.
        syncSince ??= now;
        if (now - syncSince < maxSynchronizedPaintMs) {
          timer = setTimeout(capture, 60);
          return;
        }
      }
      lastCapture = performance.now();
      if (latest.current.frozen || hasSelection) {
        latest.current.onFrozenFrame?.();
        return;
      }
      const frame = reader.frame();
      const editor = latest.current.agyComposer ? agyComposerStart(frame.lines,frame.end,frame) : undefined;
      const agyPromptRow = editor === undefined ? undefined : nativeSeparator(frame.lines[editor]) ? editor+1 : editor;
      const old = previous.current;
      if (latest.current.agyComposer && old?.agyPromptRow !== undefined && old.frame.bufferType===frame.bufferType &&
          (agyPromptRow === undefined ||
            (frame.lines[agyPromptRow]?.trim()===">" && old.frame.lines[old.agyPromptRow]?.trim()!==">" && now-lastInput>typingWindowMs))) {
        partialEditorSince ??= now;
        const left = 250 - (now-partialEditorSince);
        if (left>0) {timer=setTimeout(capture,left);return;}
      } else partialEditorSince=undefined;
      latest.current.observeFrame?.(frame);
      const requested =
        typeof latest.current.startRow === "function"
          ? latest.current.startRow(frame)
          : latest.current.startRow;
      const range =
        typeof requested === "number" ? { start: requested } : requested;
      if (range.defer && previous.current) {
        // A saved command/diff repaint is not an interactive replacement.
        // Wait for its footer instead of alternating views after a deadline.
        // New parsed output/resize still runs capture immediately; no polling
        // loop is needed while a known partial screen remains unchanged.
        if (range.defer === "repaint") {
          incompleteSince = undefined;
          incompleteScreen = undefined;
          return;
        }
        const candidate = frame.lines
          .slice(Math.max(frame.baseY, frame.end - 60), frame.end)
          .join("\n");
        if (candidate !== incompleteScreen) {
          incompleteScreen = candidate;
          incompleteSince = performance.now();
        }
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
      incompleteScreen = undefined;
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
      const cursorOffset = nativeFlowCursorOffset(term.buffer.active.getLine(frame.cursorRow), frame.cursorColumn);
      let agyCaret: View["agyCaret"];
      if (agyPromptRow !== undefined) {
        let bottom = agyPromptRow + 1;
        while (bottom < end && !nativeSeparator(frame.lines[bottom])) bottom++;
        if (frame.cursorRow >= agyPromptRow && frame.cursorRow < bottom) {
          agyCaret = {row:frame.cursorRow, offset:cursorOffset};
        } else if (old?.agyCaret && old.agyPromptRow !== undefined && old.frame.bufferType === frame.bufferType) {
          const row = agyPromptRow + old.agyCaret.row - old.agyPromptRow;
          if (row >= agyPromptRow && row < bottom && frame.lines[row] === old.frame.lines[old.agyCaret.row])
            agyCaret = {row,offset:old.agyCaret.offset};
        }
      }
      const next: View = {
        outputSize:0,
        historyIdentity:latest.current.historyIdentity,
        agyPromptRow,
        agyCaret,
        promptHistory: range.promptHistory,
        historyBase: range.promptHistory
          ? previous.current?.promptHistory
            ? previous.current.historyBase
            : (previous.current ?? undefined)
          : undefined,
        historyHeight: range.promptHistory
          ? previous.current?.promptHistory
            ? previous.current.historyHeight
            : composer.current?.offsetHeight || undefined
          : undefined,
        frame: displayFrame,
        start,
        split,
        rows,
        cursorOffset,
        fontSize: term.options.fontSize || 14,
        fontFamily: term.options.fontFamily || "monospace",
        lineHeight: Math.max(
          term.options.fontSize || 14,
          cellHeight ||
            (term.options.fontSize || 14) * (term.options.lineHeight || 1.2),
        ),
        blocks: latest.current.blocks,
        composerFill: latest.current.codexComposer
          ? nativeComposerFill(term, frame)
          : undefined,
      };
      // A renderer may erase activity above an intact, editable prompt and
      // deliver the replacement over subsequent PTY writes. Keep just that
      // activity mounted while the real composer continues to echo input.
      const outputEnd=composerStart(next);
      for(let i=Math.max(start,outputEnd-100);i<outputEnd;i++)next.outputSize+=frame.lines[i].trim().length;
      const committed=old?.outputBase ?? old;
      if(committed && !next.promptHistory && !committed.promptHistory &&
          committed.historyIdentity===next.historyIdentity && committed.frame.bufferType===frame.bufferType &&
          outputEnd<next.frame.end && committed.outputSize>8 && next.outputSize<committed.outputSize*0.7) {
        partialOutputSince ??= now;
        const left=350-(now-partialOutputSince);
        if(left>0){next.outputBase=committed;timer=setTimeout(capture,left);}
      } else partialOutputSince=undefined;
      previous.current = next;
      setView(next);
      // History can change the range even when no native bytes changed. Commit
      // both halves in the same React batch, including these quiet updates.
      latest.current.onFrame?.(frame);
    };
    function schedule() {
      if (disposed) return;
      const now = performance.now();
      // A small composer/tail is cheap to project, including a spectator's
      // echoes (which never emit onData in this browser). Keep the larger
      // output batch for full-screen command output and long transcripts.
      const coalesceMs =
        previous.current &&
        previous.current.frame.end - previous.current.start <= 8
          ? 16
          : outputCoalesceMs;
      // The parsed buffer is ready independently of painting, and Electron can
      // suspend RAF while occluded, so never wait for a frame here. Typing
      // echoes run at once; other output joins the next short batch.
      const urgent =
        now - lastInput < typingWindowMs || now - lastCapture >= coalesceMs;
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
      else timer = setTimeout(capture, coalesceMs - (now - lastCapture));
    }
    refresh.current = capture;
    const geometry = new ResizeObserver((entries) => {
      const height = (entries[0]?.contentRect.height || 0) / term.rows;
      if (!height || height === cellHeight) return;
      cellHeight = height;
      schedule();
    });
    if (screen) geometry.observe(screen);
    const listeners = [
      term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
        // A single PTY packet can close a completed paint and start the next
        // one. By onWriteParsed the buffer can already contain half the next
        // prompt. Read at DECRST 2026 while the completed rows still exist.
        if (latest.current.active && (latest.current.codexComposer || latest.current.agyComposer) &&
            params.includes(2026) && term.modes.synchronizedOutputMode &&
            performance.now() - lastCapture >= 16) capture(true);
        return false;
      }),
      term.onWriteParsed(() => {
        if (performance.now() - pasteStarted < incompleteFrameGraceMs)
          lastPasteOutput = performance.now();
        schedule();
      }),
      term.onResize(schedule),
      term.onData((data) => {
        lastInput = performance.now();
        if (latest.current.codexComposer && data.startsWith("\x1b[200~") && /[\r\n]/.test(data)) {
          pasteStarted = lastPasteOutput = lastInput;
          schedule();
        }
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
  }, [term]);
  useLayoutEffect(() => {
    refresh.current();
  }, [active, frozen, codexComposer, startRow, blocks]);
  useEffect(() => {
    // TerminalPane applies the palette in its layout effect. Idle rows also
    // need a capture, without waiting for output or subscribing to every paint.
    refresh.current();
  }, [theme]);
  // If xterm parsed a later paint but its notification was coalesced, reconcile the
  // displayed Claude clock with the real buffer. Never advance elapsed time locally.
  const clockVisible = !!view && !codexComposer &&
    view.frame.lines.slice(Math.max(view.frame.baseY,view.frame.end-32)).some(claudeWorkTimer);
  useEffect(() => {
    if (!active || frozen || !clockVisible) return;
    const check = () => {
      const frame=previous.current?.frame, buffer=term.buffer.active;
      if(!frame || frame.bufferType!==buffer.type || frame.baseY!==buffer.baseY) { refresh.current(); return; }
      for(let row=frame.end-1;row>=Math.max(frame.baseY,frame.end-32);row--) {
        if(claudeWorkTimer(frame.lines[row]) && frame.lines[row]!==buffer.getLine(row)?.translateToString(true)) {
          refresh.current(); return;
        }
      }
    };
    const timer=setInterval(check,1000);
    window.addEventListener("focus",check);
    return ()=>{clearInterval(timer);window.removeEventListener("focus",check);};
  },[term,active,frozen,clockVisible]);
  const hasView = !!view;
  useLayoutEffect(() => {
    if (!active || frozen || nativeInteraction || !root.current) return;
    return projectNativeComposition(
      term,
      () => root.current?.querySelector<HTMLElement>("[data-native-cursor]"),
      root.current,
    );
  }, [term, active, frozen, hasView, nativeInteraction]);
  const historyEntry = view?.promptHistory
    ? view.frame.lines.slice(view.split, view.split + 2).join("\n")
    : undefined;
  useLayoutEffect(() => {
    if (historyEntry !== undefined && composer.current)
      composer.current.scrollTop = 0;
  }, [historyEntry]);
  if (!view || !active) return null;
  const partsFor = (view: View, from: number, to: number) => {
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
  const emitted = new Set<string>();
  const renderParts = (view: View, parts: FlowPart[], showCursor = true, origin?:number, output=false) => {
    const nodes: ReactNode[] = [];
    let rows: RowView[] = [];
    const flush = () => {
      if (!rows.length) return;
      nodes.push(<NativeRows key={origin===undefined ? `rows:${rows[0].row}` : `editor:${nodes.length}`} rows={rows} origin={origin} />);
      rows = [];
    };
    for (const part of parts) {
      if (part.kind === "answer") {
        const block = part.block;
        if (
          block &&
          renderedAnswers &&
          block.sessionId === renderedAnswers.sessionId &&
          renderedAnswers.messages.get(block.requestId) === block.text
        )
          continue;
        // Work, activity and composer are projected separately. A reservation
        // straddling two of those ranges still denotes a single answer.
        if (emitted.has(part.id)) continue;
        emitted.add(part.id);
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
      if ((origin===undefined || output) && rows.length && Math.floor((row-(origin??0))/64) !== Math.floor((rows[0].row-(origin??0))/64))
        flush();
      rows.push({
        row,
        runs: part.start
          ? clipNativeRuns(view.rows[part.row] || [], part.start)
          : view.rows[part.row] || [],
        cursorOffset:
          view.agyCaret
            ? (showCursor && !output && origin !== undefined && row === view.agyCaret.row ? view.agyCaret.offset : undefined)
            : (showCursor && row === view.frame.cursorRow ? view.cursorOffset : undefined),
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
  const click = (event: ReactMouseEvent<HTMLDivElement>, source: View) => {
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
          source.frame,
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
  const transcript = view.historyBase ?? view.outputBase ?? view;
  const work =
    transcript.split > transcript.start
      ? renderParts(
          transcript,
          partsFor(transcript, transcript.start, transcript.split),
          !view.historyBase,
          transcript.start, true,
        )
      : null;
  const boundary = transcript.promptHistory
    ? transcript.split
    : composerStart(transcript);
  const activity = renderParts(
    transcript,
    partsFor(transcript, transcript.split, boundary),
    !view.historyBase,
    transcript.split, true,
  );
  const inputStart = view.historyBase ? view.split : view.outputBase ? composerStart(view) : boundary;
  const input = renderParts(view, partsFor(view, inputStart, view.frame.end), true, view.agyPromptRow);
  return (
    <>
      {work && workTarget
        ? createPortal(
            <div
              className="terminal-native-flow terminal-native-work"
              style={style}
              onClick={(event) => click(event, transcript)}
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
        onClick={(event) =>
          click(
            event,
            (event.target as Element).closest(".terminal-flow-composer")
              ? view
              : transcript,
          )
        }
      >
        {!workTarget && work}
        {activity}
        <div
          ref={composer}
          className="terminal-flow-composer"
          data-history={view.promptHistory ? true : undefined}
          style={
            view.promptHistory
              ? {
                  height: view.historyHeight,
                  minHeight: view.lineHeight * 2,
                  maxHeight: view.historyHeight
                    ? undefined
                    : view.lineHeight * 8,
                  overflowY: "auto",
                  overscrollBehavior: "contain",
                }
              : undefined
          }
        >
          {input}
        </div>
      </div>
    </>
  );
}
