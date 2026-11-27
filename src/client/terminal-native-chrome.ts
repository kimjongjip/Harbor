import type { IBuffer } from "@xterm/xterm";

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

/** Claude replaces the top composer rule with “── History 1/3 ──” and may
 * leave its terminal cursor on the spinner. Use the composer frame itself. */
export function promptHistoryStart(
  lines: string[],
  end: number,
  frame: NativeChromeFrame,
  navigating: boolean,
) {
  const floor = Math.max(0, frame.baseY);
  let last = end - 1;
  while (last >= floor && !lines[last].trim()) last--;
  // A recalled slash command is still a draft until the user submits it.
  const slashDraft =
    navigating &&
    frame.cursorRow >= floor &&
    /^\s*[❯›»>]\s*\//.test(lines[frame.cursorRow] || "");
  for (let bottom = last; bottom >= Math.max(floor + 2, last - 6); bottom--) {
    if (!solidRule.test(lines[bottom])) continue;
    for (let row = bottom - 2; row >= floor; row--) {
      if (
        /^\s*[─━]+\s*History\s+\d+\s*\/\s*\d+\s*[─━]+\s*$/i.test(lines[row]) &&
        promptRow.test(lines[row + 1])
      )
        return row;
      if (solidRule.test(lines[row])) break;
    }
    if (
      slashDraft &&
      frame.cursorRow < bottom &&
      solidRule.test(lines[frame.cursorRow - 1] || "")
    )
      return frame.cursorRow - 1;
    return;
  }
  if (
    slashDraft &&
    lines
      .slice(frame.cursorRow + 1, end)
      .every((line) => !line.trim() || /^ {2}/.test(line))
  )
    return frame.cursorRow;
  // A CLI can also repaint a multiline history entry without any rules.
  // Only treat its contiguous draft and working footer as input during recall.
  if (!navigating || !/^\s*esc to interrupt\s*$/i.test(lines[last] || ""))
    return;
  for (let row = last - 1; row >= floor; row--) {
    if (promptRow.test(lines[row])) return row;
    if (lines[row].trim() && !frame.wrapped?.[row] && !/^ {2}/.test(lines[row]))
      return;
  }
}

/** A Codex modal overwrites a rectangle of the current viewport. Text on both
 * sides of it (and the normal composer below) still belongs to the background. */
export function insetChoiceDialog(buffer: IBuffer, lines?: readonly string[]) {
  const floor = buffer.baseY,
    end = lines?.length ?? buffer.length;
  const textAt = (row: number) =>
    lines?.[row] ?? buffer.getLine(row)?.translateToString(true) ?? "";
  const footer =
    /^\s{0,5}(?:enter|return)\s+(?:to\s+)?(?:select|confirm|continue)\s*[·•]\s*esc\s+(?:to\s+)?(?:back|cancel|close)\b/i;
  for (let foot = end - 1; foot >= floor; foot--) {
    if (!/\besc\s+(?:to\s+)?(?:back|cancel|close)\b/i.test(textAt(foot)))
      continue;
    for (let row = foot - 1; row >= floor; row--) {
      if (!/[›❯»>]\s*\d+[.)]\s+\S/u.test(textAt(row))) continue;
      const line = buffer.getLine(row);
      if (!line) continue;
      // String offsets differ from terminal columns after Korean/wide glyphs.
      for (let col = 0; col < line.length; col++) {
        if (!/^[›❯»>]$/u.test(line.getCell(col)?.getChars() || "")) continue;
        const number = /^[›❯»>]\s+(\d+)[.)]\s+\S/u.exec(
          line.translateToString(true, col),
        );
        if (
          !number ||
          !footer.test(buffer.getLine(foot)?.translateToString(true, col) || "")
        )
          continue;
        const selected = line.getCell(col + 2);
        if (!selected || (selected.isBgDefault() && !selected.isInverse()))
          continue;
        for (let other = Math.max(floor, row - 8); other < foot; other++) {
          if (other === row) continue;
          const sibling = /^\s{1,4}(\d+)[.)]\s+\S/u.exec(
            buffer.getLine(other)?.translateToString(true, col) || "",
          );
          if (sibling && Math.abs(Number(sibling[1]) - Number(number[1])) === 1)
            return true;
        }
      }
    }
  }
  return false;
}

