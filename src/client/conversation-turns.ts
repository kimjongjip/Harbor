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
  const result = current.map((item) => {
    const update = byId.get(key(item));
    return !older && update && !equal(item, update) ? update : item;
  });
  const ordered = [...byId.values()];
  const known = new Set(result.map(key));
  let previous: string | undefined;
  for (let index = 0; index < ordered.length; index++) {
    const item = ordered[index],
      id = key(item);
    if (!known.has(id)) {
      const next = ordered
        .slice(index + 1)
        .find((entry) => known.has(key(entry)));
      const position = next
        ? result.findIndex((entry) => key(entry) === key(next))
        : previous
          ? result.findIndex((entry) => key(entry) === previous) + 1
          : older
            ? 0
            : result.length;
      result.splice(position, 0, item);
      known.add(id);
    }
    previous = id;
  }
  return result;
}
