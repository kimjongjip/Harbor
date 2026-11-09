import type { HistoryDetail } from "../shared/history.js";
import type { ResearchConversation } from "../shared/research.js";

/** Only visible user/assistant text from the chosen native conversation is shared. */
export function researchConversation(
  detail: HistoryDetail,
): ResearchConversation {
  const items = detail.items.filter(
    (item) => ["user", "assistant"].includes(item.kind) && item.text?.trim(),
  );
  const limit = 32000;
  const raw = items
    .map(
      (item) =>
        `[${item.kind === "user" ? "사용자" : "AI"}]\n${item.text.trim()}`,
    )
    .join("\n\n");
  const truncated = raw.length > limit || !!detail.nextCursor;
  return {
    text:
      raw.length > limit
        ? `[앞부분 생략 · 최근 대화]\n${raw.slice(-limit + 30)}`
        : raw,
    sessionId: detail.thread.id,
    hostId: detail.thread.hostId,
    capturedAt: Date.now(),
    truncated,
    items: items.length,
  };
}
