interface CursorRows {
  baseY: number;
  cursorY: number;
  getLine(
    index: number,
  ): { translateToString(trimRight: boolean): string } | undefined;
}

// Read the live cursor area even when the reader is looking back through history.
export function codexWorkingFooter(b: CursorRows, rows: number) {
  for (
    let i = Math.min(rows - 1, b.cursorY + 2);
    i >= Math.max(0, b.cursorY - 12);
    i--
  ) {
    const line =
      b
        .getLine(b.baseY + i)
        ?.translateToString(true)
        .trim() || "";
    if (
      /^(?:[•◦·]\s*)?(?:Worked for\s+\d|Conversation interrupted\b)/i.test(line)
    )
      break;
    if (
      /^(?:[•◦·]\s*)?(?:Working|Waiting|Thinking|Running|Planning|Exploring|Reconnecting)\s*(?:…|\.\.\.)?\s*\(\d+(?:\.\d+)?(?:ms|s|m|h)(?:\s+\d+(?:\.\d+)?(?:s|m))*\s*(?:[·•]\s*esc to interrupt)?\)$/i.test(
        line,
      )
    )
      return true;
  }
  return false;
}
