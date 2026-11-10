import type { Terminal } from "@xterm/xterm";
import { claudeModPanels, nativeKeptSpans } from "./mobile/claude-mod-panels";
import { nativeChrome } from "./terminal-native-chrome";
import type { NativeFlowFrame } from "./terminal-native-flow";

// These CLI notices belong to the footer, even when they precede the prompt
// frame. Reflowing their native indentation inside the padded history reader
// can push the last words of a right-aligned update notice onto the next line.
const footerNotice =
  /^(?:●Compactedwhileidle,beforethepromptcacheexpired·turnoffwith"idleCompaction":falseinsettings\.json|[✔✓]Updateinstalled·\/restarttoapply)$/;

function noticeStart(text: (row: number) => string, before: number) {
  let start = before,
    end = before;
  const floor = Math.max(0, before - 12);
  while (end > floor) {
    while (end > floor && !text(end - 1).trim()) end--;
    if (end <= floor) break;
    let joined = "",
      found = false;
    // A narrow CLI may position a notice across several rows without wrap
    // flags. Require the complete known text; stop at ordinary transcript rows.
    for (let row = end - 1; row >= Math.max(floor, end - 6); row--) {
      const line = text(row);
      if (!line.trim()) break;
      joined = line.replace(/[\s\uFE0E\uFE0F]/g, "") + joined;
      if (footerNotice.test(joined)) {
        start = end = row;
        found = true;
        break;
      }
    }
    if (!found) break;
  }
  return start;
}

/** Leave the native panel, its mouse targets, images and composer uncovered. */
export function claudeModSurface(term: Terminal) {
  const buffer = term.buffer.active;
  if (buffer.viewportY !== buffer.baseY) return;
  const panels = claudeModPanels(buffer, term.cols, term.rows);
  if (!panels.length) return;
  const lines = Array.from(
    { length: term.rows },
    (_, row) =>
      buffer.getLine(buffer.baseY + row)?.translateToString(true) || "",
  );
  const chrome = nativeChrome(lines);
  if (!chrome?.framed) return;
  const before = Math.min(
    buffer.baseY + chrome.start,
    ...panels.filter((panel) => panel.left === 0).map((panel) => panel.top),
    ...panels.filter((panel) => panel.left > 0).map((panel) => panel.bottom),
  );
  const columns = Math.min(
    term.cols,
    ...panels.filter((panel) => panel.left > 0).map((panel) => panel.left),
  );
  const end =
    buffer.baseY +
    noticeStart(
      (row) =>
        buffer
          .getLine(buffer.baseY + row)
          ?.translateToString(true, 0, columns) || "",
      before - buffer.baseY,
    );
  return { panels, end, columns, baseY: buffer.baseY };
}

export type ClaudeModSurface = NonNullable<ReturnType<typeof claudeModSurface>>;

/** Match history only against the main transcript, never a widget's text. */
export function frameWithoutModPanels(
  term: Terminal,
  frame: NativeFlowFrame,
  surface: ClaudeModSurface | undefined,
): NativeFlowFrame {
  if (!surface) return frame;
  const lines = frame.lines.slice();
  for (let row = surface.baseY; row < frame.end; row++) {
    if (!surface.panels.some((panel) => row >= panel.top && row < panel.bottom))
      continue;
    lines[row] = nativeKeptSpans(frame.columns, row, surface.panels)
      .map(
        ({ start, end }) =>
          term.buffer.active
            .getLine(row)
            ?.translateToString(true, start, end) || "",
      )
      .join(" ")
      .trimEnd();
  }
  return { ...frame, lines };
}
