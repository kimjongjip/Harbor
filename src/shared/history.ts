import type { MessageItem } from "./types.js";
export interface HistoryThread {
  provider?: import("./agent-provider.js").AgentProvider;
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

/** Older servers send a full timeline; compact responses carry each Q/A only once. */
export function expandTimeline(
  detail: Pick<
    HistoryDetail,
    "items" | "timeline" | "timelineIds" | "activity"
  >,
): MessageItem[] {
  if (detail.timeline) return detail.timeline;
  if (!detail.timelineIds) return detail.items;
  const byId = new Map(
    [...detail.items, ...(detail.activity || [])].map((item) => [
      `${item.kind}:${item.id}`,
      item,
    ]),
  );
  const seen = new Set<string>();
  const result: MessageItem[] = [];
  for (const id of detail.timelineIds) {
    const item = byId.get(id);
    if (item && !seen.has(id)) {
      result.push(item);
      seen.add(id);
    }
  }
  // Keep Q/A readable even if an older/proxy response lacks an order entry.
  for (const item of detail.items) {
    const id = `${item.kind}:${item.id}`;
    if (!seen.has(id)) {
      result.push(item);
      seen.add(id);
    }
  }
  return result;
}
