import type { IBuffer, IBufferLine, ITheme } from "@xterm/xterm";
import { nativeRow, type NativeRun } from "./terminal-flow";

/** Coordinates are terminal cells; bottom and right are exclusive. */
export interface NativePanelRectangle {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export interface NativeCellSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * Recognize Claude's native Mods chrome in the current viewport only. A box or
 * a column of ordinary output is insufficient: the complete prompt frame
 * and the native close/collapse controls must also be intact.
 */
export function claudeModPanels(
  buffer: IBuffer,
  columns: number,
  rows: number,
): NativePanelRectangle[] {
  if (columns < 30 || rows < 8) return [];
  const cell = (row: number, column: number) =>
    buffer
      .getLine(buffer.baseY + row)
      ?.getCell(column)
      ?.getChars() || " ";
  const text = (row: number, left = 0, right = columns) =>
    buffer.getLine(buffer.baseY + row)?.translateToString(true, left, right) ||
    "";
  const horizontal = (row: number, left: number, right: number) => {
    for (let column = left; column < right; column++)
      if (cell(row, column) !== "─") return false;
    return true;
  };
  const prompts: number[] = [];
  for (let row = 0; row < rows - 2; row++)
    if (
      horizontal(row, 0, columns) &&
      cell(row + 1, 0) === "❯" &&
      /^[ \u00a0]$/.test(cell(row + 1, 1))
    ) {
      // Wrapped/multiline drafts keep the same native two-cell prompt indent.
      // A growing draft must not make an otherwise intact dock disappear.
      for (let bottom = row + 2; bottom < rows; bottom++) {
        if (horizontal(bottom, 0, columns)) {
          prompts.push(row);
          break;
        }
        if (cell(bottom, 0) !== " " || cell(bottom, 1) !== " ") break;
      }
    }
  if (prompts.length !== 1) return [];
  const prompt = prompts[0];
  const panels: NativePanelRectangle[] = [];
  const docks: number[] = [];
  const dockEnds = new Map<number, number>();
  if (cell(0, columns - 2) === "✕" && cell(0, columns - 1) === " ")
    for (let column = Math.ceil(columns / 2); column < columns - 10; column++) {
      if (cell(0, column) !== "│") continue;
      let bottom = 1;
      while (bottom < prompt && cell(bottom, column) === "│") bottom++;
      // The native slash picker overlays the bottom of a dock. Its upper
      // border/close control and continuous sides remain intact. Keep both
      // that native dock and the picker instead of covering them with history.
      const menu = Array.from({ length: prompt - bottom }, (_, i) =>
        text(bottom + i, 0, column),
      );
      const slashMenu =
        bottom >= 3 &&
        /^❯[ \u00a0]\/\S*\s*$/.test(text(prompt + 1)) &&
        menu.some((line) => /^ {2}[❯›] \/[\w:-]+\s/.test(line)) &&
        menu.every(
          (line) =>
            !line.trim() ||
            /^ {2}[❯›] \/[\w:-]+\s/.test(line) ||
            /^ {4}\S/.test(line),
        );
      if (bottom === prompt || slashMenu) {
        docks.push(column);
        dockEnds.set(column, bottom);
      }
    }
  if (docks.length > 1) return [];
  const mainWidth = docks[0] ?? columns;
  if (docks.length)
    panels.push({
      top: 0,
      bottom: dockEnds.get(mainWidth)!,
      left: mainWidth,
      right: columns,
    });

  // The native band sits immediately above one blank spacer and the prompt.
  const bands: number[] = [];
  if (!text(prompt - 1, 0, mainWidth).trim())
    for (let row = 0; row < prompt - 1; row++)
      if (
        (cell(row, mainWidth - 4) === "[" &&
          cell(row, mainWidth - 3) === "-" &&
          cell(row, mainWidth - 2) === "]" &&
          cell(row, mainWidth - 1) === " ") ||
        (row === prompt - 2 &&
          text(row, 0, mainWidth).trim() ===
            "▸ plugin panel hidden · ctrl+x ctrl+a or click to show")
      )
        bands.push(row);
  if (bands.length > 1) return [];
  const band = bands[0];
  if (band !== undefined)
    panels.push({ top: band, bottom: prompt, left: 0, right: mainWidth });

  // Narrow native panes are full-width rounded frames adjacent to that band,
  // or to the single blank prompt spacer when no band is installed.
  if (!docks.length) {
    const bottom = (band ?? prompt - 1) - 1;
    if (
      bottom >= 2 &&
      cell(bottom, 0) === "╰" &&
      cell(bottom, columns - 1) === "╯" &&
      horizontal(bottom, 1, columns - 1)
    ) {
      for (let top = bottom - 2; top >= 0; top--) {
        if (
          cell(top, 0) === "╭" &&
          cell(top, columns - 3) === "✕" &&
          cell(top, columns - 2) === "─" &&
          cell(top, columns - 1) === "╮" &&
          horizontal(top, 1, columns - 3)
        ) {
          let complete = true;
          for (let row = top + 1; row < bottom; row++)
            if (cell(row, 0) !== "│" || cell(row, columns - 1) !== "│") {
              complete = false;
              break;
            }
          if (complete)
            panels.push({ top, bottom: bottom + 1, left: 0, right: columns });
          break;
        }
      }
    }
  }
  return panels.map((panel) => ({
    ...panel,
    top: panel.top + buffer.baseY,
    bottom: panel.bottom + buffer.baseY,
  }));
}

/** Subtract panel rectangles without changing either the buffer or the regions. */
export function nativeKeptSpans(
  columns: number,
  row: number,
  panels: readonly NativePanelRectangle[],
): NativeCellSpan[] {
  const width = Math.max(0, Math.floor(columns));
  const omitted = panels
    .filter((panel) => row >= panel.top && row < panel.bottom)
    .map((panel) => ({
      start: Math.max(0, Math.min(width, Math.floor(panel.left))),
      end: Math.max(0, Math.min(width, Math.floor(panel.right))),
    }))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start);
  const kept: NativeCellSpan[] = [];
  let start = 0;
  for (const span of omitted) {
    if (span.start > start) kept.push({ start, end: span.start });
    start = Math.max(start, span.end);
  }
  if (start < width) kept.push({ start, end: width });
  return kept;
}

