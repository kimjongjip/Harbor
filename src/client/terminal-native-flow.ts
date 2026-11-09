import type { IBufferLine, Terminal } from "@xterm/xterm";
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