/** Interactive pickers need xterm's cursor, reverse video and mouse hit
 * targets. Inspect the current viewport only; old /commands in scrollback
 * are conversation history. Keep a picker through its partial redraws. */
export function nativeMenuVisible(
  lines: readonly string[],
  end: number,
  frame: NativeChromeFrame,
  previous: boolean,
) {
  const cursor = lines[frame.cursorRow] || "";
  const viewport = lines.slice(frame.baseY, end);
  const tail = viewport.filter((line) => line.trim()).slice(-4);
  // Claude positions the cursor independently of the composer on some
  // terminals. Match its bottom input frame even when the cursor is hidden.
  for (
    let bottomRule = viewport.length - 1;
    bottomRule >= Math.max(2, viewport.length - 5);
    bottomRule--
  ) {
    if (!solidRule.test(viewport[bottomRule])) continue;
    const input = viewport[bottomRule - 1];
    if (solidRule.test(viewport[bottomRule - 2]) && promptRow.test(input))
      return /^\s*[❯›»>]\s*\//.test(input);
    break;
  }
  // A redraw can leave the cursor over an echoed path in the transcript.
  // A framed composer above has the authoritative slash-command state.
  if (/^\s*[❯›»>]\s*\//.test(cursor)) return true;
  const belowCursor = lines
    .slice(frame.cursorRow + 1, end)
    .filter((line) => line.trim());
  if (
    promptRow.test(cursor) &&
    (solidRule.test(belowCursor[0] || "") ||
      belowCursor.some((line) => codexFooterRow.test(line)))
  )
    return false;
  const pickerControls = tail.some(
    (line) =>
      /^\s*(?:(?:press|use)\s+)?(?:↑|↓|←|→|arrow keys\b|tab\b|enter\b|return\b|esc\b).{0,180}$/iu.test(
        line,
      ) &&
      /(?:navigate|select|confirm|cancel|go back|dismiss|enter\s+continue\s*·\s*esc\s+back)/i.test(
        line,
      ) &&
      /(?:enter|return|esc)/i.test(line),
  );
  const pickerHeading = viewport.some((line) =>
    /^\s*(?:select|choose|set)\s+(?:(?:a|the|your)\s+)?(?:model|reasoning|effort)\b/i.test(
      line,
    ),
  );
  const option = viewport.some((line) => /^\s*[❯›»>]\s+\S/.test(line));
  if (
    pickerControls &&
    tail.some((line) => /(?:↑.?↓|←.?→).*\benter\b.*\besc\b/i.test(line))
  )
    return true;
  if (
    pickerControls &&
    (pickerHeading || previous || (option && !nativeChoiceDialog(viewport)))
  )
    return true;
  if (pickerHeading && option && (previous || !promptRow.test(cursor)))
    return true;
  if (!previous) return false;
  // Both CLIs can briefly clear even the cursor row between menu levels.
  // Restore rich history once their ordinary input or shell actually returns.
  if (promptRow.test(cursor) && !pickerControls) return false;
  if (
    tail.some((line) => codexFooterRow.test(line)) &&
    viewport.some((line) => promptRow.test(line))
  )
    return false;
  return !/^(?:\s*[$#%]\s*|\s*PS\s+[^>]+>\s*)$/i.test(tail.at(-1) || "");
}
// Claude's activity line: a glyph in column 0, then a verb/elapsed status.
const spinnerRow =
  /^[·✢✳✶✻✽✦✧*∗]\s+\S.*(?:…|\.\.\.|\bfor \d|\(\d+(?:m \d+)?s|esc to interrupt)/;
/** Claude status text from the PTY, including verb/spinner variations. */
export function claudeWorkTimer(line: string) {
  return /^\s*[·✢✳✶✻✽✦✧*∗]\s+.+?(?:…|\.\.\.)\s*\(\s*\d+(?:\.\d+)?(?:ms|s|m|h)\b/u.test(line);
}
export function claudeElapsedFooter(line: string) {
  return claudeWorkTimer(line) || /^\s*[·✢✳✶✻✽✦✧*∗]\s+.+? for \d+(?:\.\d+)?(?:ms|s|m|h)\b.*\bdone\b/i.test(line);
}
const codexStatusRow =
  /^\s{0,2}•\s+(?:Working|Waiting|Running|Thinking|Exploring|Planning)\b|esc to interrupt|^\s{0,2}(?:•\s+)?(?:Worked|Waited) for\b/;
const codexPromptRow = /^ {0,2}[›»](?: |$)/;
// Codex may append its warning counter after the shortcuts, separated by
// spaces or a middle dot. Accept that known UI suffix, not arbitrary output.
const codexFooterRow =
  /^ {2,}(?:.*(\? for shortcuts|← for agents|tab to queue(?: message)?|\d+% context left)(?:\s+(?:[·•]\s*)?Goal achieved\s*\([^()]*\))?(?:\s+(?:[·•]\s*)?⚠\s+\d+\s+warnings?(?:\s*[·•]\s*f\d+\s+to view)?)?|gpt-[\w.-]+\b.*)$/i;

/** Require the shortcuts line for history lookup; a model/status line alone is insufficient. */
export const codexShortcutsFooter = (line: string) =>
  codexFooterRow.exec(line.trimEnd())?.[1]?.toLowerCase() === "? for shortcuts";

function dialogControlRow(line: string) {
  // Real footer hints are standalone controls, not phrases quoted in a prompt
  // or a tool's explanation. Each middle-dot-separated segment must be a hint.
  return line
    .trim()
    .split(/\s*[·•]\s*/)
    .every((part) =>
      /^(?:press (?:enter|return|any key)(?: to (?:select|confirm|continue))?|(?:enter|return|esc|escape|tab|shift\+tab|tab\/arrow keys|arrow keys|ctrl\+[a-z]|↑\/?↓|←\/?→|↑↓|↵)\s+(?:to\s+)?(?:select|confirm|continue|cancel|navigate|amend|submit|dismiss|move|switch|change)(?:\s+(?:questions?|options?|tabs?|selection))?)[.!…]?$/i.test(
        part,
      ),
    );
}

/** Waiting hooks also describe an ordinary idle composer. Only visible choices
 * identify a dialog; activity state alone must never switch the transcript. */
export function nativeChoiceDialog(
  lines: readonly string[],
  end = lines.length,
  start = 0,
  frame?: NativeChromeFrame,
) {
  let last = Math.min(end, lines.length) - 1;
  while (last >= 0 && !lines[last].trim()) last--;
  if (frame && cursorComposer(lines, last, frame) !== undefined) return false;
  const firstRow = Math.max(start, end - 30);
  const tail = lines.slice(firstRow, end);
  const options = tail.flatMap((line, index) => {
    const match = /^\s*([›❯»>]\s*)?\d+[.)]\s+(\S.*)$/.exec(line);
    return match ? [{ selected: !!match[1], text: match[2], index }] : [];
  });
  if (options.length < 2 || !options.some((option) => option.selected))
    return false;
  // Submitted prompts routinely begin with "1." and contain numbered lists.
  // A list alone is not evidence that the CLI is asking for a decision.
  const after = tail
    .slice(options.at(-1)!.index + 1)
    .filter((line) => line.trim());
  if (after.some(dialogControlRow)) return true;
  if (after.length) return false;
  const firstOptionRow = firstRow + options[0].index;
  const question = lines
    .slice(Math.max(0, frame?.baseY ?? 0, firstOptionRow - 120), firstOptionRow)
    .some((line) =>
      /^\s*(?:allow\b|approve\b|do you want\b|would you like\b).*\?\s*$/i.test(
        line,
      ),
    );
  if (!question) return false;
  return (
    options.some((option) => /^(?:yes\b|예(?:\s|$))/i.test(option.text)) &&
    options.some((option) =>
      /^(?:no\b|아니[요오](?:\s|$))/i.test(option.text),
    ) &&
    options.every((option) =>
      /^(?:yes\b|no\b|예(?:\s|$)|아니[요오](?:\s|$))/i.test(option.text),
    )
  );
}

/** A CLI can spend multiple transport chunks redrawing saved commands/diffs.
 * Those recognizable transcript fragments are not a new interactive surface.
 * Unknown screens, actual dialogs and shell prompts still take the fallback. */
export function nativeTranscriptRepaint(
  lines: readonly string[],
  end = lines.length,
) {
  const tail = lines
    .slice(Math.max(0, end - 80), end)
    .filter((line) => line.trim());
  if (!tail.length) return true;
  if (nativeChoiceDialog(tail)) return false;
  if (tail.slice(-3).some(dialogControlRow)) return false;
  const last = tail.at(-1)!;
  if (
    /^(?:\s*(?:PS\s+[^>]*>|[\w.-]+@[^\s]+.*[#$]|[$#%])\s*$|.*(?:Process exited\.|[\\/]\S*>\s*$))/i.test(
      last,
    )
  )
    return false;
  return tail.some((line) =>
    /^(?:\s*\d+\s+[-+]|\s*(?:[●⏺•]\s*)?(?:Bash|Read|Edit|Write|Update|Task)\(|\s*[●⏺•]\s+(?:Ran|Called|Edited|Added|Deleted|Explored)\b)/.test(
      line,
    ),
  );
}

/** Losing the composer is not proof that the CLI left its transcript. Only
 * positive interactive/exit evidence may replace an already committed reader. */
export function nativeInteractiveReplacement(
  lines: readonly string[],
  end = lines.length,
  allowStandaloneControls = true,
) {
  const tail = lines
    .slice(Math.max(0, end - 30), end)
    .filter((line) => line.trim());
  if (nativeChoiceDialog(tail)) return true;
  // During confirmed work, standalone hints and shell prompts can be tool
  // output. Choice dialogs remain available independently of that state.
  if (!allowStandaloneControls) return false;
  if (tail.slice(-3).some(dialogControlRow)) return true;
  const last = tail.at(-1) || "";
  return /^(?:\s*(?:PS\s+[^>]*>|[A-Za-z]:[\\/][^>]*>|[\w.-]+@[^\s]+.*[#$]|[$#%])\s*$|\s*:(?:wq?|q!?)?\s*$|\s*\(END\)\s*)$/i.test(
    last,
  );
}

/** Claude's foreground task view has no composer/rules. Its background-key
 * hint anchors a live task surface, not a replacement for the saved transcript. */
function foregroundTask(
  lines: readonly string[],
  last: number,
  floor = Math.max(0, last - 3),
): number | undefined {
  let footer = -1;
  for (let row = last; row >= floor; row--)
    if (
      /^\s*\(?ctrl\+b\b.*\b(?:run|move|send)\b.*\bbackground\)?\s*$/i.test(
        lines[row],
      )
    ) {
      footer = row;
      break;
    }
  if (footer < 0) return;
  let start = footer;
  for (let row = footer - 1; row >= Math.max(0, footer - 24); row--) {
    const line = lines[row];
    if (!line.trim()) {
      if (start < footer) break;
      continue;
    }
    start = row;
    if (/^\s{0,4}\S.*[·•]\s*\d+(?:\.\d+)?\s*(?:ms|s|m|h)(?:\s.*)?$/.test(line))
      break;
  }
  return start;
}

/** Claude can put a task, a pending input and its send shortcut above the
 * composer, or replace the composer with that activity panel entirely.
 * Only inspect the current viewport. Scrollback contains obsolete controls. */
export function claudeActivityStart(
  lines: readonly string[],
  end: number,
  floor: number,
) {
  const task = foregroundTask(lines, end - 1, floor);
  let start = task;
  // An SSH repaint may contain the elapsed status before the composer rules.
  // Accept the native footer only at the viewport tail, never from old output.
  for (let row=end-1; row>=Math.max(floor,end-12); row--) {
    const line=lines[row].trim();
    if (claudeElapsedFooter(line)) { start=Math.min(start ?? row,row); break; }
    if (line && !solidRule.test(line) && !/^(?:[❯›>]\s*$|[✓✔]?\s*Update installed\b)/i.test(line)) break;
  }
  for (let row = end - 1; row >= floor; row--) {
    const line = lines[row].trim();
    // The binding is configurable. Preserve the actual shortcut and the
    // queued text, including multiple messages wrapped above the hint.
    if (
      /^(?:(?:ctrl|alt|shift|cmd)\+\S+.*\bsend now|click to send now|press up to (?:edit|select) (?:a )?queued messages?\b.*)$/i.test(
        line,
      )
    ) {
      let first = row;
      while (first > floor) {
        const above = lines[first - 1];
        if (
          solidRule.test(above) ||
          spinnerRow.test(above) ||
          /^[●⏺•]\s/.test(above)
        )
          break;
        first--;
      }
      start = Math.min(start ?? first, first);
    }
    if (
      /[·•]\s*summary\s*$/i.test(line) &&
      (task === undefined || row < task)
    ) {
      let first = row;
      while (
        first > floor &&
        !/^[●⏺•]\s/.test(lines[first]) &&
        lines[first - 1].trim()
      )
        first--;
      if (/^[●⏺•]\s/.test(lines[first])) {
        start = Math.min(start ?? first, first);
        break;
      }
    }
  }
  return start === undefined ? undefined : Math.max(floor, start);
}

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

/** The lower rule and model hint can survive a tmux resize before the upper rule
 * has repainted. Anchor agy's editor to the prompt owning the live cursor. */
export function agyComposerStart(lines: readonly string[], end:number, frame:NativeChromeFrame) {
  // Streaming updates move the native cursor into output before returning it
  // to the editor. The framed prompt still belongs to the composer.
  let bottomRule=end-1;
  while (bottomRule>=Math.max(frame.baseY,end-6) && !solidRule.test(lines[bottomRule])) bottomRule--;
  if (bottomRule>=Math.max(frame.baseY,end-6) && lines.slice(bottomRule+1,end).some(line=>
    /\? for shortcuts|(?:^|\s)(?:auto|plan|accept-edits)\s*·/i.test(line))) {
    for (let top=bottomRule-2;top>=frame.baseY;top--) {
      if (!solidRule.test(lines[top])) continue;
      if (/^\s{0,2}>(?:\s|$)/u.test(lines[top+1])) return top;
      break;
    }
  }
  const cursor=frame.cursorRow;
  if(cursor<frame.baseY || cursor>=end) return;
  let bottom=cursor+1;
  while(bottom<end && !solidRule.test(lines[bottom])) bottom++;
  if(bottom===end) return;
  let prompt=cursor;
  while(prompt>=frame.baseY && !/^\s{0,2}>(?:\s|$)/u.test(lines[prompt])) {
    if(solidRule.test(lines[prompt])) return;
    prompt--;
  }
  if(prompt<frame.baseY) return;
  return prompt>frame.baseY && solidRule.test(lines[prompt-1]) ? prompt-1 : prompt;
}

export function nativeChrome(
  lines: readonly string[],
  end = lines.length,
  frame?: NativeChromeFrame,
): NativeChrome | undefined {
  let last = Math.min(end, lines.length) - 1;
  while (last >= 0 && !lines[last]?.trim()) last--;
  if (last < 0) return;
  const task = foregroundTask(lines, last);
  if (task !== undefined) return { start: task, framed: false };
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
    // History recall can expand Claude's draft to the whole viewport. The
    // old 16-row scan then treated the recalled prompt as tool output. When
    // the live cursor/parser identify input, follow its frame to the top of
    // the viewport rather than dropping the upper part of the composer.
    const composerFloor =
      frame?.bracketedPasteMode &&
      frame.cursorRow >= frame.baseY &&
      frame.cursorRow < rule
        ? Math.max(0, frame.baseY)
        : Math.max(floor, rule - 16);
    for (let row = rule - 1; row >= composerFloor; row--) {
      if (!solidRule.test(lines[row])) continue;
      if (lines.slice(row + 1, rule).some((line) => promptRow.test(line)))
        start = row;
      break;
    }
    // Keep the spinner and any todo/queued lines it owns just above.
    let blanks = 0;
    for (
      let row = start - 1;
      row >= Math.max(Math.min(floor, composerFloor), start - 14);
      row--
    ) {
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
