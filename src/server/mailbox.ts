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
import {
  MAILBOX_TEXT_LIMIT,
  type MailboxMessage,
  type MailboxParticipant,
  type MailboxSendInput,
  type MailboxStatus,
} from "../shared/mailbox.js";
import type { HostConfig, TerminalInfo } from "../shared/types.js";

const MAX_MESSAGES = 500;
const MAX_TEXT = 1024 * 1024;
const idSchema = z.string().trim().min(1).max(256);
const participantSchema = z.object({
  kind: z.enum(["user", "terminal"]),
  title: z.string().max(200),
  terminalId: idSchema.optional(),
  hostId: idSchema.optional(),
  hostName: z.string().max(200).optional(),
  cwd: z.string().max(4096).optional(),
});
const messageSchema = z.object({
  id: idSchema,
  threadId: idSchema,
  replyToId: idSchema.optional(),
  sender: participantSchema,
  recipient: participantSchema,
  author: z.enum(["user", "agent"]),
  text: z.string().min(1).max(MAILBOX_TEXT_LIMIT),
  createdAt: z.number().finite().nonnegative(),
  status: z.enum(["queued", "read", "drafted", "consumed"]),
  readAt: z.number().finite().nonnegative().optional(),
  draftedAt: z.number().finite().nonnegative().optional(),
  consumedAt: z.number().finite().nonnegative().optional(),
  repliedAt: z.number().finite().nonnegative().optional(),
  replyMessageId: idSchema.optional(),
});
const sendSchema = z.object({
  fromTerminalId: idSchema.optional(),
  toTerminalId: idSchema,
  text: z
    .string()
    .trim()
    .min(1, "보낼 내용을 입력하세요.")
    .max(MAILBOX_TEXT_LIMIT),
  replyToId: idSchema.optional(),
});

interface Resolver {
  terminal(id: string): TerminalInfo | undefined;
  host(id: string): Pick<HostConfig, "id" | "name"> | undefined;
}

/** Durable messages; agent consumption is recorded only by the scoped MCP bridge. */
export class Mailbox extends EventEmitter {
  readonly file: string;
  private messages: MailboxMessage[] = [];

