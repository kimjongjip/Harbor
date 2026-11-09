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
  /** Opt-in chronological messages plus exact saved work previews and lazy full-text references. */
  timeline?: MessageItem[];
  /** Compact wire timeline. Keys are `${kind}:${id}` across items + activity. */
  activity?: MessageItem[];
  timelineIds?: string[];
  nextCursor: string | null;
  /** A bounded read omitted an oversized record; other messages remain usable. */
  notice?: string;
}
export interface HistoryReadOptions {
  includeActivity?: boolean;
}
export interface HistoryActivityPage {
  text: string;
  offset: number;
  nextOffset: number | null;
  total: number;
}
