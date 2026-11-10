import type { Terminal } from "@xterm/xterm";
import { claudeModPanels, nativeKeptSpans } from "./mobile/claude-mod-panels";
import { nativeChrome } from "./terminal-native-chrome";
import type { NativeFlowFrame } from "./terminal-native-flow";

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
  const end = Math.min(
    buffer.baseY + chrome.start,
    ...panels.filter((panel) => panel.left === 0).map((panel) => panel.top),
  );
  const columns = Math.min(
    term.cols,
    ...panels.filter((panel) => panel.left > 0).map((panel) => panel.left),
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
