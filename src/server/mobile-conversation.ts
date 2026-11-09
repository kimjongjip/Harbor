import type { TerminalInfo } from "../shared/types.js";
import type { HistoryDetail, HistoryReadOptions } from "../shared/history.js";
import type { MobileConversationPage } from "../shared/mobile.js";
import { serializeHistoryDetailForRead } from "./history-response.js";

/** Only the conversation already bound to a listed terminal is readable. */
export class MobileConversations {
  private pending = new Map<string, Promise<MobileConversationPage>>();
  constructor(
    private terminal: (id: string) => TerminalInfo | undefined,
    private readHistory: (
      hostId: string,
      provider: "codex" | "claude",
      sessionId: string,
      cursor?: string,
      options?: HistoryReadOptions,
    ) => Promise<HistoryDetail>,
  ) {}
  async read(
    id: string,
    sessionId: string,
    cursor?: string,
    options: HistoryReadOptions = {},
  ): Promise<MobileConversationPage> {
    const target = this.terminal(id);
    const provider = target?.agentKind;
    if (
      !target ||
      (provider !== "codex" && provider !== "claude") ||
      (target.agentSessionId || target.resumeThreadId) !== sessionId
    )
      throw new Error("대화가 변경됐습니다. 현재 세션을 다시 선택하세요.");
    const hostId = target.hostId;
    const key = JSON.stringify([id, hostId, provider, sessionId, cursor, !!options.includeActivity]);
    const existing = this.pending.get(key);
    if (existing) return existing;
    if (this.pending.size >= 8)
      throw new Error(
        "다른 대화 기록을 불러오는 중입니다. 잠시 후 다시 시도하세요.",
      );
    const request = this.readHistory(hostId, provider, sessionId, cursor, options)
      .then((detail) => {
        const current = this.terminal(id);
        if (
          !current ||
          current.hostId !== hostId ||
          current.agentKind !== provider ||
          (current.agentSessionId || current.resumeThreadId) !== sessionId ||
          detail.thread.id !== sessionId || detail.thread.hostId !== hostId
        )
          throw new Error(
            "조회 중 대화가 변경됐습니다. 현재 세션을 다시 선택하세요.",
          );
        return serializeHistoryDetailForRead({
          sessionId,
          provider,
          items: detail.items
            .filter((item) => item.kind === "user" || item.kind === "assistant")
            .map(({ id, turnId, kind, text, imageCount, phase, turnStatus }) => ({
              id,
              turnId,
              kind,
              text,
              imageCount,
              phase,
              turnStatus,
            })),
          ...(options.includeActivity && detail.timeline ? { timeline: detail.timeline } : {}),
          nextCursor: detail.nextCursor,
          ...(detail.notice ? { notice: detail.notice } : {}),
        });
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }
}
