import type { MailboxParticipant } from "./mailbox.js";

/** Harbor questions are distinct from native Codex command approvals. */
export interface HarborRequest {
  id: string;
  kind: "question" | "permission";
  permission?: {
    toolName: string;
    command?: string;
    cwd?: string;
    detail?: string;
  };
  terminal: MailboxParticipant;
  title: string;
  question: string;
  options: { id: string; label: string }[];
  status: "pending" | "answered" | "consumed" | "cancelled";
  createdAt: number;
  answer?: HarborAnswer;
  answeredAt?: number;
  /** The requesting MCP call actually retrieved this answer. */
  consumedAt?: number;
  cancelledAt?: number;
  cancellationReason?: string;
}

export interface HarborAnswer {
  text: string;
  optionId?: string;
}

export interface HarborQuestionInput {
  title: string;
  question: string;
  options?: { id: string; label: string }[];
}

export interface HarborConnection {
  terminalId: string;
  state: "closed" | "unavailable" | "shell" | "connected";
  /** A native MCP initialization, not an inference from terminal output. */
  connectedAt?: number;
  lastSeenAt?: number;
  pendingMessages: number;
  /** Outgoing root messages without a recorded reply, not task completion. */
  unansweredMessages: number;
  pendingQuestions: number;
}
export type TerminalConnection = HarborConnection;

export const REQUEST_QUESTION_LIMIT = 8000;
export const REQUEST_ANSWER_LIMIT = 16000;
