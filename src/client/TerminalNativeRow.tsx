import { memo, type ReactNode } from "react";
import { trimNativeRow, type NativeRun } from "./mobile/terminal-flow";
import "./terminal-native-row.css";

/**
 * Keep the terminal's cell backgrounds independently from selectable text.
 * Trailing blank cells still paint CLI composers, but must not wrap the row or
 * become hundreds of spaces when a user copies a question and its answer.
 */
export const NativeRow = memo(function NativeRow({
  row,
  runs,
  cursorOffset,
  lineHeight,
}: {
  row: number;
  runs: NativeRun[];
  cursorOffset?: number;
  lineHeight: number;
}) {
  let offset = 0;
  const nodes: ReactNode[] = [];
  const shown = trimNativeRow(runs);
  if (cursorOffset !== undefined) {
    const length = shown.reduce((n, run) => n + run.text.length, 0);
    if (length <= cursorOffset) {
      // The cursor can be inside a colored blank range followed by a different
      // background. Preserve each original cell style instead of borrowing the
      // last run's style for all padding between the text and cursor.
      let position = 0;
      const end = cursorOffset + 1;
      for (const run of runs) {
        const start = Math.max(0, length - position);
        const stop = Math.min(run.text.length, end - position);
        if (stop > start)
          shown.push({ text: run.text.slice(start, stop), style: run.style });
        position += run.text.length;
        if (position >= end) break;
      }
      if (position < end)
        shown.push({
          text: " ".repeat(end - Math.max(position, length)),
          style: runs.at(-1)?.style || {},
        });
    }
  }
  for (const [index, run] of shown.entries()) {
    const local = cursorOffset === undefined ? -1 : cursorOffset - offset;
    if (local >= 0 && local < run.text.length) {
      const width = String.fromCodePoint(run.text.codePointAt(local)!).length;
      nodes.push(
        <span key={index} style={run.style}>
          {run.text.slice(0, local)}
          <span
            data-native-cursor="true"
            style={{
              boxShadow: "inset 0 0 0 1px currentColor",
              background: "color-mix(in srgb, currentColor 15%, transparent)",
            }}
          >
            {run.text.slice(local, local + width)}
          </span>
          {run.text.slice(local + width)}
        </span>,
      );
    } else
      nodes.push(
        <span key={index} style={run.style}>
          {run.text}
        </span>,
      );
    offset += run.text.length;
  }
  return (
    <div
      className="terminal-native-row"
      data-native-row={row}
      data-rich-block={`native-row:${row}`}
      data-terminal-rich="true"
      style={{
        position: "relative",
        minHeight: lineHeight,
        lineHeight: `${lineHeight}px`,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}
    >
      <div className="terminal-native-row-fill" aria-hidden="true">
        {runs.map((run, index) => (
          <span
            key={index}
            data-native-fill={run.text}
            style={{
              ...run.style,
              color: "transparent",
              textDecoration: "none",
            }}
          />
        ))}
      </div>
      {nodes}
    </div>
  );
});