  constructor(
    directory: string,
    private readonly resolve: Resolver,
  ) {
    super();
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, "mailbox.json");
    try {
      // Bound loading before parsing to avoid an unexpectedly large state file.
      if (statSync(this.file).size > 16 * 1024 * 1024)
        throw new Error("메시지 기록 파일이 너무 큽니다.");
      const saved = z
        .object({
          version: z.literal(1),
          messages: z.array(messageSchema).max(MAX_MESSAGES),
        })
        .parse(JSON.parse(readFileSync(this.file, "utf8")));
      if (
        saved.messages.reduce((sum, message) => sum + message.text.length, 0) >
        MAX_TEXT
      )
        throw new Error("메시지 기록 파일이 너무 큽니다.");
      this.messages = saved.messages;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  /** Latest first; filtering includes both sent messages and the selected inbox. */
  list(terminalId?: string): MailboxMessage[] {
    const selected = terminalId
      ? this.messages.filter(
          (message) =>
            message.sender.terminalId === terminalId ||
            message.recipient.terminalId === terminalId,
        )
      : this.messages;
    return structuredClone(selected).reverse();
  }

  send(input: MailboxSendInput): MailboxMessage {
    const parsed = sendSchema.parse(input);
    const sender = parsed.fromTerminalId
      ? this.participant(parsed.fromTerminalId)
      : { kind: "user" as const, title: "나" };
    const recipient = this.participant(parsed.toTerminalId);
    return this.create(
      sender,
      recipient,
      parsed.text,
      parsed.replyToId,
      "user",
    );
  }

  sendAgent(
    fromTerminalId: string,
    toTerminalId: string,
    text: string,
  ): MailboxMessage {
    const parsed = sendSchema.parse({ fromTerminalId, toTerminalId, text });
    return this.create(
      this.participant(fromTerminalId),
      this.participant(toTerminalId),
      parsed.text,
      undefined,
      "agent",
    );
  }

  replyAgent(
    fromTerminalId: string,
    replyToId: string,
    text: string,
  ): MailboxMessage {
    const previous = this.messages.find((message) => message.id === replyToId);
    if (!previous || previous.recipient.terminalId !== fromTerminalId)
      throw new Error("이 세션으로 받은 메시지에만 답장할 수 있습니다.");
    const recipient =
      previous.sender.kind === "terminal"
        ? this.participant(previous.sender.terminalId!)
        : { kind: "user" as const, title: "나" };
    const parsed = z.string().trim().min(1).max(MAILBOX_TEXT_LIMIT).parse(text);
    return this.create(
      this.participant(fromTerminalId),
      recipient,
      parsed,
      replyToId,
      "agent",
    );
  }

  /** The recipient's authenticated MCP fetch is the only path to consumed. */
  consume(
    terminalId: string,
    options: { unreadOnly?: boolean; limit?: number } = {},
  ): MailboxMessage[] {
    this.participant(terminalId);
    const limit = z
      .number()
      .int()
      .min(1)
      .max(50)
      .parse(options.limit ?? 20);
    const selected = this.messages
      .filter(
        (message) =>
          message.recipient.terminalId === terminalId &&
          (options.unreadOnly === false || !message.consumedAt),
      )
      .slice(0, limit);
    const ids = new Set(selected.map((message) => message.id));
    const now = Date.now();
    if (selected.some((message) => !message.consumedAt)) {
      this.commit(
        this.messages.map((message) =>
          ids.has(message.id) && !message.consumedAt
            ? { ...message, status: "consumed", consumedAt: now }
            : message,
        ),
      );
    }
    return structuredClone(
      this.messages.filter((message) => ids.has(message.id)),
    );
  }

  private create(
    sender: MailboxParticipant,
    recipient: MailboxParticipant,
    text: string,
    replyToId: string | undefined,
    author: "user" | "agent",
  ): MailboxMessage {
    if (sender.terminalId === recipient.terminalId)
      throw new Error("다른 세션을 선택하세요.");
    const previous = replyToId
      ? this.messages.find((message) => message.id === replyToId)
      : undefined;
    if (replyToId && !previous)
      throw new Error("답장할 메시지를 찾을 수 없습니다.");
    if (previous) {
      const original = [this.key(previous.sender), this.key(previous.recipient)]
        .sort()
        .join("\n");
      const current = [this.key(sender), this.key(recipient)].sort().join("\n");
      if (original !== current)
        throw new Error("답장은 원래 대화에 참여한 세션끼리 보낼 수 있습니다.");
    }
    const id = randomUUID();
    const message: MailboxMessage = {
      id,
      threadId: previous?.threadId || id,
      ...(previous ? { replyToId: previous.id } : {}),
      sender,
      recipient,
      author,
      text,
      createdAt: Date.now(),
      status: "queued",
    };
    const next = [
      ...this.messages.map((item) =>
        item.id === previous?.id
          ? {
              ...item,
              repliedAt: message.createdAt,
              replyMessageId: message.id,
            }
          : item,
      ),
      message,
    ];
    let textLength = next.reduce((sum, item) => sum + item.text.length, 0);
    while (next.length > MAX_MESSAGES || textLength > MAX_TEXT) {
      // Never silently discard an unread message to make room for another one.
      const oldestRead = next.findIndex(
        (item) =>
          item.status === "consumed" ||
          (item.recipient.kind === "user" && item.status !== "queued"),
      );
      if (oldestRead < 0)
        throw new Error(
          "메시지함이 가득 찼습니다. 이전 메시지를 읽거나 삭제하세요.",
        );
      textLength -= next[oldestRead].text.length;
      next.splice(oldestRead, 1);
    }
    this.commit(next);
    return structuredClone(message);
  }

  /** 'drafted' only means the user prepared/copied a draft, not that Codex read it. */
  mark(id: string, status: "read" | "drafted"): MailboxMessage {
    z.enum(["read", "drafted"]).parse(status);
    const index = this.messages.findIndex((message) => message.id === id);
    if (index < 0) throw new Error("메시지를 찾을 수 없습니다.");
    const old = this.messages[index];
    const nextStatus =
      old.status === "consumed"
        ? "consumed"
        : old.status === "drafted"
          ? "drafted"
          : status;
    if (old.status === nextStatus) return structuredClone(old);
    const now = Date.now();
    const updated: MailboxMessage = {
      ...old,
      status: nextStatus,
      readAt: old.readAt || now,
      ...(nextStatus === "drafted" ? { draftedAt: now } : {}),
    };
    const next = this.messages.slice();
    next[index] = updated;
    this.commit(next);
    return structuredClone(updated);
  }

  remove(id: string): void {
    const next = this.messages.filter((message) => message.id !== id);
    if (next.length !== this.messages.length) this.commit(next);
  }

  private participant(id: string): MailboxParticipant {
    const terminal = this.resolve.terminal(id);
    if (!terminal || terminal.exited)
      throw new Error("열려 있는 세션을 선택하세요.");
    if (terminal.agentKind === "claude" || (!terminal.agentKind && terminal.program?.startsWith("claude")))
      throw new Error("Claude 세션 간 메시지 전달은 아직 지원하지 않습니다.");
    const host = this.resolve.host(terminal.hostId);
    if (!host) throw new Error("세션의 호스트를 찾을 수 없습니다.");
    return participantSchema.parse({
      kind: "terminal",
      terminalId: terminal.id,
      title: terminal.title,
      hostId: host.id,
      hostName: host.name,
      cwd: terminal.cwd,
    });
  }

  private key(participant: MailboxParticipant): string {
    return participant.kind === "user"
      ? "user"
      : `terminal:${participant.terminalId}`;
  }

  private commit(next: MailboxMessage[]): void {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, messages: next }), {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporary, this.file);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        /* The write may not have created it. */
      }
      throw error;
    }
    this.messages = next;
    this.emit("change");
  }
}
