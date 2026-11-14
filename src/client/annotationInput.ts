import type { IBuffer } from "@xterm/xterm";

export function annotationDeletion(
  text: string,
  cursor: number,
  key: string,
): string | null {
  const back = key === "\x7f" || key === "\b";
  if (!back && key !== "\x1b[3~") return null;
  for (const match of text.matchAll(
    /\[#\d+ annotation(?::\d+)?\](?:\[ref:\d+\])?/g,
  )) {
    const start = match.index!,
      end = start + match[0].length;
    if (
      back ? cursor > start && cursor <= end : cursor >= start && cursor < end
    )
      return "\x1b[C".repeat(end - cursor) + "\x7f".repeat(end - start);
  }
  return null;
}

/** Read the live composer only; never infer an editable token from old output. */
function composer(buffer: IBuffer): { text: string; cursor: number } | null {
  const row = buffer.baseY + buffer.cursorY;
  let start = row;
  while (start >= buffer.baseY && row - start < 16) {
    const line = buffer.getLine(start)?.translateToString(true) || "";
    if (/^\s*[›❯>]\s/.test(line)) break;
    if (!line.trim()) return null;
    if (!buffer.getLine(start)?.isWrapped && !/^ {1,2}\S/.test(line))
      return null;
    start--;
  }
  if (start < buffer.baseY || row - start >= 16) return null;
  let text = "",
    cursor = 0;
  for (
    let y = start;
    y <= Math.min(row + 16, buffer.baseY + buffer.length - 1);
    y++
  ) {
    const line = buffer.getLine(y);
    if (!line) break;
    const full = line.translateToString(false);
    if (y > row && (!full.trim() || /^\s*[─━╌›❯>]/.test(full))) break;
    // Native TUIs indent continuation lines; xterm soft wrapping does not.
    const indent =
      y > start && !line.isWrapped ? full.match(/^ {1,2}/)?.[0].length || 0 : 0;
    if (y === row)
      cursor =
        text.length +
        Math.max(
          0,
          line.translateToString(false, 0, buffer.cursorX).length - indent,
        );
    const nextWrapped = buffer.getLine(y + 1)?.isWrapped;
    text += (nextWrapped ? full : full.trimEnd()).slice(indent);
    if (text.length > 4096) return null;
    if (
      y >= row &&
      !nextWrapped &&
      !buffer
        .getLine(y + 1)
        ?.translateToString(true)
        .trimStart()
        .startsWith("[ref:") &&
      text.lastIndexOf("[#") < text.lastIndexOf("]")
    )
      break;
  }
  return { text, cursor };
}
export class AtomicAnnotationInput {
  private pending = "";
  transform(buffer: IBuffer, key: string): string {
    if (!["\x7f", "\b", "\x1b[3~"].includes(key)) return key;
    const current = composer(buffer);
    if (!current) return key;
    const signature = JSON.stringify(current);
    // A slow SSH echo must not let repeated Backspace erase surrounding prose.
    if (signature === this.pending) return "";
    this.pending = "";
    const deletion = annotationDeletion(current.text, current.cursor, key);
    if (!deletion) return key;
    this.pending = signature;
    return deletion;
  }
}
