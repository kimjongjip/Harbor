export interface RichTerminalBlock {
  id: string;
  requestId: string;
  sessionId: string;
  text: string;
  columns: number;
  viewportRows: number;
  cwd?: string;
  createdAt: number;
  state: "pending" | "ready" | "unavailable";
  marker: string;
  rows?: number;
  renderer?: "rows-v2";
  /** Codex exposes final messages, but no verified native render reservation hook. */
  placement?: "card";
}
export type RichTerminalEvent =
  | { type: "terminal-rich"; id: string; block: RichTerminalBlock }
  | { type: "terminal-rich-reset"; id: string; sessionId?: string };
export type RichTerminalReply =
  | { enabled: false }
  | {
      enabled: true;
      id: string;
      marker: string;
      rows: number;
      columns: number;
    };
