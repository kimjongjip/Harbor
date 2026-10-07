import { EventEmitter } from "node:events";
import { z } from "zod";
import type { MailboxMessage } from "../shared/mailbox.js";
import { Mailbox } from "./mailbox.js";

export const peerRuntimeSchema = z
  .object({
    kind: z.enum(["codex", "claude"]),
    sessionId: z.string().trim().min(1).max(256).optional(),
    state: z.enum(["idle", "working", "offline"]),
    delivery: z.enum(["automatic", "poll", "unavailable"]),
    detail: z.string().max(500).optional(),
    endpoint: z
      .object({
        port: z.number().int().min(1).max(65535),
        token: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PeerRuntime = z.infer<typeof peerRuntimeSchema>;
export type PeerRuntimeStatus = Omit<PeerRuntime, "endpoint">;
export interface PeerAnswer {
  requestId: string;
  threadId: string;
  status: "pending" | "answered" | "unavailable";
  message: MailboxMessage;
  reply?: MailboxMessage;
  reason?: string;
  recipientRuntime?: PeerRuntimeStatus;
}

/** Native thread identity gates every transport event; no terminal input is written. */
export class PeerDelivery extends EventEmitter {
  private readonly runtimes = new Map<string, PeerRuntimeStatus>();
  private readonly waiting = new Map<string, Set<string>>();

  constructor(private readonly mailbox: Mailbox) {
    super();
    this.setMaxListeners(256);
    mailbox.on("change", () => this.emit("change"));
  }

  setRuntime(terminalId: string, input: PeerRuntime): PeerRuntimeStatus {
    const { endpoint: _secretEndpoint, ...runtime } =
      peerRuntimeSchema.parse(input);
    this.runtimes.set(terminalId, runtime);
    this.emit("change");
    return structuredClone(runtime);
  }

  runtime(terminalId: string): PeerRuntimeStatus | undefined {
    const runtime = this.runtimes.get(terminalId);
    return runtime ? structuredClone(runtime) : undefined;
  }

  revoke(terminalId: string): void {
    const previous = this.runtimes.get(terminalId);
    if (previous)
      this.runtimes.set(terminalId, {
        ...previous,
        state: "offline",
        delivery: "unavailable",
      });
    this.emit("change");
  }

  send(
    from: string,
    to: string,
    text: string,
    purpose?: "question",
  ): MailboxMessage {
    const senderSessionId = this.runtime(from)?.sessionId;
    if (
      purpose &&
      this.mailbox
        .list(from)
        .filter(
          (item) =>
            item.sender.terminalId === from &&
            item.sender.sessionId === senderSessionId &&
            item.purpose === "question" &&
            !item.repliedAt,
        ).length >= 8
    )
      throw new Error("먼저 보낸 세션 질문의 답변을 확인하세요.");
    return this.mailbox.sendAgent(from, to, text, {
      senderSessionId: this.runtime(from)?.sessionId,
      recipientSessionId: this.runtime(to)?.sessionId,
      purpose,
    });
  }

  events(
    terminalId: string,
    sessionId?: string,
  ): {
    sessionId?: string;
    runtime?: PeerRuntimeStatus;
    messages: MailboxMessage[];
    reason?: string;
  } {
    const runtime = this.runtime(terminalId);
    if (
      !runtime?.sessionId ||
      runtime.state === "offline" ||
      runtime.delivery !== "automatic"
    )
      return {
        sessionId: runtime?.sessionId,
        runtime,
        messages: [],
        reason:
          "Automatic delivery is not connected to a live native conversation.",
      };
    if (sessionId && sessionId !== runtime.sessionId)
      return {
        sessionId: runtime.sessionId,
        runtime,
        messages: [],
        reason: "Native conversation changed; refresh the runtime binding.",
      };
    const messages = this.mailbox
      .list(terminalId)
      .reverse()
      .filter(
        (item) =>
          item.recipient.terminalId === terminalId &&
          item.recipient.sessionId === runtime.sessionId &&
          !item.consumedAt &&
          !item.offeredAt &&
          // A waiting MCP call will deliver its own actual reply, once, as its result.
          !(
            item.replyToId && this.waiting.get(terminalId)?.has(item.replyToId)
          ),
      )
      .slice(0, 20);
    return { sessionId: runtime.sessionId, runtime, messages };
  }

  ack(
    terminalId: string,
    messageId: string,
    sessionId: string,
  ): MailboxMessage {
    const runtime = this.runtime(terminalId);
    if (
      !runtime ||
      runtime.state === "offline" ||
      runtime.sessionId !== sessionId
    )
      throw new Error("현재 네이티브 대화에서만 전달 확인할 수 있습니다.");
    return this.mailbox.offer(terminalId, messageId, sessionId);
  }

  result(terminalId: string, requestId: string, consume = true): PeerAnswer {
    const message = this.mailbox.find(requestId);
    if (
      !message ||
      message.purpose !== "question" ||
      message.sender.terminalId !== terminalId
    )
      throw new Error("이 세션에서 보낸 질문만 확인할 수 있습니다.");
    const senderSession = this.runtime(terminalId)?.sessionId;
    if (message.sender.sessionId && message.sender.sessionId !== senderSession)
      throw new Error("이 질문은 다른 네이티브 대화에서 보냈습니다.");
    const reply = message.replyMessageId
      ? this.mailbox.find(message.replyMessageId)
      : undefined;
    if (reply?.author === "agent") {
      const delivered = consume
        ? this.mailbox.consumeMessage(terminalId, reply.id, senderSession)
        : reply;
      return {
        requestId,
        threadId: message.threadId,
        status: "answered",
        message,
        reply: delivered,
      };
    }
    const recipient = message.recipient.terminalId
      ? this.runtime(message.recipient.terminalId)
      : undefined;
    const changed =
      message.recipient.sessionId &&
      recipient?.sessionId &&
      message.recipient.sessionId !== recipient.sessionId;
    return {
      requestId,
      threadId: message.threadId,
      message,
      status:
        recipient?.state === "offline" || changed ? "unavailable" : "pending",
      ...(recipient ? { recipientRuntime: recipient } : {}),
      ...(changed
        ? {
            reason:
              "Recipient opened another native conversation; this question remains bound to its original conversation.",
          }
        : recipient?.state === "offline"
          ? {
              reason:
                "Recipient runtime is offline. No answer has been received.",
            }
          : recipient?.delivery !== "automatic"
            ? {
                reason:
                  "No actual peer reply has arrived. Automatic delivery is unavailable; the recipient must call harbor_inbox in its own native conversation.",
              }
            : { reason: "No actual peer reply has arrived." }),
    };
  }

  async wait(
    terminalId: string,
    requestId: string,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<PeerAnswer> {
    z.number().int().min(0).max(50000).parse(waitMs);
    const current = this.result(terminalId, requestId, false);
    const recipientId = current.message.recipient.terminalId;
    if (
      current.status !== "pending" ||
      !waitMs ||
      signal?.aborted ||
      (recipientId && this.waiting.get(recipientId)?.size)
    )
      return this.result(terminalId, requestId, !signal?.aborted);
    const waiting = this.waiting.get(terminalId) || new Set<string>();
    if (waiting.has(requestId))
      throw new Error("이 질문의 답변을 이미 기다리고 있습니다.");
    this.waiting.set(terminalId, waiting);
    waiting.add(requestId);
    try {
      await new Promise<void>((done) => {
        const finish = () => {
          clearTimeout(timer);
          this.off("change", changed);
          signal?.removeEventListener("abort", finish);
          done();
        };
        const changed = () => {
          try {
            if (this.result(terminalId, requestId, false).status !== "pending")
              finish();
          } catch {
            finish();
          }
        };
        const timer = setTimeout(finish, waitMs);
        this.on("change", changed);
        signal?.addEventListener("abort", finish, { once: true });
        changed();
        if (signal?.aborted) finish();
      });
      return this.result(terminalId, requestId, !signal?.aborted);
    } finally {
      waiting.delete(requestId);
      if (!waiting.size) this.waiting.delete(terminalId);
      this.emit("change");
    }
  }

  async poll(
    terminalId: string,
    sessionId: string | undefined,
    waitMs: number,
    signal?: AbortSignal,
  ) {
    z.number().int().min(0).max(25000).parse(waitMs);
    const current = this.events(terminalId, sessionId);
    if (current.messages.length || current.reason || !waitMs || signal?.aborted)
      return current;
    await new Promise<void>((done) => {
      const finish = () => {
        clearTimeout(timer);
        this.off("change", changed);
        signal?.removeEventListener("abort", finish);
        done();
      };
      const changed = () => {
        const next = this.events(terminalId, sessionId);
        if (next.messages.length || next.reason) finish();
      };
      const timer = setTimeout(finish, waitMs);
      this.on("change", changed);
      signal?.addEventListener("abort", finish, { once: true });
      changed();
      if (signal?.aborted) finish();
    });
    return this.events(terminalId, sessionId);
  }
}
