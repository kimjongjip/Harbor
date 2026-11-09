import type { Terminal } from "@xterm/headless";
import { terminalLinkedChars } from "./terminal-screen-links.js";
import { alternateBufferPrefix, rendition } from "./terminal-screen-state.js";

/** Partially overwritten wide glyphs need their original operation stream. */
export function canSerializeAlternateScreen(terminal: Terminal) {
  const buffer = terminal.buffer.alternate;
  for (let row = 0; row < terminal.rows; row++) {
    const line = buffer.getLine(buffer.baseY + row)!;
    for (let col = 0; col < terminal.cols; col++) {
      const width = line.getCell(col)!.getWidth();
      if (width === 2 && line.getCell(col + 1)?.getWidth() !== 0) return false;
      if (width === 0 && line.getCell(col - 1)?.getWidth() !== 2) return false;
    }
  }
  return true;
}

/**
 * A TUI can overwrite a soft-wrapped row using CUP/EL without clearing its wrap
 * flag. Rebuilding that grid as flowing paragraphs can move rows and mix old
 * cells into a new answer. Paint the alternate viewport at its exact coordinates
 * instead. Preserve wrap flags separately so selection still joins wrapped text.
 * Normal-buffer scrollback remains the serialize addon's responsibility.
 */
export function serializeAlternateScreen(terminal: Terminal) {
  const buffer = terminal.buffer.alternate;
  let output =
    alternateBufferPrefix(terminal) + "\x1b[?6l\x1b[r\x1b[4l\x1b[?7h";
  // Establish wrap flags on an empty grid. ECH below erases these temporary
  // cells without clearing the flags; no dummy character reaches the display.
  if (buffer.getLine(buffer.baseY)?.isWrapped) {
    output += `\x1b[${terminal.rows};${terminal.cols}Hxx`;
    if (terminal.rows > 1) output += `\x1b[${terminal.rows - 1}S`;
  }
  for (let row = 1; row < terminal.rows; row++)
    if (buffer.getLine(buffer.baseY + row)?.isWrapped)
      output += `\x1b[${row};${terminal.cols}Hxx`;
  // No cell write may flow into the next row, even after an edited wrap flag.
  output += "\x1b[?7l";
  for (let row = 0; row < terminal.rows; row++) {
    const line = buffer.getLine(buffer.baseY + row)!;
    output += `\x1b[${row + 1};1H\x1b[0m\x1b[${terminal.cols}X`;
    let style = "\x1b[0m";
    let cursor = 0;
    for (let col = 0; col < terminal.cols;) {
      const cell = line.getCell(col)!;
      if (cell.getWidth() === 0) {
        col++;
        continue;
      }
      if (!cell.getChars() && cell.isBgDefault()) {
        col++;
        continue;
      }
      const nextStyle = rendition(cell);
      if (cursor !== col) output += `\x1b[${col + 1}G`;
      cursor = col;
      if (style !== nextStyle) {
        output += nextStyle;
        style = nextStyle;
      }
      if (cell.getChars()) {
        output += terminalLinkedChars(terminal, cell);
        col += cell.getWidth();
        cursor = col;
      } else {
        let end = col + 1;
        while (end < terminal.cols) {
          const next = line.getCell(end)!;
          if (
            next.getChars() ||
            next.getWidth() === 0 ||
            rendition(next) !== style
          )
            break;
          end++;
        }
        output += `\x1b[${end - col}X`;
        col = end;
      }
    }
  }
  return output;
}
