import type { MessageItem } from "../shared/types.js";

interface TimelinePayload {
  items: MessageItem[];
  timeline?: MessageItem[];
}
interface CompactTimeline {
  activity?: MessageItem[];
  timelineIds?: string[];
}

/** Keep large Q/A strings once on the wire; native/internal readers keep timeline. */
export function serializeHistoryDetailForRead<T extends TimelinePayload>(
  detail: T,
): Omit<T, "timeline"> & CompactTimeline {
  const { timeline, ...rest } = detail;
  if (!timeline) return rest;
  const key = (item: MessageItem) => `${item.kind}:${item.id}`;
  const present = new Set(detail.items.map(key));
  return {
    ...rest,
    activity: timeline.filter(item => !present.has(key(item))),
    timelineIds: timeline.map(key),
  };
}
