import { createHash } from "node:crypto";
import type { HistoryDetail } from "../shared/history.js";
import type { IdeChatLive, IdeChatProvider } from "../shared/ide-chat.js";
import type { SessionStatus, TerminalInfo } from "../shared/types.js";

export interface IdeLiveBinding {
  terminalId: string;
  hostId: string;
  provider: IdeChatProvider;
  nativeId: string;
  origin?: IdeChatLive["origin"];
}
type Guard = () => void | Promise<void>;
export interface IdeLiveOperations {
  terminals(): TerminalInfo[];
  terminal(id: string): TerminalInfo | undefined;
  readHistory(
    hostId: string,
    provider: IdeChatProvider,
    nativeId: string,
    cursor?: string,
  ): Promise<HistoryDetail>;
  codex: {
    available(id: string): boolean;
    currentSession(id: string): string | undefined;
    submitUser(
      id: string,
      input: { requestId: string; sessionId: string; text: string },
      beforeEnqueue?: Guard,
    ): Promise<"queued" | "uncertain">;
  };
  claude: {
    available(
      id: string,
      nativeId: string,
      provider: "claude" | "antigravity",
    ): boolean;
    send(
      id: string,
      input: { requestId: string; sessionId: string; text: string },
      beforeDispatch: () => Promise<void>,
      provider: "claude" | "antigravity",
    ): Promise<"queued" | "uncertain">;
  };
  now?(): number;
  /** Connection settings scope prevents same host ID reusing another account's cache. */
  cacheScope?(hostId: string): string;
}

function providerOf(terminal: TerminalInfo): IdeChatProvider | undefined {
  if (terminal.agentKind) return terminal.agentKind;
  if (terminal.program === "claude" || terminal.program === "claude-resume")
    return "claude";
  if (terminal.program === "codex" || terminal.program === "resume")
    return "codex";
  if (terminal.program === "antigravity") return "antigravity";
}
function nativeOf(terminal: TerminalInfo) {
  // Once the CLI reports its identity, a stale launch-time resume ID must not
  // bind an IDE writer to a different conversation now open in that terminal.
  return terminal.agentSessionId || terminal.resumeThreadId;
}
function rejected(message: string, status = 409) {
  return Object.assign(new Error(message), { status, definiteRejection: true });
}
export function ideLiveRequestId(
  { terminalId, hostId, provider, nativeId }: IdeLiveBinding,
  requestId: string,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([{ terminalId, hostId, provider, nativeId }, requestId]),
    )
    .digest("hex");
}

