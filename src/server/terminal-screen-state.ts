import type { Terminal, IBufferCell } from "@xterm/headless";
import { explicitUnderline, terminalLinkedChars } from "./terminal-screen-links.js";

function rendition(cell: IBufferCell) {
  const values = [0];
  if (cell.isBold()) values.push(1);
  if (cell.isDim()) values.push(2);
  if (cell.isItalic()) values.push(3);
  if (explicitUnderline(cell)) values.push(4);
  if (cell.isBlink()) values.push(5);
  if (cell.isInverse()) values.push(7);
  if (cell.isInvisible()) values.push(8);
  if (cell.isStrikethrough()) values.push(9);
  if (cell.isOverline()) values.push(53);
  for (const foreground of [true, false]) {
    const color = foreground ? cell.getFgColor() : cell.getBgColor();
    const rgb = foreground ? cell.isFgRGB() : cell.isBgRGB();
    const palette = foreground ? cell.isFgPalette() : cell.isBgPalette();
    if (rgb)
      values.push(
        foreground ? 38 : 48,
        2,
        (color >>> 16) & 255,
        (color >>> 8) & 255,
        color & 255,
      );
    else if (palette) {
      const mode = foreground ? cell.getFgColorMode() : cell.getBgColorMode();
      if (color < 16 && mode === 0x1000000)
        values.push(
          (foreground ? 30 : 40) + (color & 7) + (color >= 8 ? 60 : 0),
        );
      else values.push(foreground ? 38 : 48, 5, color);
    }
  }
  return `\x1b[${values.join(";")}m`;
}

export function alternateBufferPrefix(terminal: Terminal) {
  const core = (terminal as any)._core;
  return (
    rendition(core._bufferService.buffers.normal.savedCurAttrData) +
    "\x1b[?1049h\x1b[0m\x1b[2J\x1b[H"
  );
}

/** State omitted by addon-serialize 0.14. Reads the pinned xterm 6 core only. */
export function terminalStateSuffix(terminal: Terminal) {
  // The serializer itself uses this same internal attribute API. Keep this
  // compatibility shim isolated and covered by parser-level round-trip tests.
  const core = (terminal as any)._core;
  const buffer = core._bufferService.buffer;
  const current = core._inputHandler._curAttrData as IBufferCell;
  const view = terminal.buffer.active;
  let output = "\x1b[?6l";
  // The addon omits trailing empty rows even when their background is colored.
  // Repair only colored empty runs; no text or scrollback is rewritten here.
  for (let row = 0; row < terminal.rows; row++) {
    const line = view.getLine(view.baseY + row)!;
    for (let col = 0; col < terminal.cols;) {
      const cell = line.getCell(col)!;
      if (cell.getChars() || cell.isBgDefault() || cell.getWidth() === 0) {
        col++;
        continue;
      }
      const style = rendition(cell);
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
      output += `\x1b[${row + 1};${col + 1}H${style}\x1b[${end - col}X`;
      col = end;
    }
  }
  output += `\x1b[${buffer.scrollTop + 1};${buffer.scrollBottom + 1}r`;
  const savedRow = Math.min(
    terminal.rows - 1,
    Math.max(0, buffer.savedY - view.baseY),
  );
  output += `\x1b[${savedRow + 1};${buffer.savedX + 1}H${rendition(buffer.savedCurAttrData)}\x1b7`;
  if (terminal.modes.originMode) output += "\x1b[?6h";
  const origin = terminal.modes.originMode ? buffer.scrollTop : 0;
  output += `\x1b[${view.cursorY - origin + 1};${Math.min(view.cursorX + 1, terminal.cols)}H`;
  if (view.cursorX === terminal.cols) {
    const line = view.getLine(view.baseY + view.cursorY)!;
    const last = line.getCell(terminal.cols - 1)!;
    const column =
      last.getWidth() === 0 ? terminal.cols - 2 : terminal.cols - 1;
    const cell = line.getCell(column)!;
    output += `\x1b[${column + 1}G${rendition(cell)}${terminalLinkedChars(terminal, cell)}`;
  }
  output += rendition(current);
  output += core.coreService.isCursorHidden ? "\x1b[?25l" : "\x1b[?25h";
  if (core.coreMouseService.activeEncoding === "SGR") output += "\x1b[?1006h";
  else if (core.coreMouseService.activeEncoding === "SGR_PIXELS")
    output += "\x1b[?1016h";
  output += terminal.modes.bracketedPasteMode ? "\x1b[?2004h" : "\x1b[?2004l";
  return output;
}
