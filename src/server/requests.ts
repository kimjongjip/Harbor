import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { HostConfig, TerminalInfo } from "../shared/types.js";
import {
  REQUEST_ANSWER_LIMIT,
  REQUEST_QUESTION_LIMIT,
  type HarborAnswer,
  type HarborQuestionInput,
  type HarborRequest,
} from "../shared/requests.js";

const MAX_REQUESTS = 200;
const MAX_TEXT = 1024 * 1024;
const id = z.string().trim().min(1).max(256);
const optionsSchema = z
  .array(
    z
      .object({ id: id.max(80), label: z.string().trim().min(1).max(300) })
      .strict(),
  )
  .max(6);
export const permissionEventSchema = z.object({
  hook_event_name: z.literal("PermissionRequest"),
  session_id: id,
  turn_id: id.optional(),
  cwd: z.string().max(4096).optional(),
  tool_name: z.string().min(1).max(200),
  tool_input: z.unknown(),
});
export const questionSchema = z
  .object({
    title: z.string().trim().min(1).max(180),
    question: z.string().trim().min(1).max(REQUEST_QUESTION_LIMIT),
    options: optionsSchema.optional(),
  })
  .strict();
export const answerSchema = z
  .object({
    text: z.string().trim().max(REQUEST_ANSWER_LIMIT).default(""),
    optionId: id.max(80).optional(),
  })
  .strict();
const recordSchema = questionSchema.extend({
  id,
  kind: z.enum(["question", "permission"]),
  permission: z
    .object({
      toolName: z.string().min(1).max(200),
      command: z.string().max(16000).optional(),
      cwd: z.string().max(4096).optional(),
      detail: z.string().max(8000).optional(),
    })
    .optional(),
  terminal: z.object({
    kind: z.literal("terminal"),
    terminalId: id,
    title: z.string().max(200),
    hostId: id,
    hostName: z.string().max(200),
    cwd: z.string().max(4096),
  }),
  options: optionsSchema,
  status: z.enum(["pending", "answered", "consumed", "cancelled"]),
  createdAt: z.number().finite().nonnegative(),
  answer: answerSchema.optional(),
  answeredAt: z.number().finite().nonnegative().optional(),
  consumedAt: z.number().finite().nonnegative().optional(),
  cancelledAt: z.number().finite().nonnegative().optional(),
  cancellationReason: z.string().max(300).optional(),
});
interface Resolver {
  terminal(id: string): TerminalInfo | undefined;
  host(id: string): Pick<HostConfig, "id" | "name"> | undefined;
}

