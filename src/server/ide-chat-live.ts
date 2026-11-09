import { createHash } from "node:crypto";
import type { HistoryDetail } from "../shared/history.js";
import type { IdeChatLive, IdeChatProvider } from "../shared/ide-chat.js";
import type { SessionStatus, TerminalInfo } from "../shared/types.js";

export interface IdeLiveBinding {
  terminalId: string;
  hostId: string;
  provider: IdeChatProvider;
  nativeId: string;
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
    available(id: string, nativeId: string): boolean;
    send(
      id: string,
      input: { requestId: string; sessionId: string; text: string },
      beforeDispatch: () => Promise<void>,
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
}
function nativeOf(terminal: TerminalInfo) {
  // Once the CLI reports its identity, a stale launch-time resume ID must not
  // bind an IDE writer to a different conversation now open in that terminal.
  return terminal.agentSessionId || terminal.resumeThreadId;
}
function rejected(message: string, status = 409) {
  return Object.assign(new Error(message), { status, definiteRejection: true });
}
export function ideLiveRequestId(binding: IdeLiveBinding, requestId: string) {
  return createHash("sha256")
    .update(JSON.stringify([binding, requestId]))
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
  ): IdeLiveBinding | undefined {
    const terminal = this.operations
      .terminals()
      .find(
        (terminal) =>
          !terminal.exited &&
          terminal.hostId === hostId &&
          providerOf(terminal) === provider &&
          nativeOf(terminal) === nativeId,
      );
    return terminal
      ? { terminalId: terminal.id, hostId, provider, nativeId }
      : undefined;
  }
  get(binding: IdeLiveBinding): {
    terminal?: TerminalInfo;
    live: IdeChatLive;
    status: SessionStatus;
  } {
    const terminal = this.operations.terminal(binding.terminalId);
    const unavailable = (
      reason: string,
      status: SessionStatus = "offline",
    ) => ({
      terminal,
      status,
      live: {
        terminalId: binding.terminalId,
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
        "이 터미널의 대화가 바뀌었습니다. 저장된 대화는 계속 볼 수 있습니다.",
      );
    if (
      terminal.exited ||
      terminal.connectionState !== "connected" ||
      !terminal.agentConnected
    )
      return unavailable(
        "터미널 연결을 기다리고 있습니다. 저장된 대화는 계속 볼 수 있습니다.",
      );
    const status =
      terminal.agentState === "working"
        ? "running"
        : terminal.agentState === "waiting"
          ? "waiting"
          : "idle";
    if (status === "waiting")
      return unavailable(
        "승인이나 질문에 대한 응답은 연결된 터미널에서 진행해 주세요.",
        status,
      );
    const codex =
      binding.provider === "codex" &&
      this.operations.codex.available(terminal.id) &&
      this.operations.codex.currentSession(terminal.id) === binding.nativeId;
    const claude =
      binding.provider === "claude" &&
      this.operations.claude.available(terminal.id, binding.nativeId);
    if (!codex && !claude)
      return unavailable(
        binding.provider === "claude"
          ? "이 Claude 세션은 IDE 입력 채널이 연결되지 않았습니다. 답변은 여기서 보고, 입력은 연결된 터미널에서 계속할 수 있습니다."
          : "이 Codex 세션은 IDE 입력 채널이 연결되지 않았습니다. 답변은 여기서 보고, 입력은 연결된 터미널에서 계속할 수 있습니다.",
        status,
      );
    return {
      terminal,
      status,
      live: {
        terminalId: terminal.id,
        canSend: true,
        canInterrupt: false,
        transport: codex ? "codex-native" : "claude-channel",
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
    if (existing && now - existing.at < 2000) {
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
      : this.operations.claude.send(binding.terminalId, submission, guard);
  }
}
