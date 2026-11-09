import type { MessageItem } from "../shared/types";
import { typedPrompt } from "./user-origin";

export interface HistoryTurn {
  id: string;
  items: MessageItem[];
}

export function prependOlderHistory(
  current: MessageItem[],
  older: MessageItem[],
): MessageItem[] {
  const key = (item: MessageItem) => `${item.kind}:${item.id}`;
  const known = new Set(current.map(key));
  const uniqueOlder = older.filter((item) => {
    if (known.has(key(item))) return false;
    known.add(key(item));
    return true;
  });
  return [...uniqueOlder, ...current];
}

/** Stored pages are chronological; reverse turns, never their question/answer order. */
export function newestHistoryTurns(items: MessageItem[]): HistoryTurn[] {
  const turns: MessageItem[][] = [];
  for (const item of items) {
    const current = turns.at(-1);
    const currentTurnId = current?.find((entry) => entry.turnId)?.turnId;
    const sameTurn = !!item.turnId && item.turnId === currentTurnId;
    if (
      !current ||
      (item.turnId && currentTurnId && !sameTurn) ||
      (item.kind === "user" && !sameTurn)
    ) {
      turns.push([item]);
    } else {
      current.push(item);
    }
  }
  return turns.reverse().map((turn) => ({
    // Older pages can supply the missing question for a partial first turn.
    // The last message remains the same, so its rendered group keeps its identity.
    id: `${turn.at(-1)!.kind}:${turn.at(-1)!.id}`,
    items: turn,
  }));
}

export function recentHistoryQuestion(items: MessageItem[]): string {
  return [...items].reverse().find(typedPrompt)?.text || "";
}

export function historySnippet(text: string, limit = 180): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > limit
    ? `${compact.slice(0, limit).trimEnd()}…`
    : compact;
}
