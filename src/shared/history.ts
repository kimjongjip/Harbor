import type { MessageItem } from "./types.js";
export interface HistoryThread {
  provider?: "codex" | "claude";
  id: string;
  hostId: string;
  title: string;
  cwd: string;
  preview: string;
  updatedAt: number;
  source: string;
  active: boolean;
}
export interface HistoryPage {
  data: HistoryThread[];
  nextCursor: string | null;
}
export interface HistoryDetail {
  thread: HistoryThread;
  items: MessageItem[];
  nextCursor: string | null;
  /** A bounded read omitted an oversized record; other messages remain usable. */
  notice?: string;
}
