import type { MessageItem } from "../shared/types";
import type { HistoryDetail } from "../shared/history";

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

export interface ConversationTurn {
  id: string;
  items: MessageItem[];
  complete: boolean;
  finalIds: Set<string>;
}

/** Native turn IDs are authoritative. Legacy messages only group at user boundaries. */
export function conversationTurns(
  items: MessageItem[],
  completedItemId?: string | ReadonlyMap<string, string>,
): ConversationTurn[] {
  const result: ConversationTurn[] = [];
  let current: ConversationTurn | undefined;
  for (const item of items) {
    if (
      !current ||
      (item.turnId && item.turnId !== current.id) ||
      (!item.turnId && item.kind === "user")
    ) {
      current = {
        id: item.turnId || item.id,
        items: [],
        complete: false,
        finalIds: new Set(),
      };
      result.push(current);
    }
    current.items.push(item);
    if (
      item.kind === "assistant" &&
      ((item.phase === "final_answer" && item.turnStatus === "completed") ||
        (item.turnStatus !== "inProgress" &&
          item.turnStatus !== "failed" &&
          item.turnStatus !== "interrupted" &&
          (typeof completedItemId === "string"
            ? item.id === completedItemId
            : completedItemId?.get(item.id) === item.text)))
    ) {
      current.complete = true;
      current.finalIds.add(item.id);
    } else if (
      ["assistant", "command", "tool", "change", "plan"].includes(item.kind) ||
      ["inProgress", "failed", "interrupted"].includes(item.turnStatus || "")
    ) {
      current.complete = false;
      current.finalIds.clear();
    }
  }
  return result;
}

/** Older pages cannot replace a newer answer or move it earlier in the transcript. */
export function mergeTimeline(
  current: MessageItem[],
  incoming: MessageItem[],
  older: boolean,
) {
  const key = (item: MessageItem) => `${item.kind}:${item.id}`;
  const byId = new Map(incoming.map((item) => [key(item), item]));
  if (older) {
    const present = new Set(current.map(key));
    return [...byId.values()]
      .filter((item) => !present.has(key(item)))
      .concat(current);
  }
  const equal = (a: MessageItem, b: MessageItem) =>
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every(
      (name) => a[name as keyof MessageItem] === b[name as keyof MessageItem],
    );
  if (!current.length) return [...byId.values()];
  const known = new Set(current.map(key));
  const before = new Map<string, MessageItem[]>();
  let additions: MessageItem[] = [];
  let lastAnchor: string | undefined;
  for (const [id, item] of byId) {
    if (!known.has(id)) {
      additions.push(item);
      continue;
    }
    if (additions.length) before.set(id, additions);
    additions = [];
    lastAnchor = id;
  }
  const result: MessageItem[] = [];
  let changed = before.size > 0 || additions.length > 0;
  for (const item of current) {
    const id = key(item);
    const group = before.get(id);
    if (group) for (const entry of group) result.push(entry);
    const update = byId.get(id);
    if (update && !equal(item, update)) {
      result.push(update);
      changed = true;
    } else result.push(item);
    if (id === lastAnchor) for (const entry of additions) result.push(entry);
  }
  if (!lastAnchor) for (const entry of additions) result.push(entry);
  return changed ? result : current;
}
