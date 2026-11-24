import type { IdeChatConversation } from "../../shared/ide-chat";
import type { TerminalInfo } from "../../shared/types";

/** A worker's PTY IDs belong to that worker. Only navigate within the actual terminal inventory. */
export function chatTerminalTarget(
  chat: IdeChatConversation | undefined,
  inventory: TerminalInfo[],
  selectedTerminalId: string | undefined,
  serverWorkspace: boolean,
) {
  const live = chat?.live;
  if (!chat || !live || serverWorkspace || chat.status === "offline") return;
  const terminal = inventory.find(t =>
    t.id === live.terminalId && t.hostId === chat.hostId && t.agentKind === chat.provider &&
    t.agentSessionId === chat.nativeId && t.agentConnected && !t.exited && t.connectionState === "connected",
  );
  if (!terminal) return;
  if (live.origin === "terminal") return live.terminalTitle ? terminal : undefined;
  if (live.origin === "managed" || (chat.provider === "antigravity" && terminal.id !== selectedTerminalId))
    return !live.canSend && chat.status === "waiting" ? terminal : undefined;
  return terminal;
}
