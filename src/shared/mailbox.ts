/** Only consumed records an actual recipient MCP read; other states are UI actions. */
export type MailboxStatus = "queued" | "read" | "drafted" | "consumed";

/** A snapshot keeps message history understandable after a terminal is closed. */
export interface MailboxParticipant {
  kind: "user" | "terminal";
  title: string;
  terminalId?: string;
  hostId?: string;
  hostName?: string;
  cwd?: string;
}

export interface MailboxMessage {
  id: string;
  threadId: string;
  replyToId?: string;
  sender: MailboxParticipant;
  recipient: MailboxParticipant;
  /** Agent authorship is used only for a scoped, authenticated tool call. */
  author: "user" | "agent";
  text: string;
  createdAt: number;
  status: MailboxStatus;
  readAt?: number;
  draftedAt?: number;
  /** Set only when the recipient actually fetches this message through MCP. */
  consumedAt?: number;
  /** An authenticated/UI reply was recorded; this does not imply task completion. */
  repliedAt?: number;
  replyMessageId?: string;
}

export interface MailboxSendInput {
  fromTerminalId?: string;
  toTerminalId: string;
  text: string;
  replyToId?: string;
}

export const MAILBOX_TEXT_LIMIT = 16_000;