/**
 * Read retained cells directly. Frozen views can keep these runs alongside the
 * full row, so switching the phone view never re-reads a newer terminal frame.
 */
export function projectNativeRow(
  line: IBufferLine | undefined,
  columns: number,
  row: number,
  panels: readonly NativePanelRectangle[],
  theme: ITheme,
): { runs: NativeRun[]; hidden: boolean } {
  const spans = nativeKeptSpans(columns, row, panels);
  const unchanged =
    spans.length === 1 && spans[0].start === 0 && spans[0].end === columns;
  if (unchanged)
    return { runs: nativeRow(line, columns, 0, theme), hidden: false };
  const runs: NativeRun[] = [];
  let previousEnd = 0;
  for (const span of spans) {
    // A panel edge must not leak half a wide glyph or split a surrogate pair.
    const start =
      span.start + (line?.getCell(span.start)?.getWidth() === 0 ? 1 : 0);
    const end =
      span.end - (line?.getCell(span.end - 1)?.getWidth() === 2 ? 1 : 0);
    if (start > previousEnd)
      runs.push({ text: " ".repeat(start - previousEnd), style: {} });
    if (end > start) {
      const part = nativeRow(line, end, start, theme);
      // nativeRow's prefix is explicitly generated ASCII spacing, not text.
      runs.push(...(start ? part.slice(1) : part));
    }
    if (end < span.end)
      runs.push({
        text: " ".repeat(span.end - Math.max(start, end)),
        style: {},
      });
    previousEnd = span.end;
  }
  return {
    runs,
    hidden: !runs.some((run) => run.text.trim()),
  };
}
