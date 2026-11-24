import type { Approval, MessageItem, SessionStatus } from "./types.js";
import type { HistoryPage } from "./history.js";

export type IdeChatProvider = import("./agent-provider.js").AgentProvider;
export interface IdeChatLive {
  terminalId: string;
  canSend: boolean;
  canInterrupt: boolean;
  transport:
    "codex-native" | "claude-channel" | "antigravity-acp" | "unavailable";
  reason?: string;
}
export const chatEfforts = ["none","minimal","low","medium","high","xhigh","max","ultra"] as const;
export type ChatEffort = typeof chatEfforts[number];
export const chatPermissions = ["default","read-only","accept-edits","auto-accept"] as const;
export type ChatPermission = typeof chatPermissions[number];
export interface IdeChatUsage {
  usage: import("./terminal-usage").TerminalUsage | null;
  work: import("./host-insights").TerminalWorkSnapshot | null;
}
export interface IdeChatFolders {
  path:string;
  parent:string;
  folders:{name:string;path:string}[];
  truncated:boolean;
}
export interface ChatReservation {
  notBefore?:number;
  needsAuthorization?: boolean;
  id: string;
  text: string;
  error?: string;
}
export interface IdeChatConversation {
  configuredModel?:string;
  canConfigureNative?:boolean;
  permission?: ChatPermission;
  /** Present on chats where Harbor owns the peer tool binding. */
  peerEnabled?: boolean;
  reviewOnly?: boolean;
  effort?: ChatEffort;
  queue?: ChatReservation[];
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
  contentRevision?: number;
  updatedAt: number;
  /** A view of the existing CLI; never a second native conversation process. */
  live?: IdeChatLive;
}
export interface IdeChatCreate {
  permission?: ChatPermission;
  reviewOnly?: boolean;
  effort?: ChatEffort;
  hostId: string;
  provider: IdeChatProvider;
  requestId: string;
  cwd?: string;
  model?: string;
  resumeId?: string;
}
export interface IdeChatSend {
  images?: string[];
  delivery?: "steer" | "next" | "reset";
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
