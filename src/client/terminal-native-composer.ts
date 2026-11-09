import type { Terminal } from "@xterm/xterm";
import type { NativeFlowFrame } from "./terminal-native-flow";

/** A presentation fallback for Codex instances that emit no composer fill.
 * The live cursor owns the prompt; only genuine terminal wraps may extend it.
 * Native colors, inverse selections and non-input output always take priority.
 */
export function nativeComposerFill(term: Terminal, frame: NativeFlowFrame) {
  if (!term.modes.bracketedPasteMode) return;
  const buffer = term.buffer.active;
  let first = frame.cursorRow;
  while (first > frame.baseY && frame.wrapped[first]) first--;
  const prefix = /^( {0,2})[›❯»>](?: |$)/.exec(frame.lines[first] || "");
  if (
    !prefix ||
    (first === frame.cursorRow && frame.cursorColumn < prefix[1].length + 2)
  )
    return;
  for (let row = first; row <= frame.cursorRow; row++) {
    const line = buffer.getLine(row);
    if (!line) return;
    for (let column = 0; column < frame.columns; column++) {
      const cell = line.getCell(column);
      if (cell && (!cell.isBgDefault() || cell.isInverse())) return;
    }
  }
  const theme = term.options.theme || {};
  return {
    first,
    last: frame.cursorRow,
    color: `color-mix(in srgb, ${theme.background || "#ffffff"} 92%, ${theme.foreground || "#20242c"} 8%)`,
  };
}