/** Durable questions with scoped answers. No PTY input or shell execution. */
export class Requests extends EventEmitter {
  readonly file: string;
  private requests: HarborRequest[] = [];
  private waiting = new Set<string>();
  constructor(
    directory: string,
    private readonly resolve: Resolver,
  ) {
    super();
    this.setMaxListeners(64);
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, "requests.json");
    try {
      if (statSync(this.file).size > 8 * 1024 * 1024)
        throw new Error("질문 기록 파일이 너무 큽니다.");
      this.requests = z
        .object({
          version: z.literal(1),
          requests: z.array(recordSchema).max(MAX_REQUESTS),
        })
        .parse(JSON.parse(readFileSync(this.file, "utf8"))).requests;
      if (this.textSize(this.requests) > MAX_TEXT)
        throw new Error("질문 기록 파일이 너무 큽니다.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Per-terminal credentials do not survive backend restart.
    this.cancelWhere(
      () => true,
      "앱이 다시 시작되어 이전 질문 연결이 종료되었습니다.",
    );
  }
  list(): HarborRequest[] {
    return structuredClone(this.requests).reverse();
  }
  create(terminalId: string, input: HarborQuestionInput): HarborRequest {
    const parsed = questionSchema.parse(input);
    return this.createRecord(terminalId, parsed);
  }
  /** Called only by the dedicated native-hook capability, never a generic MCP tool. */
  createPermission(terminalId: string, event: unknown): HarborRequest {
    const parsed = permissionEventSchema.parse(event);
    const input =
      parsed.tool_input && typeof parsed.tool_input === "object"
        ? (parsed.tool_input as Record<string, unknown>)
        : {};
    const command =
      typeof input.command === "string"
        ? z.string().max(16000).parse(input.command)
        : undefined;
    const description =
      typeof input.description === "string"
        ? z.string().max(8000).parse(input.description)
        : undefined;
    const detail = command
      ? description
      : z
          .string()
          .max(8000)
          .parse(JSON.stringify(parsed.tool_input) || "");
    return this.createRecord(
      terminalId,
      {
        title: `${parsed.tool_name.slice(0, 150)} 실행 승인`,
        question:
          description || "에이전트가 다음 작업의 실행 승인을 요청했습니다.",
        options: [
          { id: "allow", label: "이번만 허용" },
          { id: "deny", label: "거절" },
        ],
      },
      {
        toolName: parsed.tool_name,
        ...(command ? { command } : {}),
        ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
        ...(detail ? { detail } : {}),
      },
    );
  }
  private createRecord(
    terminalId: string,
    parsed: HarborQuestionInput,
    permission?: HarborRequest["permission"],
  ): HarborRequest {
    const options = parsed.options || [];
    if (new Set(options.map((option) => option.id)).size !== options.length)
      throw new Error("선택지 ID가 중복되었습니다.");
    const terminal = this.resolve.terminal(terminalId);
    const host = terminal && this.resolve.host(terminal.hostId);
    if (!terminal || terminal.exited || !host)
      throw new Error("질문을 보낸 세션이 종료되었습니다.");
    if (
      this.requests.filter(
        (request) =>
          request.terminal.terminalId === terminalId &&
          request.status === "pending",
      ).length >= 3
    )
      throw new Error("먼저 보낸 질문의 답변을 기다리세요.");
    const request: HarborRequest = {
      id: randomUUID(),
      kind: permission ? "permission" : "question",
      ...(permission ? { permission } : {}),
      title: parsed.title,
      question: parsed.question,
      options,
      terminal: {
        kind: "terminal",
        terminalId,
        title: terminal.title,
        hostId: host.id,
        hostName: host.name,
        cwd: terminal.cwd,
      },
      status: "pending",
      createdAt: Date.now(),
    };
    this.commit(this.bounded([...this.requests, request]));
    return structuredClone(request);
  }
  respond(requestId: string, input: HarborAnswer): HarborRequest {
    const request = this.find(requestId);
    if (request.status !== "pending")
      throw new Error("이미 답변했거나 종료된 질문입니다.");
    const terminal = this.resolve.terminal(request.terminal.terminalId!);
    if (!terminal || terminal.exited)
      throw new Error("질문을 보낸 세션이 종료되었습니다.");
    const answer = answerSchema.parse(input);
    const option = answer.optionId
      ? request.options.find((option) => option.id === answer.optionId)
      : undefined;
    if (answer.optionId && !option)
      throw new Error("유효한 선택지를 골라주세요.");
    if (request.kind === "permission") {
      if (!option || !["allow", "deny"].includes(option.id))
        throw new Error("실행 승인에는 허용 또는 거절을 직접 선택해야 합니다.");
      answer.text = option.label;
    }
    answer.text ||= option?.label || "";
    if (!answer.text) throw new Error("답변을 입력하거나 선택지를 골라주세요.");
    return this.update({
      ...request,
      answer,
      status: "answered",
      answeredAt: Date.now(),
    });
  }
  result(terminalId: string, requestId: string, consume = true): HarborRequest {
    const request = this.find(requestId);
    if (request.terminal.terminalId !== terminalId)
      throw new Error("이 세션에서 보낸 질문만 확인할 수 있습니다.");
    return consume && request.status === "answered"
      ? this.update({ ...request, status: "consumed", consumedAt: Date.now() })
      : structuredClone(request);
  }
  async wait(
    terminalId: string,
    requestId: string,
    waitMs = 50000,
    signal?: AbortSignal,
  ): Promise<HarborRequest> {
    z.number().int().min(0).max(50000).parse(waitMs);
    const current = this.result(terminalId, requestId, false);
    if (current.status !== "pending" || !waitMs || signal?.aborted)
      return this.result(terminalId, requestId, !signal?.aborted);
    if (this.waiting.has(requestId))
      throw new Error("이 질문의 답변을 이미 기다리고 있습니다.");
    this.waiting.add(requestId);
    await new Promise<void>((done) => {
      const finish = () => {
        clearTimeout(timer);
        this.off("change", changed);
        signal?.removeEventListener("abort", finish);
        this.waiting.delete(requestId);
        done();
      };
      const changed = () => {
        if (this.result(terminalId, requestId, false).status !== "pending")
          finish();
      };
      const timer = setTimeout(finish, waitMs);
      this.on("change", changed);
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted) finish();
    });
    return this.result(terminalId, requestId, !signal?.aborted);
  }
  cancel(
    requestId: string,
    reason = "사용자가 질문을 닫았습니다.",
  ): HarborRequest {
    const request = this.find(requestId);
    this.cancelWhere((item) => item.id === requestId, reason.slice(0, 300));
    return structuredClone(this.find(request.id));
  }
  cancelTerminal(terminalId: string): void {
    this.cancelWhere(
      (request) => request.terminal.terminalId === terminalId,
      "질문을 보낸 에이전트 연결이 종료되었습니다.",
    );
  }
  shutdown(): void {
    this.cancelWhere(() => true, "앱 연결이 종료되었습니다.");
  }
  private cancelWhere(
    matches: (request: HarborRequest) => boolean,
    reason: string,
  ): void {
    let changed = false;
    const next = this.requests.map((request): HarborRequest => {
      if (
        !matches(request) ||
        !["pending", "answered"].includes(request.status)
      )
        return request;
      changed = true;
      return {
        ...request,
        status: "cancelled",
        cancelledAt: Date.now(),
        cancellationReason: reason,
      };
    });
    if (changed) this.commit(next);
  }
  private find(requestId: string): HarborRequest {
    const request = this.requests.find((request) => request.id === requestId);
    if (!request) throw new Error("질문을 찾을 수 없습니다.");
    return request;
  }
  private update(request: HarborRequest): HarborRequest {
    this.commit(
      this.bounded(
        this.requests.map((item) => (item.id === request.id ? request : item)),
      ),
    );
    return structuredClone(request);
  }
  private textSize(requests: HarborRequest[]): number {
    return requests.reduce(
      (sum, request) =>
        sum +
        request.title.length +
        request.question.length +
        (request.answer?.text.length || 0) +
        (request.permission?.command?.length || 0) +
        (request.permission?.cwd?.length || 0) +
        (request.permission?.detail?.length || 0) +
        request.options.reduce((sum, option) => sum + option.label.length, 0),
      0,
    );
  }
  private bounded(requests: HarborRequest[]): HarborRequest[] {
    const next = [...requests];
    while (next.length > MAX_REQUESTS || this.textSize(next) > MAX_TEXT) {
      const removable = next.findIndex(
        (request) =>
          ["consumed", "cancelled"].includes(request.status) &&
          !this.waiting.has(request.id),
      );
      if (removable < 0)
        throw new Error("질문함이 가득 찼습니다. 먼저 이전 질문을 처리하세요.");
      next.splice(removable, 1);
    }
    return next;
  }
  private commit(next: HarborRequest[]): void {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, requests: next }), {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temp, this.file);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {}
      throw error;
    }
    this.requests = next;
    this.emit("change");
  }
}
