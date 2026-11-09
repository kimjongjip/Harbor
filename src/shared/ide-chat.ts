import type { Approval, MessageItem, SessionStatus } from "./types.js";
import type { HistoryPage } from "./history.js";

export type IdeChatProvider = "codex" | "claude";
export interface IdeChatLive {
  terminalId: string;
  canSend: boolean;
  canInterrupt: boolean;
  transport: "codex-native" | "claude-channel" | "unavailable";
  reason?: string;
}
export interface IdeChatConversation {
  id: string;
  runtimeId: string;
  hostId: string;
  provider: IdeChatProvider;
  nativeId: string;
  title: string;
  cwd: string;
  model: string;
  status: SessionStatus;
  items: MessageItem[];
  approvals: Approval[];
  historyCursor: string | null;
  historyNotice?: string;
  error?: string;
  revision: number;
  updatedAt: number;
  /** A view of the existing CLI; never a second native conversation process. */
  live?: IdeChatLive;
}
export interface IdeChatCreate {
  hostId: string;
  provider: IdeChatProvider;
  requestId: string;
  cwd?: string;
  model?: string;
  resumeId?: string;
}
export interface IdeChatSend {
  runtimeId: string;
  requestId: string;
  text: string;
}
export interface IdeChatReceipt {
  ok: true;
  requestId: string;
  status: "submitted" | "queued" | "uncertain";
  duplicate?: boolean;
}
export type IdeChatHistory = HistoryPage;
export interface IdeChatAnswer {
  runtimeId: string;
  approved?: boolean;
  answers?: Record<string, string>;
}
