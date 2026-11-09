import type { RichTerminalBlock } from "../shared/rich-terminal";

export interface RichFragment {
  firstRow: number;
  rowOffset: number;
  rows: number;
  column: number;
  /** Clip before unrelated native text sharing a reservation row. */
  columns?: number;
}

/** Only paint rows that still carry this answer's authenticated reservation. */
export function richFragments(lines: string[], blocks: RichTerminalBlock[]) {
  const known = new Map(
    blocks.filter((b) => b.renderer === "rows-v2").map((b) => [b.id, b]),
  );
  const found = new Map<string, RichFragment[]>();
  let run: { id: string; fragment: RichFragment } | undefined;
  const finish = () => {
    if (!run) return;
    const previous = found.get(run.id) || [];
    previous.push(run.fragment);
    found.set(run.id, previous);
    run = undefined;
  };
  lines.forEach((line, index) => {
    // Claude can append its floating scroll hint to the last reservation row.
    // Keep other native output outside the fragment, including wrapped lines.
    const match = /^(\s*)~HBR:([a-f0-9]{20}):(\d{1,3})~(.*)$/.exec(line);
    const block = match && known.get(match[2]);
    const offset = match ? Number(match[3]) : -1;
    const suffix = match?.[4] || "";
    const decoration = /^\s*(?:Jump to bottom \(ctrl\+End\)\s*↓\s*)?$/.test(
      suffix,
    );
    const gap = /^\s{2,}(?=\S)/.exec(suffix);
    if (
      !block ||
      offset < 0 ||
      offset >= (block.rows || 400) ||
      (!decoration && !gap)
    ) {
      finish();
      return;
    }
    const column = match![1].length;
    const columns = decoration
      ? undefined
      : match![0].length - suffix.length - column + gap![0].length;
    if (
      run &&
      run.id === block.id &&
      run.fragment.firstRow + run.fragment.rows === index &&
      run.fragment.rowOffset + run.fragment.rows === offset &&
      run.fragment.columns === columns
    ) {
      run.fragment.rows++;
      // The native scroll hint can also remove the normal answer indentation.
      run.fragment.column = Math.min(run.fragment.column, column);
    } else {
      finish();
      run = {
        id: block.id,
        fragment: {
          firstRow: index,
          rowOffset: offset,
          rows: 1,
          column,
          ...(columns === undefined ? {} : { columns }),
        },
      };
    }
  });
  finish();
  return found;
}
