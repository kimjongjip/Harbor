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

/** Actual cursor/parser evidence, never inferred from saved conversation text. */
export interface NativeChromeFrame {
  cursorRow: number;
  cursorColumn?: number;
  baseY: number;
  wrapped?: readonly boolean[];
  bracketedPasteMode?: boolean;
}

const solidRule = /^\s*[─━]{12,}\s*$/;
const promptRow = /^\s{0,2}[❯›>»](?:\s|$)/;
// Claude's activity line: a glyph in column 0, then a verb/elapsed status.
const spinnerRow =
  /^[·✢✳✶✻✽✦✧*∗]\s+\S.*(?:…|\.\.\.|\bfor \d|\(\d+(?:m \d+)?s|esc to interrupt)/;
const codexStatusRow =
  /^\s{0,2}•\s+(?:Working|Waiting|Running|Thinking|Exploring|Planning)\b|esc to interrupt|^\s{0,2}(?:•\s+)?(?:Worked|Waited) for\b/;
const codexPromptRow = /^ {0,2}[›»](?: |$)/;
// Codex may append its warning counter after the shortcuts, separated by
// spaces or a middle dot. Accept that known UI suffix, not arbitrary output.
const codexFooterRow =
  /^ {2,}(?:.*(?:\? for shortcuts|← for agents|tab to queue(?: message)?|\d+% context left)(?:\s+(?:[·•]\s*)?⚠\s+\d+\s+warnings?(?:\s*[·•]\s*f\d+\s+to view)?)?|gpt-[\w.-]+\b.*)$/i;

/** A long composer can extend above the small footer search window. Follow the
 * live cursor's genuine wraps first. Cursor-positioned TUI rows have no wrap
 * flags, so those additionally need the Codex footer and input parser mode.
 * Never walk into scrollback, across unindented output, or from a footer cursor.
 */
export function cursorComposer(
  lines: readonly string[],
  last: number,
  frame: NativeChromeFrame | undefined,
) {
  if (
    !frame?.bracketedPasteMode ||
    frame.cursorRow < frame.baseY ||
    frame.cursorRow > last ||
    codexFooterRow.test(lines[frame.cursorRow] || "")
  )
    return;
  const floor = Math.max(0, frame.baseY);
  let first = frame.cursorRow,
    final = frame.cursorRow;
  while (first > floor && frame.wrapped?.[first]) first--;
  while (final < last && frame.wrapped?.[final + 1]) final++;
  if (codexPromptRow.test(lines[first] || "") && last - final <= 6) {
    for (let row = final + 1; row <= last; row++)
      if (lines[row].trim() && !/^ {2,}\S/.test(lines[row])) return;
  } else {
    // Explicitly positioned multiline drafts use two-space continuation rows.
    // A generic indented answer is insufficient evidence: require a recognized
    // footer below the cursor, confined to the same six-row footer region.
    let footer = last + 1,
      recognized = false;
    for (let row = last; row >= Math.max(floor, last - 5); row--) {
      if (row <= frame.cursorRow) break;
      if (codexFooterRow.test(lines[row])) recognized = true;
      else if (lines[row].trim()) break;
      footer = row;
    }
    if (!recognized || frame.cursorRow >= footer) return;
    first = frame.cursorRow;
    while (first >= floor && !codexPromptRow.test(lines[first] || "")) {
      if (
        lines[first]?.trim() &&
        !frame.wrapped?.[first] &&
        !/^ {2,}\S/.test(lines[first])
      )
        return;
      first--;
    }
    if (first < floor) return;
    for (let row = first + 1; row < footer; row++)
      if (
        lines[row].trim() &&
        !frame.wrapped?.[row] &&
        (!/^ {2,}\S/.test(lines[row]) || codexFooterRow.test(lines[row]))
      )
        return;
  }
  const prefix = codexPromptRow.exec(lines[first]);
  if (
    !prefix ||
    (first === frame.cursorRow &&
      frame.cursorColumn !== undefined &&
      frame.cursorColumn < prefix[0].length)
  )
    return;
  return first;
}

function codexStart(lines: readonly string[], row: number, floor: number) {
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
  return start;
}

export function nativeChrome(
  lines: readonly string[],
  end = lines.length,
  frame?: NativeChromeFrame,
): NativeChrome | undefined {
  let last = Math.min(end, lines.length) - 1;
  while (last >= 0 && !lines[last]?.trim()) last--;
  if (last < 0) return;
  const composer = cursorComposer(lines, last, frame);
  if (composer !== undefined)
    return {
      start: codexStart(lines, composer, Math.max(0, frame!.baseY)),
      framed: false,
    };
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
    return { start: codexStart(lines, row, floor), framed: false };
  }
}

/** The newest top-level transcript block above the live area (●/⏺/• bullets). */
export function lastNativeBlock(lines: readonly string[], before: number) {
  for (let row = before - 1; row >= Math.max(0, before - 60); row--)
    if (/^[●⏺•]\s/.test(lines[row] || "")) return row;
  return 0;
}
