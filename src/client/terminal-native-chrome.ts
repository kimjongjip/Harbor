/**
 * Locate the CLI's own interactive area at the bottom of its screen: the
 * composer, its status/spinner (and todo) lines, or a permission dialog.
 * Fullscreen CLIs repaint their transcript above this area; Harbor shows that
 * transcript from saved history and keeps only these live rows native.
 * Purely presentational: nothing here sends input or decides completion.
 */
export interface NativeChrome {
  /** First row of the live area. */
  start: number;
  /** Claude-style rules framed it; their dialogs are fully enclosed. */
  framed: boolean;
}

const solidRule = /^\s*[─━]{12,}\s*$/;
const promptRow = /^\s{0,2}[❯›>»](?:\s|$)/;
// Claude's activity line: a glyph in column 0, then a verb/elapsed status.
const spinnerRow =
  /^[·✢✳✶✻✽✦✧*∗]\s+\S.*(?:…|\.\.\.|\bfor \d|\(\d+(?:m \d+)?s|esc to interrupt)/;
const codexStatusRow =
  /^\s{0,2}•\s+(?:Working|Waiting|Running|Thinking|Exploring|Planning)\b|esc to interrupt|^\s{0,2}(?:•\s+)?(?:Worked|Waited) for\b/;

export function nativeChrome(
  lines: readonly string[],
  end = lines.length,
): NativeChrome | undefined {
  let last = Math.min(end, lines.length) - 1;
  while (last >= 0 && !lines[last]?.trim()) last--;
  if (last < 0) return;
  const floor = Math.max(0, last - 45);
  let rule = -1;
  for (let row = last; row >= Math.max(floor, last - 30); row--)
    if (solidRule.test(lines[row])) {
      rule = row;
      break;
    }
  if (rule >= 0) {
    let start = rule;
    // A composer is a prompt row (plus wrapped draft) between two rules; a
    // permission dialog starts at a single rule and encloses everything below.
    for (let row = rule - 1; row >= Math.max(floor, rule - 16); row--) {
      if (!solidRule.test(lines[row])) continue;
      if (lines.slice(row + 1, rule).some((line) => promptRow.test(line)))
        start = row;
      break;
    }
    // Keep the spinner and any todo/queued lines it owns just above.
    let blanks = 0;
    for (let row = start - 1; row >= Math.max(floor, start - 14); row--) {
      const line = lines[row];
      if (!line.trim()) {
        if (++blanks > 2) break;
        continue;
      }
      if (spinnerRow.test(line)) {
        start = row;
        break;
      }
      if (!/^\s{2,}\S/.test(line)) break;
    }
    return { start, framed: true };
  }
  // Codex: the composer prompt sits within a few footer lines of the bottom.
  // Its transcript also shows typed prompts with `›`, so only indented footer
  // or blank rows may follow the composer.
  for (let row = last; row >= Math.max(floor, last - 6); row--) {
    if (!promptRow.test(lines[row])) {
      if (lines[row].trim() && !/^\s{2,}\S/.test(lines[row])) return;
      continue;
    }
    let start = row,
      blanks = 0;
    for (let up = row - 1; up >= Math.max(floor, row - 6); up--) {
      const line = lines[up];
      if (!line.trim()) {
        if (++blanks > 2) break;
        continue;
      }
      if (codexStatusRow.test(line)) start = up;
      break;
    }
    return { start, framed: false };
  }
}

/** The newest top-level transcript block above the live area (●/⏺/• bullets). */
export function lastNativeBlock(lines: readonly string[], before: number) {
  for (let row = before - 1; row >= Math.max(0, before - 60); row--)
    if (/^[●⏺•]\s/.test(lines[row] || "")) return row;
  return 0;
}