/** Read native saved blocks and submit through the already-running CLI only. */
export class IdeLiveChats {
  private reading = 0;
  private cache = new Map<
    string,
    {
      at: number;
      value?: HistoryDetail;
      error?: unknown;
      pending?: Promise<HistoryDetail>;
    }
  >();
  constructor(private operations: IdeLiveOperations) {}
  find(
    hostId: string,
    provider: IdeChatProvider,
    nativeId: string,
    terminalId?: string,
  ): IdeLiveBinding | undefined {
    const matches = this.operations
      .terminals()
      .filter(
        (t) =>
          !t.exited &&
          (!terminalId || t.id === terminalId) &&
          t.hostId === hostId &&
          providerOf(t) === provider &&
          nativeOf(t) === nativeId,
      );
    // A reconnecting terminal may still reserve its launch-time resume ID.
    // Prefer the terminal that is actually running that native conversation.
    const terminal =
      matches.find(
        (t) =>
          t.agentSessionId === nativeId &&
          t.agentConnected &&
          t.connectionState === "connected",
      ) ??
      matches.find((t) => t.agentSessionId === nativeId) ??
      matches[0];
    return terminal
      ? {
          terminalId: terminal.id,
          hostId,
          provider,
          nativeId,
          origin: terminal.managedChatAdapter ? "managed" : "terminal",
        }
      : undefined;
  }
  get(binding: IdeLiveBinding): {
    terminal?: TerminalInfo;
    live: IdeChatLive;
    status: SessionStatus;
  } {
    const terminal = this.operations.terminal(binding.terminalId);
    const origin = binding.origin ?? "terminal";
    const managed = origin === "managed";
    const destination = { terminalId: binding.terminalId, origin };
    const unavailable = (
      reason: string,
      status: SessionStatus = "offline",
      confirmed?: TerminalInfo,
    ) => ({
      terminal: confirmed,
      status,
      live: {
        ...destination,
        ...(confirmed && !managed && { terminalTitle: confirmed.title }),
        canSend: false,
        canInterrupt: false,
        transport: "unavailable" as const,
        reason,
      },
    });
    if (
      !terminal ||
      terminal.hostId !== binding.hostId ||
      providerOf(terminal) !== binding.provider ||
      nativeOf(terminal) !== binding.nativeId
    )
      return unavailable(
        managed
          ? "Antigravity 실행 연결이 끝났습니다. 저장된 대화는 계속 볼 수 있습니다."
          : "이 터미널의 대화가 바뀌었습니다. 저장된 대화는 계속 볼 수 있습니다.",
      );
    if (
      terminal.exited ||
      terminal.connectionState !== "connected" ||
      !terminal.agentConnected ||
      terminal.agentSessionId !== binding.nativeId ||
      terminal.agentKind !== binding.provider
    )
      return unavailable(
        managed
          ? "Antigravity 실행 연결을 기다리고 있습니다."
          : "터미널 연결을 기다리고 있습니다. 저장된 대화는 계속 볼 수 있습니다.",
      );
    const status =
      terminal.agentState === "working"
        ? "running"
        : terminal.agentState === "waiting"
          ? "waiting"
          : "idle";
    const terminalTitle = origin === "terminal" ? terminal.title : undefined;
    if (status === "waiting")
      return unavailable(
        managed
          ? "Antigravity가 승인 또는 답변을 기다리고 있습니다."
          : "승인이나 질문에 대한 응답은 연결된 터미널에서 진행해 주세요.",
        status,
        terminal,
      );
    const codex =
      binding.provider === "codex" &&
      this.operations.codex.available(terminal.id) &&
      this.operations.codex.currentSession(terminal.id) === binding.nativeId;
    const claude =
      binding.provider !== "codex" &&
      this.operations.claude.available(
        terminal.id,
        binding.nativeId,
        binding.provider,
      );
    if (!codex && !claude)
      return unavailable(
        binding.provider === "antigravity"
          ? managed
            ? "Antigravity 입력 연결을 준비하고 있습니다."
            : "Antigravity 입력 연결을 준비하고 있습니다. 같은 터미널에서 연결 상태를 확인하세요."
          : binding.provider === "claude"
            ? "이 Claude 세션은 IDE 입력 채널이 연결되지 않았습니다. 답변은 여기서 보고, 입력은 연결된 터미널에서 계속할 수 있습니다."
            : "이 Codex 세션은 IDE 입력 채널이 연결되지 않았습니다. 답변은 여기서 보고, 입력은 연결된 터미널에서 계속할 수 있습니다.",
        status,
        terminal,
      );
    return {
      terminal,
      status,
      live: {
        ...destination,
        ...(terminalTitle && { terminalTitle }),
        canSend: true,
        canInterrupt: false,
        transport: codex
          ? "codex-native"
          : binding.provider === "antigravity"
            ? "antigravity-acp"
            : "claude-channel",
      },
    };
  }
  async read(binding: IdeLiveBinding, cursor?: string): Promise<HistoryDetail> {
    const key = JSON.stringify([
      this.operations.cacheScope?.(binding.hostId) || "",
      binding.hostId,
      binding.provider,
      binding.nativeId,
      cursor || "",
    ]);
    const now = this.operations.now?.() ?? Date.now();
    const existing = this.cache.get(key);
    if (existing?.pending) return existing.pending;
    const refreshMs =
      !cursor &&
      binding.provider === "antigravity" &&
      this.get(binding).status === "running"
        ? 600
        : 2000;
    if (existing && now - existing.at < refreshMs) {
      if (existing.error) throw existing.error;
      if (existing.value) return structuredClone(existing.value);
    }
    if (this.reading >= 8)
      throw rejected(
        "다른 대화 기록을 불러오는 중입니다. 잠시 후 다시 시도해 주세요.",
        429,
      );
    if (this.cache.size >= 32) {
      const evict = [...this.cache].find(([, value]) => !value.pending)?.[0];
      if (evict) this.cache.delete(evict);
      else
        throw rejected(
          "대화 기록을 불러오는 중입니다. 잠시 후 다시 시도해 주세요.",
          429,
        );
    }
    const entry = { at: now } as NonNullable<typeof existing>;
    this.reading++;
    const operation = Promise.resolve()
      .then(() =>
        this.operations.readHistory(
          binding.hostId,
          binding.provider,
          binding.nativeId,
          cursor,
        ),
      )
      .then((page) => {
        if (
          page.thread.id !== binding.nativeId ||
          page.thread.hostId !== binding.hostId ||
          (page.thread.provider && page.thread.provider !== binding.provider)
        )
          throw rejected("대화 기록의 서버·ID가 요청과 다릅니다.");
        entry.value = structuredClone(page);
        return page;
      })
      .catch((error) => {
        entry.error = error;
        throw error;
      })
      .finally(() => {
        this.reading--;
        entry.pending = undefined;
        entry.at = this.operations.now?.() ?? Date.now();
      });
    entry.pending = operation;
    this.cache.set(key, entry);
    return operation;
  }
  async send(
    binding: IdeLiveBinding,
    input: { requestId: string; text: string },
    beforeDispatch: Guard,
  ): Promise<"queued" | "uncertain"> {
    const check = () => {
      const current = this.get(binding);
      if (!current.live.canSend)
        throw rejected(
          current.live.reason || "현재 대화에 입력할 수 없습니다.",
        );
      return current;
    };
    check();
    const limit = binding.provider === "codex" ? 32000 : 15300;
    if (input.text.length > limit)
      throw rejected(
        `이 세션의 메시지는 ${limit.toLocaleString("en-US")}자까지 전송할 수 있습니다.`,
        400,
      );
    // Scope native queue IDs to this live binding and the actor-scoped receipt.
    const requestId = ideLiveRequestId(binding, input.requestId);
    const guard = async () => {
      await beforeDispatch();
      check();
    };
    const submission = {
      requestId,
      sessionId: binding.nativeId,
      text: input.text,
    };
    return binding.provider === "codex"
      ? this.operations.codex.submitUser(binding.terminalId, submission, guard)
      : this.operations.claude.send(
          binding.terminalId,
          submission,
          guard,
          binding.provider,
        );
  }
}
