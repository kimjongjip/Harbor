import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { TerminalInfo } from "../shared/types.js";
import type { HistoryDetail } from "../shared/history.js";
import type {
  IdeConversationCapabilities,
  IdeConversationInput,
  IdeConversationPage,
  IdeConversationReceipt,
} from "../shared/ide-conversation.js";

export class IdeConversationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Canonical terminal snapshots include the current DEC bracketed-paste mode. */
export function ideTerminalReady(snapshot: { data: string }): boolean {
  let enabled = false;
  for (const match of snapshot.data.matchAll(/\x1b\[\?([0-9;]+)([hl])/g))
    if (match[1].split(";").includes("2004")) enabled = match[2] === "h";
  return enabled;
}

export interface IdeConversationOperations {
  runtimeId: string;
  terminal(id: string): TerminalInfo | undefined;
  readHistory(
    hostId: string,
    provider: "codex" | "claude",
    sessionId: string,
    cursor?: string,
  ): Promise<HistoryDetail>;
  codex: {
    available(id: string): boolean;
    currentSession(id: string): string | undefined;
    submitUser(
      id: string,
      input: { requestId: string; sessionId: string; text: string },
      beforeEnqueue?: () => void,
    ): Promise<"queued" | "uncertain">;
  };
  /** Observed native bracketed-paste support, never inferred from a CLI name. */
  terminalReady(id: string): Promise<boolean>;
  write(id: string, data: string): void;
}

const identity = z.string().min(1).max(256);
export const ideConversationInput = z
  .object({
    runtimeId: identity,
    sessionId: identity,
    requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    text: z.string().min(1).max(32000),
    submit: z.literal(true),
    terminalSubmit: z.boolean().optional(),
  })
  .strict();

/** Reads and writes only the native conversation already bound to a terminal. */
export class IdeConversations {
  private pending = new Map<string, Promise<IdeConversationPage>>();
  private receipts = new Map<
    string,
    {
      body: string;
      at: number;
      result?: IdeConversationReceipt;
      operation?: Promise<IdeConversationReceipt>;
    }
  >();

  constructor(private operations: IdeConversationOperations) {}

  private target(id: string, sessionId: string, previous?: TerminalInfo) {
    const terminal = this.operations.terminal(id);
    if (
      !terminal ||
      !["codex", "claude"].includes(terminal.agentKind || "") ||
      (terminal.agentSessionId || terminal.resumeThreadId) !== sessionId ||
      (previous &&
        (terminal.hostId !== previous.hostId ||
          terminal.agentKind !== previous.agentKind))
    )
      throw new IdeConversationError(
        409,
        "IDE_CONVERSATION_CHANGED",
        "대화가 변경됐습니다. 현재 세션을 다시 선택하세요.",
      );
    return { ...terminal };
  }

  private capability(
    terminal: TerminalInfo,
    bracketed: boolean,
  ): IdeConversationCapabilities {
    const busy = terminal.agentState === "working";
    const unavailable = (reason: string): IdeConversationCapabilities => ({
      transport: "unavailable",
      canSend: false,
      busy,
      reason,
    });
    if (
      terminal.exited ||
      terminal.connectionState !== "connected" ||
      !terminal.agentConnected
    )
      return unavailable(
        "터미널에서 Codex 또는 Claude를 실행하고 연결을 기다리세요.",
      );
    if (terminal.agentState === "waiting")
      return unavailable("현재 승인이나 질문에 먼저 응답하세요.");
    if (
      terminal.agentKind === "codex" &&
      this.operations.codex.available(terminal.id) &&
      this.operations.codex.currentSession(terminal.id) ===
        terminal.agentSessionId
    )
      return { transport: "codex-native", canSend: true, busy };
    if (busy)
      return unavailable(
        "현재 답변이 끝난 뒤 전송하세요. 이 CLI는 별도 입력 대기열에 연결되지 않았습니다.",
      );
    if (terminal.agentState !== "idle" || !bracketed)
      return unavailable(
        "AI 입력칸이 준비되지 않았습니다. 터미널에서 현재 화면을 확인하세요.",
      );
    return {
      transport: "terminal",
      canSend: true,
      busy: false,
      reason:
        "같은 CLI 입력칸에 추가한 뒤 Enter를 보냅니다. 터미널에 작성 중인 입력을 먼저 확인하세요.",
    };
  }

  async read(
    id: string,
    sessionId: string,
    cursor?: string,
  ): Promise<IdeConversationPage> {
    const target = this.target(id, sessionId);
    const key = JSON.stringify([
      id,
      target.hostId,
      target.agentKind,
      sessionId,
      cursor,
    ]);
    const existing = this.pending.get(key);
    if (existing) return existing;
    if (this.pending.size >= 8)
      throw new IdeConversationError(
        429,
        "IDE_HISTORY_BUSY",
        "다른 기록을 불러오는 중입니다. 잠시 후 다시 시도하세요.",
      );
    const operation = (async () => {
      const [history, readiness] = await Promise.allSettled([
        this.operations.readHistory(
          target.hostId,
          target.agentKind!,
          sessionId,
          cursor,
        ),
        this.operations.terminalReady(id),
      ]);
      const current = this.target(id, sessionId, target);
      if (
        history.status === "fulfilled" &&
        history.value.thread.id !== sessionId
      )
        throw new IdeConversationError(
          409,
          "IDE_CONVERSATION_CHANGED",
          "조회한 대화가 현재 세션과 다릅니다.",
        );
      return {
        runtimeId: this.operations.runtimeId,
        terminalId: id,
        sessionId,
        provider: current.agentKind!,
        items: history.status === "fulfilled" ? history.value.items : [],
        nextCursor:
          history.status === "fulfilled" ? history.value.nextCursor : null,
        capabilities: this.capability(
          current,
          readiness.status === "fulfilled" && readiness.value,
        ),
        ...(history.status === "rejected"
          ? {
              historyError:
                "저장된 대화 기록을 아직 읽을 수 없습니다. CLI 연결과 기록을 확인하고 다시 불러오세요.",
            }
          : {}),
      };
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return operation;
  }

  async send(
    id: string,
    input: IdeConversationInput,
    authorize: () => void,
    actor = "local",
  ): Promise<IdeConversationReceipt> {
    const parsed = ideConversationInput.parse(input);
    if (parsed.runtimeId !== this.operations.runtimeId)
      throw new IdeConversationError(
        409,
        "IDE_RUNTIME_CHANGED",
        "Harbor가 다시 시작됐습니다. 화면을 다시 연결하세요.",
      );
    const target = this.target(id, parsed.sessionId);
    authorize();
    const text = parsed.text.replace(/\r\n?/g, "\n");
    if (!text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
      throw new IdeConversationError(
        400,
        "IDE_INVALID_TEXT",
        "제어 문자를 제외한 질문을 입력하세요.",
      );
    const key = `${actor}:${parsed.requestId}`,
      body = JSON.stringify([id, parsed]);
    for (const [key, receipt] of this.receipts)
      if (!receipt.operation && Date.now() - receipt.at > 86400000)
        this.receipts.delete(key);
    const prior = this.receipts.get(key);
    if (prior) {
      if (prior.body !== body)
        throw new IdeConversationError(
          409,
          "IDE_DUPLICATE_INPUT",
          "같은 요청 번호에 다른 질문을 보낼 수 없습니다.",
        );
      const result = prior.operation ? await prior.operation : prior.result!;
      return { ...result, duplicate: true };
    }
    if (this.receipts.size >= 10000)
      throw new IdeConversationError(
        429,
        "IDE_INPUT_LIMIT",
        "입력 기록 한도에 도달했습니다. 잠시 후 다시 시도하세요.",
      );
    const receipt: {
      body: string;
      at: number;
      result?: IdeConversationReceipt;
      operation?: Promise<IdeConversationReceipt>;
    } = { body, at: Date.now() };
    this.receipts.set(key, receipt);
    const check = () => {
      const current = this.target(id, parsed.sessionId, target);
      if (
        current.exited ||
        current.connectionState !== "connected" ||
        !current.agentConnected ||
        current.agentState === "waiting"
      )
        throw new IdeConversationError(
          409,
          "IDE_INPUT_UNAVAILABLE",
          "현재 대화의 연결과 승인 요청을 확인하세요.",
        );
      authorize();
    };
    receipt.operation = (async () => {
      const bracketed = await this.operations.terminalReady(id);
      check();
      const capability = this.capability(
        this.target(id, parsed.sessionId, target),
        bracketed,
      );
      if (!capability.canSend)
        throw new IdeConversationError(
          409,
          "IDE_INPUT_UNAVAILABLE",
          capability.reason!,
        );
      if (capability.transport === "codex-native") {
        const status = await this.operations.codex.submitUser(
          id,
          {
            requestId: parsed.requestId,
            sessionId: parsed.sessionId,
            text,
          },
          check,
        );
        return { ok: true as const, requestId: parsed.requestId, status };
      }
      if (parsed.terminalSubmit !== true)
        throw new IdeConversationError(
          409,
          "IDE_TERMINAL_SUBMIT_REQUIRED",
          "이 연결은 같은 CLI 입력칸을 사용합니다. 터미널 입력을 확인한 뒤 전송하세요.",
        );
      check();
      // Reserve the result before PTY writing: a failed acknowledgement must
      // never cause an automatic second Enter or replay into a replacement CLI.
      receipt.result = {
        ok: true,
        requestId: parsed.requestId,
        status: "uncertain",
      };
      try {
        this.operations.write(id, `\x1b[200~${text}\x1b[201~\r`);
      } catch {
        return receipt.result;
      }
      return {
        ok: true as const,
        requestId: parsed.requestId,
        status: "submitted" as const,
      };
    })();
    try {
      const result = await receipt.operation;
      receipt.result = result;
      return result;
    } catch (error) {
      if (!receipt.result) this.receipts.delete(key);
      throw error;
    } finally {
      receipt.operation = undefined;
    }
  }
}

/** Mount behind existing local/paired-desktop authentication. */
export function createIdeConversationRouter(
  service: IdeConversations,
  options: {
    authorize(request: Request, terminalId: string, write: boolean): void;
    actor?(request: Request): string;
  },
) {
  const router = Router();
  const run =
    (write: boolean, action: (id: string, req: Request) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        const id = identity.parse(req.params.terminalId);
        options.authorize(req, id, write);
        const result = await action(id, req);
        if (!write) options.authorize(req, id, false);
        res.json(result);
      } catch (error) {
        if (error instanceof z.ZodError)
          res
            .status(400)
            .json({
              error: "대화 요청 형식을 확인하세요.",
              code: "IDE_INVALID_INPUT",
            });
        else if (error instanceof IdeConversationError)
          res
            .status(error.status)
            .json({ error: error.message, code: error.code });
        else
          res
            .status(409)
            .json({
              error: "현재 대화 연결과 입력 제어권을 확인하세요.",
              code: "IDE_CONVERSATION_UNAVAILABLE",
            });
      }
    };
  router.get(
    "/terminals/:terminalId/conversation",
    run(false, (id, req) => {
      const query = z
        .object({
          sessionId: identity,
          cursor: z.string().max(8192).optional(),
        })
        .strict()
        .parse(req.query);
      return service.read(id, query.sessionId, query.cursor);
    }),
  );
  router.post(
    "/terminals/:terminalId/messages",
    run(true, (id, req) =>
      service.send(
        id,
        ideConversationInput.parse(req.body),
        () => options.authorize(req, id, true),
        options.actor?.(req),
      ),
    ),
  );
  return router;
}
