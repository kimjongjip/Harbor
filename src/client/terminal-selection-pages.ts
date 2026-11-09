/** Text from cells actually displayed by the CLI, never reconstructed history. */
export interface SelectionLine {
  cells: string[];
  wrapped: boolean;
  text: string;
}
export interface SelectionPoint {
  row: number;
  column: number;
}
const compare = (a: SelectionPoint, b: SelectionPoint) =>
  a.row - b.row || a.column - b.column;
// TUI repainting alternates explicit padding spaces and empty cells. They look
// identical, but translateToString(true) does not trim explicit space characters.
const normalizedFrame = (frame: SelectionLine[]) =>
  frame.map((line) => ({ ...line, text: line.text.trimEnd() }));

/** Connect overlapping native viewport pages while an application scrolls its own UI. */
export class TerminalSelectionPages {
  private lines = new Map<number, SelectionLine>();
  private frame: SelectionLine[];
  private anchor: SelectionPoint;
  private focus: SelectionPoint;
  private top = 0;
  private first = 0;
  private last: number;
  private mapped = false;

  constructor(
    frame: SelectionLine[],
    readonly columns: number,
    start: SelectionPoint,
    end: SelectionPoint,
    anchorAtEnd: boolean,
  ) {
    frame = normalizedFrame(frame);
    this.frame = frame;
    this.last = frame.length - 1;
    this.anchor = { ...(anchorAtEnd ? end : start) };
    this.focus = { ...(anchorAtEnd ? start : end) };
    frame.forEach((line, row) => this.lines.set(row, line));
  }

  update(
    frame: SelectionLine[],
    direction: number,
    movingFocus = false,
  ): "moved" | "unchanged" | "unmatched" {
    frame = normalizedFrame(frame);
    if (frame.length !== this.frame.length) return "unmatched";
    if (
      frame
        .slice(this.first, this.last + 1)
        .every((l, i) => l.text === this.frame[i + this.first].text)
    ) {
      this.frame = frame;
      return "unchanged";
    }
    const unique = (lines: SelectionLine[]) => {
      const positions = new Map<string, number[]>();
      lines.forEach((line, row) => {
        // Blank rows, rules and repeated code lines cannot identify a page offset.
        if (line.text.trim().length < 4 || !/[\p{L}\p{N}]/u.test(line.text))
          return;
        const rows = positions.get(line.text) || [];
        rows.push(row);
        positions.set(line.text, rows);
      });
      return positions;
    };
    const previous = unique(this.frame),
      next = unique(frame);
    const votes = new Map<number, Array<[number, number]>>();
    for (const [text, oldRows] of previous) {
      const newRows = next.get(text);
      if (oldRows.length !== 1 || newRows?.length !== 1) continue;
      const oldRow = oldRows[0],
        newRow = newRows[0],
        shift = oldRow - newRow;
      if (!shift || Math.sign(shift) !== Math.sign(direction)) continue;
      if (
        this.mapped &&
        (oldRow < this.first ||
          oldRow > this.last ||
          newRow < this.first ||
          newRow > this.last)
      )
        continue;
      const matches = votes.get(shift) || [];
      matches.push([oldRow, newRow]);
      votes.set(shift, matches);
    }
    const ranked = [...votes].sort((a, b) => b[1].length - a[1].length);
    if (!this.mapped && !ranked.length) {
      const [start, end] = this.range();
      if (
        frame
          .slice(start.row, end.row + 1)
          .every(
            (line, index) => line.text === this.frame[start.row + index].text,
          )
      ) {
        // A spinner, clock or prompt can change without moving the body.
        // Only unchanged selected rows anchor this still-unmapped page.
        this.frame = frame;
        frame.forEach((line, row) => this.lines.set(row, line));
        return "unchanged";
      }
    }
    if (
      !ranked.length ||
      ranked[0][1].length < 2 ||
      ranked[0][1].length === ranked[1]?.[1].length
    )
      return "unmatched";
    const [shift, matches] = ranked[0];
    let first = this.first,
      last = this.last;
    if (!this.mapped) {
      // Both edges of a moving region occur in the overlapping pair. Stationary
      // headers, prompts and status bars do not become part of copied history.
      first = Math.min(...matches.flat());
      last = Math.max(...matches.flat());
      while (
        first > 0 &&
        (!frame[first - 1].text.trim() || !this.frame[first - 1].text.trim()) &&
        (shift < 0 ||
          this.frame[first - 1 + shift]?.text === frame[first - 1].text)
      )
        first--;
      while (
        last + 1 < frame.length &&
        (!frame[last + 1].text.trim() || !this.frame[last + 1].text.trim()) &&
        (shift > 0 ||
          this.frame[last + 1 + shift]?.text === frame[last + 1].text)
      )
        last++;
      if (this.anchor.row < first || this.anchor.row > last) return "unmatched";
      if (!movingFocus && (this.focus.row < first || this.focus.row > last))
        return "unmatched";
    }
    const top = this.top + shift;
    // Confirm overlap against previously visited pages too, including reversals.
    // A changed/replaced page must never silently produce a guessed quotation.
    for (let row = first; row <= last; row++) {
      const index = top + row;
      if (!this.mapped && (index < first || index > last)) continue;
      const known = this.lines.get(index);
      if (known && known.text !== frame[row].text) return "unmatched";
    }
    if (this.lines.size + Math.abs(shift) > 10000) return "unmatched";
    if (!this.mapped) {
      for (const row of this.lines.keys())
        if (row < first || row > last) this.lines.delete(row);
      this.first = first;
      this.last = last;
      this.mapped = true;
    }
    this.top = top;
    frame.forEach((line, row) => {
      if (row >= first && row <= last) this.lines.set(top + row, line);
    });
    this.frame = frame;
    return "moved";
  }

  moveFocus(point: SelectionPoint) {
    const row = Math.max(this.first, Math.min(this.last, point.row));
    this.focus = {
      row: this.top + row,
      column:
        point.row < this.first
          ? 0
          : point.row > this.last
            ? this.columns
            : Math.max(0, Math.min(this.columns, point.column)),
    };
  }

  private range() {
    return compare(this.anchor, this.focus) <= 0
      ? [this.anchor, this.focus]
      : [this.focus, this.anchor];
  }

  text(newline = "\n") {
    const [start, end] = this.range();
    const chunks: string[] = [];
    for (let row = start.row; row <= end.row; row++) {
      const line = this.lines.get(row);
      if (!line) return undefined; // Never splice across an unobserved gap.
      const text = line.cells
        .slice(
          row === start.row ? start.column : 0,
          row === end.row ? end.column : this.columns,
        )
        .join("")
        .trimEnd()
        .replace(/\u00a0/g, " ");
      if (line.wrapped && chunks.length) chunks[chunks.length - 1] += text;
      else chunks.push(text);
    }
    return chunks.join(newline);
  }

  visibleRange() {
    const [start, end] = this.range();
    const first = this.top + this.first,
      last = this.top + this.last;
    if (end.row < first || start.row > last) return undefined;
    return {
      start: {
        row: Math.max(first, start.row) - this.top,
        column: start.row < first ? 0 : start.column,
      },
      end: {
        row: Math.min(last, end.row) - this.top,
        column: end.row > last ? this.columns : end.column,
      },
    };
  }
}
