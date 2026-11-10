import type { IBufferLine, IMarker, Terminal } from "@xterm/xterm";
import { classifyLink, plainFilePattern } from "../shared/links";
import {
  nativeRow,
  terminalContentEnd,
  type NativeRun,
} from "./mobile/terminal-flow";

/** Text coordinates are absolute buffer rows, independent of the reading viewport. */
export interface NativeFlowFrame {
  lines: string[];
  wrapped: boolean[];
  baseY: number;
  cursorRow: number;
  cursorColumn: number;
  columns: number;
  end: number;
  bufferType: "normal" | "alternate";
  bracketedPasteMode?: boolean;
}

export function nativeFlowFrame(term: Terminal): NativeFlowFrame {
  const buffer = term.buffer.active;
  const end = terminalContentEnd(buffer);
  const lines: string[] = [],
    wrapped: boolean[] = [];
  for (let row = 0; row < end; row++) {
    const line = buffer.getLine(row);
    lines.push(line?.translateToString(true) || "");
    wrapped.push(!!line?.isWrapped);
  }
  return {
    lines,
    wrapped,
    end,
    baseY: buffer.baseY,
    cursorRow: buffer.baseY + buffer.cursorY,
    cursorColumn: buffer.cursorX,
    columns: term.cols,
    bufferType: buffer.type,
    bracketedPasteMode: term.modes.bracketedPasteMode,
  };
}

/** Keep UTF-16 positions aligned with the rendered text, including wide/emoji cells. */
export function nativeFlowCursorOffset(
  line: IBufferLine | undefined,
  column: number,
) {
  let offset = 0;
  for (let col = 0; col < column; col++) {
    const cell = line?.getCell(col);
    if (cell?.getWidth() === 0) continue;
    offset += cell?.isInvisible()
      ? cell.getWidth() || 1
      : (cell?.getChars() || " ").length;
  }
  return offset;
}

export function nativeFlowRows(
  term: Terminal,
  frame: NativeFlowFrame,
  start: number,
): NativeRun[][] {
  const result: NativeRun[][] = [];
  for (let row = start; row < frame.end; row++)
    result.push(
      nativeRow(
        term.buffer.active.getLine(row),
        frame.columns,
        0,
        term.options.theme || {},
      ),
    );
  return result;
}

function equalRuns(left: NativeRun[], right: NativeRun[]) {
  return (
    left.length === right.length &&
    left.every((run, index) => {
      const other = right[index];
      if (run.text !== other.text) return false;
      const keys = Object.keys(run.style) as (keyof typeof run.style)[];
      return (
        keys.length === Object.keys(other.style).length &&
        keys.every((key) => run.style[key] === other.style[key])
      );
    })
  );
}

/**
 * Only the live viewport can be edited by terminal output. Reuse immutable
 * scrollback, with a public xterm marker tracking trims (baseY alone stops
 * changing once scrollback is full). Clear/reset, alternate buffers and resize
 * invalidate the cache. We still read every live cell, including color-only
 * changes, without depending on paint events or private xterm dirty ranges.
 */
export class NativeFlowReader {
  private previous?: NativeFlowFrame;
  private marker?: IMarker;
  private markerRow = -1;
  private height = 0;
  private theme = "";
  private cachedRows: (NativeRun[] | undefined)[] = [];
  private compareRows: (NativeRun[] | undefined)[] = [];

  constructor(private term: Terminal) {}

  frame(): NativeFlowFrame {
    const term = this.term,
      buffer = term.buffer.active,
      old = this.previous;
    const shift = this.marker ? this.markerRow - this.marker.line : 0;
    const reusable =
      old &&
      old.bufferType === "normal" &&
      buffer.type === "normal" &&
      old.columns === term.cols &&
      this.height === term.rows &&
      this.marker &&
      !this.marker.isDisposed &&
      shift >= 0 &&
      shift <= old.baseY;
    const prefix = reusable ? Math.min(old.baseY - shift, buffer.baseY) : 0;
    const end = terminalContentEnd(buffer);
    const lines = prefix ? old!.lines.slice(shift, shift + prefix) : [];
    const wrapped = prefix ? old!.wrapped.slice(shift, shift + prefix) : [];
    for (let row = prefix; row < end; row++) {
      const line = buffer.getLine(row);
      lines.push(line?.translateToString(true) || "");
      wrapped.push(!!line?.isWrapped);
    }
    const frame: NativeFlowFrame = {
      lines,
      wrapped,
      end,
      baseY: buffer.baseY,
      cursorRow: buffer.baseY + buffer.cursorY,
      cursorColumn: buffer.cursorX,
      columns: term.cols,
      bufferType: buffer.type,
      bracketedPasteMode: term.modes.bracketedPasteMode,
    };
    const theme = JSON.stringify(term.options.theme || {});
    this.compareRows =
      theme === this.theme ? this.cachedRows.slice(reusable ? shift : 0) : [];
    this.cachedRows = reusable ? this.compareRows.slice(0, prefix) : [];
    this.previous = frame;
    this.height = term.rows;
    this.theme = theme;
    this.marker?.dispose();
    this.marker = undefined;
    if (buffer.type === "normal" && buffer.baseY > 0) {
      this.markerRow = buffer.baseY - 1;
      this.marker = term.registerMarker(this.markerRow - frame.cursorRow);
    }
    return frame;
  }

  rows(frame: NativeFlowFrame, start: number): NativeRun[][] {
    const rows: NativeRun[][] = [];
    const theme = this.term.options.theme || {};
    for (let row = start; row < frame.end; row++) {
      let runs = this.cachedRows[row];
      if (!runs) {
        runs = nativeRow(
          this.term.buffer.active.getLine(row),
          frame.columns,
          0,
          theme,
        );
        const previous = this.compareRows[row];
        if (previous && equalRuns(previous, runs)) runs = previous;
        this.cachedRows[row] = runs;
      }
      rows.push(runs);
    }
    return rows;
  }

  dispose() {
    this.marker?.dispose();
    this.cachedRows = [];
    this.compareRows = [];
  }
}

/** Match a clicked file/URL across genuine terminal wraps, never across separate lines. */
export function nativeFlowLinkAt(
  frame: NativeFlowFrame,
  row: number,
  offset: number,
) {
  let start = row,
    end = row;
  while (start > 0 && row - start < 50 && frame.wrapped[start]) start--;
  while (end + 1 < frame.end && end - start < 50 && frame.wrapped[end + 1])
    end++;
  const lines = frame.lines.slice(start, end + 1);
  const position =
    lines.slice(0, row - start).reduce((n, line) => n + line.length, 0) +
    offset;
  const text = lines.join("");
  for (const pattern of [
    /https?:\/\/[^\s<>"'`]+/gi,
    new RegExp(plainFilePattern.source, plainFilePattern.flags),
  ]) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0].replace(/[),;\]}]+$/, "");
      if (
        position >= match.index! &&
        position < match.index! + value.length &&
        classifyLink(value).kind !== "blocked"
      )
        return value;
    }
  }
}
