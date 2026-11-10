import type { Terminal } from "@xterm/xterm";
import type { HistoryDetail, HistoryPage } from "../shared/history";
import { conversationTurns, expandTimeline } from "./conversation-turns";
import { nativeFlowFrame } from "./terminal-native-flow";
import { hasNativeCompletedAnswer } from "./terminal-transcript-boundary";

/** Inspect only the live footer, never scrollback, prompts or shell commands. */
export function codexHistoryTitle(term: Terminal): string | undefined {
  const buffer = term.buffer.active;
  if (buffer.type !== "alternate" || !term.modes.bracketedPasteMode) return;
  const floor = buffer.baseY + Math.max(0, term.rows - 6);
  let last = buffer.baseY + term.rows - 1;
  const line = (row: number) =>
    buffer.getLine(row)?.translateToString(true) || "";
  while (last >= floor && !line(last).trim()) last--;
  if (
    !/^ {2,}.*\? for shortcuts(?:\s+(?:[·•]\s*)?⚠\s+\d+\s+warnings?(?:\s*[·•]\s*f\d+\s+to view)?)?\s*$/.test(
      line(last),
    )
  )
    return;
  const status =
    /^ {2,}(?:gpt-[\w.-]+|o\d[\w.-]*|codex[\w.-]*)(?: [\w-]+)? · [^\r\n]+? · (.+)$/i.exec(
      line(last - 1),
    );
  const title = status?.[1].trim();
  if (
    title &&
    title.length <= 180 &&
    !/[\x00-\x1f\x7f]|(?:…|\.\.\.)$/.test(title)
  )
    return title;
}

/** The history API is read-only. Fail closed on duplicates, extra pages,
 * mismatched scope, clipped titles or a different answer on the live screen. */
export async function recoverTerminalHistorySession(
  term: Terminal,
  hostId: string,
  title: string,
  read: <T>(path: string) => Promise<T>,
): Promise<string | undefined> {
  const path = `/hosts/${encodeURIComponent(hostId)}/history`;
  const page = await read<HistoryPage>(
    `${path}?${new URLSearchParams({ provider: "codex", search: title })}`,
  );
  if (page.nextCursor || !Array.isArray(page.data)) return;
  const matches = page.data.filter((thread) => thread.title === title);
  if (matches.length !== 1) return;
  const thread = matches[0];
  if (
    thread.hostId !== hostId ||
    (thread.provider && thread.provider !== "codex") ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(thread.id) ||
    codexHistoryTitle(term) !== title
  )
    return;
  const detail = await read<HistoryDetail>(
    `${path}/${encodeURIComponent(thread.id)}?provider=codex&includeActivity=1`,
  );
  if (
    detail.thread.id !== thread.id ||
    detail.thread.hostId !== hostId ||
    detail.thread.title !== title ||
    (detail.thread.provider && detail.thread.provider !== "codex") ||
    codexHistoryTitle(term) !== title
  )
    return;
  if (
    hasNativeCompletedAnswer(
      conversationTurns(expandTimeline(detail)),
      nativeFlowFrame(term),
    )
  )
    return thread.id;
}
