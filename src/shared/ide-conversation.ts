import type { MessageItem } from "./types.js";

export interface IdeConversationCapabilities {
  transport: "codex-native" | "terminal" | "unavailable";
  canSend: boolean;
  busy: boolean;
  reason?: string;
}

export interface IdeConversationPage {
  runtimeId: string;
  terminalId: string;
  sessionId: string;
  provider: "codex" | "claude";
  items: MessageItem[];
  nextCursor: string | null;
  capabilities: IdeConversationCapabilities;
  historyError?: string;
}

export interface IdeConversationInput {
  runtimeId: string;
  sessionId: string;
  requestId: string;
  text: string;
  submit: true;
  /** Explicitly append and submit in the same native terminal editor. */
  terminalSubmit?: boolean;
}

export interface IdeConversationReceipt {
  ok: true;
  requestId: string;
  status: "queued" | "submitted" | "uncertain";
  duplicate?: boolean;
}
