import type { Terminal } from "@xterm/xterm";
import type { HistoryDetail, HistoryPage } from "../shared/history";
import { conversationTurns, expandTimeline } from "./conversation-turns";
import { nativeFlowFrame } from "./terminal-native-flow";
import { hasNativeCompletedAnswer } from "./terminal-transcript-boundary";
import { codexShortcutsFooter } from "./terminal-native-chrome";

const clippedEnd = /(?:…|\.\.\.)$/;
const titlePrefix = (title: string) => title.replace(clippedEnd, "").trimEnd();

/** Inspect only the live footer, never scrollback, prompts or shell commands. */
export function codexHistoryTitle(term: Terminal): string | undefined {
  const buffer = term.buffer.active;
  if (buffer.type !== "alternate" || !term.modes.bracketedPasteMode) return;
  const floor = buffer.baseY + Math.max(0, term.rows - 6);
  let last = buffer.baseY + term.rows - 1;
  const line = (row: number) =>
    buffer.getLine(row)?.translateToString(true) || "";
  while (last >= floor && !line(last).trim()) last--;
  if (!codexShortcutsFooter(line(last))) return;
  const status =
    /^ {2,}(?:gpt-[\w.-]+|o\d[\w.-]*|codex[\w.-]*)(?: [\w-]+)? · [^\r\n]+? · (.+)$/i.exec(
      line(last - 1),
    );
  const title = status?.[1].trim();
  if (
    title &&
    title.length <= 180 &&
    !/[\x00-\x1f\x7f]/.test(title) &&
    (!clippedEnd.test(title) ||
      titlePrefix(title).replace(/\s/g, "").length >= 12)
  )
    return title;
}

/** A clipped footer can narrow the search, but only one matching catalog
 * title plus completed-answer evidence can identify the conversation. */
export async function recoverTerminalHistorySession(
  term: Terminal,
  hostId: string,
  title: string,
  read: <T>(path: string) => Promise<T>,
): Promise<string | undefined> {
  const path = `/hosts/${encodeURIComponent(hostId)}/history`;
  const clipped = clippedEnd.test(title);
  const search = clipped ? titlePrefix(title) : title;
  const page = await read<HistoryPage>(
    `${path}?${new URLSearchParams({ provider: "codex", search })}`,
  );
  if (page.nextCursor || !Array.isArray(page.data)) return;
  const matches = page.data.filter((thread) =>
    clipped ? thread.title.startsWith(search) : thread.title === title,
  );
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
    detail.thread.title !== thread.title ||
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
