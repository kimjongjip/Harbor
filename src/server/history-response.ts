import type { MessageItem } from "../shared/types.js";

/** Only the latest page already returned to an authenticated local terminal
 * reader can be handed off. No transcript or credentials are written to disk. */
export class TerminalHistorySnapshots {
  private entries = new Map<
    string,
    {
      body: string;
      bytes: number;
      started: number;
      expires: number;
      timer: NodeJS.Timeout;
    }
  >();
  private bytes = 0;
  constructor(
    private ttl = 45000,
    private budget = 8 * 1024 * 1024,
    private perPage = 2 * 1024 * 1024,
  ) {}
  take(key: string) {
    const value = this.entries.get(key);
    if (!value) return;
    clearTimeout(value.timer);
    this.entries.delete(key);
    this.bytes -= value.bytes;
    return Date.now() < value.expires ? value.body : undefined;
  }
  remember(key: string, body: string, started: number) {
    if ((this.entries.get(key)?.started ?? -Infinity) > started) return;
    this.take(key);
    const bytes = Buffer.byteLength(body);
    if (bytes > this.perPage || bytes > this.budget) return;
    while (this.entries.size >= 16 || this.bytes + bytes > this.budget)
      this.take(this.entries.keys().next().value!);
    const timer = setTimeout(() => this.take(key), this.ttl);
    timer.unref();
    this.entries.set(key, {
      body,
      bytes,
      started,
      expires: Date.now() + this.ttl,
      timer,
    });
    this.bytes += bytes;
  }
}

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
