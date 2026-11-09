import { createHash, randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import type {
  IdeChatAnswer,
  IdeChatConversation,
  IdeChatCreate,
  IdeChatProvider,
  IdeChatReceipt,
  IdeChatSend,
} from "../shared/ide-chat.js";
import type { HistoryDetail, HistoryPage } from "../shared/history.js";
import type { Approval, HostConfig, SessionView } from "../shared/types.js";
import type { Hub } from "./hub.js";
import {
  type IdeLiveBinding,
  IdeLiveChats,
  ideLiveRequestId,
} from "./ide-chat-live.js";
import {
  createClaudeChatFactory,
  type ClaudeChatFactory,
  type ClaudeChatRun,
} from "./ide-chat-claude.js";

type Guard = () => void | Promise<void>;
type IdeHub = Pick<
  Hub,
  | "connect"
  | "createSession"
  | "importSession"
  | "openSession"
  | "olderHistory"
  | "send"
  | "interrupt"
  | "answer"
  | "session"
  | "saveSession"
> &
  Partial<Pick<Hub, "on" | "off" | "rename">>;
export interface IdeChatDependencies {
  runtimeId: string;
  hub: IdeHub;
  host(id: string): HostConfig;
  password(hostId: string): string | undefined | Promise<string | undefined>;
  resolveCwd(hostId: string, cwd?: string): Promise<string>;
  historyList(
    hostId: string,
    provider: IdeChatProvider,
    options: { cursor?: string; search?: string },
  ): Promise<HistoryPage>;
  historyRead(
    hostId: string,
    provider: IdeChatProvider,
    nativeId: string,
    cursor?: string,
  ): Promise<HistoryDetail>;
  nativeActive(
    hostId: string,
    provider: IdeChatProvider,
    nativeId: string,
  ): boolean;
  claude?: ClaudeChatFactory;
  live?: IdeLiveChats;
}
interface Managed {
  view: IdeChatConversation;
  hostKey: string;
  hubId?: string;
  resumed: boolean;
  sending: boolean;
  title?: string;
  run?: ClaudeChatRun;
  liveBinding?: IdeLiveBinding;
  liveOlder?: boolean;
  livePending?: Map<
    string,
    { text: string; requestId: string; existing: Set<string> }
  >;
  pending: Map<
    string,
    (value: { approved?: boolean; answers?: Record<string, string> }) => void
  >;
  receipts: Map<string, { fingerprint: string; value: IdeChatReceipt }>;
}
export class IdeChatError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
const idSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_-]+$/);
const requestSchema = z
  .string()
  .min(8)
  .max(160)
  .regex(/^[A-Za-z0-9_-]+$/);
const approvalIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !/[\x00-\x1f\x7f]/.test(value));
const providerSchema = z.enum(["codex", "claude"]);
const createSchema = z
  .object({
    hostId: idSchema,
    provider: providerSchema,
    requestId: requestSchema,
    cwd: z.string().min(1).max(4096).optional(),
    model: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[\w.:/-]+$/)
      .optional(),
    resumeId: idSchema.optional(),
  })
  .strict();
const sendSchema = z
  .object({
    runtimeId: idSchema,
    requestId: requestSchema,
    text: z
      .string()
      .min(1)
      .max(64000)
      .refine((text) => Boolean(text.trim()) && !text.includes("\0")),
  })
  .strict();
const answerSchema = z
  .object({
    runtimeId: idSchema,
    approved: z.boolean().optional(),
    answers: z.record(z.string().max(200), z.string().max(16000)).optional(),
  })
  .strict();
const runtimeSchema = z.object({ runtimeId: idSchema }).strict();
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hostKey = (host: HostConfig) =>
  fingerprint([
    host.id,
    host.kind,
    host.address,
    host.username,
    host.port,
    host.identityFile,
    host.codexPath,
  ]);
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const editorSelectionSchema = z
  .object({
    path: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    unsaved: z.boolean().optional(),
    text: z.string(),
  })
  .strict()
  .refine((selection) => selection.endLine >= selection.startLine);
function promptTitle(text: string): string {
  const selection = text.match(
    /\n\n<editor_selection>\n([\s\S]+)\n<\/editor_selection>$/,
  );
  if (selection) {
    try {
      if (editorSelectionSchema.safeParse(JSON.parse(selection[1])).success)
        return (
          text.slice(0, selection.index).trim().slice(0, 80) || "선택한 부분"
        );
    } catch {
      // A literal or malformed example is ordinary user text, not an attachment.
    }
  }
  return text.trim().slice(0, 80);
}
function isClaudeIdePrompt(
  text: string,
  prompt: string,
  requestId: string,
): boolean {
  const content =
    text.match(/<channel(?:\s[^>]*)?>([\s\S]*?)<\/channel>/)?.[1] || text;
  try {
    const envelope = JSON.parse(content.trim());
    return (
      envelope?.userInput?.version === 1 &&
      envelope?.sender?.kind === "user" &&
      envelope.userInput.requestId === requestId &&
      envelope.text === prompt
    );
  } catch {
    return false;
  }
}

/** Fresh native conversations and views of already-running CLI conversations. */
export class IdeChats {
  private readonly conversations = new Map<string, Managed>();
  private readonly native = new Map<string, string>();
  private readonly creations = new Map<
    string,
    { fingerprint: string; promise: Promise<string> }
  >();
  private readonly creatingNative = new Map<string, Promise<string>>();
  private readonly claude: ClaudeChatFactory;
  private readonly onSession = (session: SessionView) => {
    const id = this.native.get(
      this.nativeKey(session.hostId, "codex", session.threadId),
    );
    if (id) this.touch(this.managed(id));
  };
  constructor(readonly dependencies: IdeChatDependencies) {
    this.claude = dependencies.claude || createClaudeChatFactory();
    dependencies.hub.on?.("session", this.onSession);
  }
  private nativeKey(
    hostId: string,
    provider: IdeChatProvider,
    nativeId: string,
  ) {
    return `${hostId}:${provider}:${nativeId}`;
  }
  private managed(id: string) {
    const conversation = this.conversations.get(id);
    if (!conversation)
      throw new IdeChatError(
        "IDE 대화를 찾을 수 없습니다. 대화 기록에서 다시 열어 주세요.",
        404,
      );
    return conversation;
  }
  hostFor(id: string) {
    return this.managed(id).view.hostId;
  }
  terminalFor(id: string) {
    return this.managed(id).liveBinding?.terminalId;
  }
  private binding(managed: Managed, runtimeId: string) {
    if (
      runtimeId !== this.dependencies.runtimeId ||
      runtimeId !== managed.view.runtimeId
    )
      throw new IdeChatError(
        "Harbor 연결이 바뀌었습니다. 대화 기록에서 다시 열어 주세요.",
        409,
      );
    if (
      hostKey(this.dependencies.host(managed.view.hostId)) !== managed.hostKey
    )
      throw new IdeChatError(
        "서버 연결 설정이 바뀌었습니다. 대화 기록에서 다시 열어 주세요.",
        409,
      );
  }
  private checkNative(
    hostId: string,
    provider: IdeChatProvider,
    nativeId: string,
  ) {
    if (this.dependencies.nativeActive(hostId, provider, nativeId))
      throw new IdeChatError(
        "이 대화는 터미널에서 열려 있습니다. 연결 정보를 확인한 뒤 다시 선택해 주세요.",
        409,
      );
  }
  private touch(managed: Managed) {
    managed.view.revision++;
    managed.view.updatedAt = Date.now();
  }
  private sync(managed: Managed) {
    if (managed.liveBinding && this.dependencies.live) {
      const current = this.dependencies.live.get(managed.liveBinding);
      managed.view.live = current.live;
      managed.view.status = current.status;
      return;
    }
    if (!managed.hubId) return;
    const session = this.dependencies.hub.session(managed.hubId);
    Object.assign(managed.view, {
      nativeId: session.threadId,
      title: managed.title || session.title,
      cwd: session.cwd,
      model: session.model,
      status: session.status,
      items: session.items,
      approvals: session.approvals,
      historyCursor: session.historyCursor || null,
      error: session.error || undefined,
      updatedAt: session.updatedAt,
    });
  }
  snapshot(id: string): IdeChatConversation {
    const managed = this.managed(id);
    this.sync(managed);
    // Give every outgoing snapshot a monotonic version. Native events are
    // coalesced by Hub for 70 ms; a read in that window must still supersede an
    // older in-flight HTTP response after a question/approval is answered.
    managed.view.revision++;
    // Never return mutable receipt/approval resolver objects or credentials.
    return structuredClone(managed.view);
  }
  async read(id: string, guard: Guard): Promise<IdeChatConversation> {
    const managed = this.managed(id);
    await guard();
    this.binding(managed, this.dependencies.runtimeId);
    if (managed.liveBinding && this.dependencies.live) {
      try {
        const page = await this.dependencies.live.read(managed.liveBinding);
        await guard();
        this.binding(managed, this.dependencies.runtimeId);
        this.mergeLiveHistory(managed, page);
        managed.view.error = undefined;
      } catch (error) {
        // Connection/history failures leave already rendered native blocks in
        // place. Authorization and host binding still apply to cached reads.
        await guard();
        this.binding(managed, this.dependencies.runtimeId);
        managed.view.error = errorText(error);
      }
    }
    await guard();
    return this.snapshot(id);
  }
  private reconcileLivePending(
    managed: Managed,
    items: IdeChatConversation["items"],
  ) {
    const pending = managed.livePending;
    const claimed = new Set<string>();
    for (const [id, submission] of pending || []) {
      const received = items.find(
        (item) =>
          item.kind === "user" &&
          !submission.existing.has(item.id) &&
          !claimed.has(item.id) &&
          !item.id.startsWith("harbor-live-pending-") &&
          (managed.view.provider === "claude"
            ? item.id === `harbor-ide-user:${submission.requestId}` ||
              isClaudeIdePrompt(
                item.text,
                submission.text,
                submission.requestId,
              )
            : item.text === submission.text),
      );
      if (received) {
        claimed.add(received.id);
        pending!.delete(id);
        for (const other of pending!.values()) other.existing.add(received.id);
      }
    }
  }
  private mergeLiveHistory(managed: Managed, page: HistoryDetail) {
    const view = managed.view;
    this.reconcileLivePending(managed, page.items);
    const pending = managed.livePending;
    const items = new Map(
      view.items
        .filter((item) => !item.id.startsWith("harbor-live-pending-"))
        .map((item) => [item.id, item]),
    );
    for (const item of page.items) items.set(item.id, item);
    for (const [id, submission] of pending || [])
      items.set(id, {
        id,
        kind: "user",
        text: submission.text,
        status: "queued",
      });
    view.items = [...items.values()];
    view.title = page.thread.title || view.title;
    view.cwd = page.thread.cwd || view.cwd;
    // Older loaded messages stay in this view across live polls, so a notice
    // about an omitted record remains relevant until the conversation closes.
    view.historyNotice = page.notice || view.historyNotice;
    if (!managed.liveOlder) view.historyCursor = page.nextCursor;
    this.touch(managed);
  }
  async list(
    hostId: string,
    provider: IdeChatProvider,
    options: { cursor?: string; search?: string },
    guard: Guard,
  ): Promise<HistoryPage> {
    idSchema.parse(hostId);
    providerSchema.parse(provider);
    await guard();
    this.dependencies.host(hostId);
    const page = await this.dependencies.historyList(hostId, provider, options);
    await guard();
    if (options.cursor) return page;
    const merged = new Map(page.data.map((thread) => [thread.id, thread]));
    const search = options.search?.toLocaleLowerCase();
    for (const managed of this.conversations.values()) {
      if (
        managed.view.hostId !== hostId ||
        managed.view.provider !== provider ||
        !managed.receipts.size
      )
        continue;
      this.sync(managed);
      const view = managed.view;
      if (
        search &&
        !`${view.title}\n${view.cwd}\n${view.items.find((item) => item.kind === "user")?.text || ""}`
          .toLocaleLowerCase()
          .includes(search)
      )
        continue;
      const existing = merged.get(view.nativeId);
      merged.set(view.nativeId, {
        ...existing,
        provider,
        id: view.nativeId,
        hostId,
        title: view.title,
        cwd: view.cwd,
        preview:
          existing?.preview ||
          [...view.items]
            .reverse()
            .find((item) => item.kind === "assistant" || item.kind === "user")
            ?.text.slice(0, 300) ||
          "",
        updatedAt: Math.max(existing?.updatedAt || 0, view.updatedAt),
        source: existing?.source || "Harbor IDE",
        active: view.status === "running" || view.status === "waiting",
      });
    }
    return {
      ...page,
      data: [...merged.values()].sort(
        (left, right) => right.updatedAt - left.updatedAt,
      ),
    };
  }
  async create(
    input: IdeChatCreate,
    actor: string,
    guard: Guard,
  ): Promise<IdeChatConversation> {
    input = createSchema.parse(input);
    await guard();
    this.dependencies.host(input.hostId);
    const key = `${actor}:${input.requestId}`;
    const hash = fingerprint(input);
    const prior = this.creations.get(key);
    if (prior) {
      if (prior.fingerprint !== hash)
        throw new IdeChatError(
          "같은 요청 ID에 다른 대화 설정을 보낼 수 없습니다.",
          409,
        );
      const id = await prior.promise;
      await guard();
      return this.read(id, guard);
    }
    if (this.conversations.size >= 200 || this.creations.size >= 2000)
      throw new IdeChatError(
        "열린 IDE 대화가 너무 많습니다. 작업을 마친 후 Harbor를 다시 시작해 주세요.",
        429,
      );
    const promise = this.createManaged(input, guard);
    this.creations.set(key, { fingerprint: hash, promise });
    try {
      const id = await promise;
      await guard();
      return this.read(id, guard);
    } catch (error) {
      // Creation never sends a prompt. Retrying a failed initialization is safe
      // and must recover after a CLI closes, credentials change, or SSH returns.
      if (this.creations.get(key)?.promise === promise)
        this.creations.delete(key);
      throw error;
    }
  }
  private async createManaged(
    input: IdeChatCreate,
    guard: Guard,
  ): Promise<string> {
    const nativeKey = input.resumeId
      ? this.nativeKey(input.hostId, input.provider, input.resumeId)
      : undefined;
    if (nativeKey) {
      const live = this.dependencies.live?.find(
        input.hostId,
        input.provider,
        input.resumeId!,
      );
      const existing = this.native.get(nativeKey);
      if (existing) {
        const managed = this.managed(existing);
        this.sync(managed);
        if (managed.hostKey === hostKey(this.dependencies.host(input.hostId))) {
          if (live) {
            if (
              managed.run ||
              (managed.hubId &&
                ["running", "waiting"].includes(managed.view.status))
            )
              throw new IdeChatError(
                "이 대화에서 IDE 작업이 이미 진행 중입니다. 현재 작업 화면을 사용해 주세요.",
                409,
              );
            managed.liveBinding = live;
            managed.hubId = undefined;
            managed.livePending ||= new Map();
            managed.view.approvals = [];
            return existing;
          }
          if (!managed.liveBinding) {
            this.checkNative(input.hostId, input.provider, input.resumeId!);
            return existing;
          }
          // The original CLI exited. A deliberate history resume can now use
          // the managed native flow; the old reader remains bound to its ID.
          this.native.delete(nativeKey);
        }
        if (
          !managed.liveBinding &&
          (managed.run ||
            managed.view.status === "running" ||
            managed.view.status === "waiting")
        )
          throw new IdeChatError(
            "이전 서버 설정으로 실행 중인 IDE 대화가 있습니다. 해당 작업이 끝난 뒤 다시 열어 주세요.",
            409,
          );
        this.native.delete(nativeKey);
      }
      const creating = this.creatingNative.get(nativeKey);
      if (creating) {
        const id = await creating;
        await guard();
        return id;
      }
    }
    const promise = this.initializeManaged(input, guard);
    if (nativeKey) this.creatingNative.set(nativeKey, promise);
    try {
      return await promise;
    } finally {
      if (nativeKey) this.creatingNative.delete(nativeKey);
    }
  }
  private async initializeManaged(
    input: IdeChatCreate,
    guard: Guard,
  ): Promise<string> {
    const { hostId, provider } = input;
    const originalHostKey = hostKey(this.dependencies.host(hostId));
    const authorize = guard;
    guard = async () => {
      await authorize();
      if (hostKey(this.dependencies.host(hostId)) !== originalHostKey)
        throw new IdeChatError(
          "대화를 여는 동안 서버 연결 설정이 바뀌었습니다.",
          409,
        );
    };
    const live =
      input.resumeId &&
      this.dependencies.live?.find(hostId, provider, input.resumeId);
    if (live && this.dependencies.live) {
      await guard();
      const current = this.dependencies.live.get(live);
      const view: IdeChatConversation = {
        id: randomUUID(),
        runtimeId: this.dependencies.runtimeId,
        hostId,
        provider,
        nativeId: live.nativeId,
        title: current.terminal?.title || "열린 대화",
        cwd: current.terminal?.cwd || input.cwd || "~",
        model: "",
        status: current.status,
        items: [],
        approvals: [],
        historyCursor: null,
        live: current.live,
        revision: 1,
        updatedAt: Date.now(),
      };
      this.conversations.set(view.id, {
        view,
        hostKey: originalHostKey,
        resumed: true,
        sending: false,
        pending: new Map(),
        receipts: new Map(),
        liveBinding: live,
        livePending: new Map(),
      });
      this.native.set(this.nativeKey(hostId, provider, live.nativeId), view.id);
      return view.id;
    }
    let history: HistoryDetail | undefined;
    if (input.resumeId) {
      this.checkNative(hostId, provider, input.resumeId);
      history = await this.dependencies.historyRead(
        hostId,
        provider,
        input.resumeId,
      );
      await guard();
      if (
        history.thread.id !== input.resumeId ||
        history.thread.hostId !== hostId
      )
        throw new IdeChatError("대화 기록의 서버·ID가 요청과 다릅니다.", 409);
    }
    const cwd = await this.dependencies.resolveCwd(
      hostId,
      history?.thread.cwd || input.cwd,
    );
    await guard();
    let session: SessionView | undefined;
    if (provider === "codex") {
      const password = await this.dependencies.password(hostId);
      await guard();
      await this.dependencies.hub.connect(hostId, password);
      await guard();
      if (input.resumeId) {
        this.checkNative(hostId, provider, input.resumeId);
        session = await this.dependencies.hub.importSession(
          hostId,
          input.resumeId,
        );
        await guard();
        this.checkNative(hostId, provider, input.resumeId);
        session = await this.dependencies.hub.openSession(session.id);
        await guard();
        session.permission = "workspace-write";
        this.dependencies.hub.saveSession(session);
      } else
        session = await this.dependencies.hub.createSession(hostId, {
          title: "",
          cwd,
          model: input.model,
          permission: "workspace-write",
        });
      await guard();
    }
    const now = Date.now();
    const view: IdeChatConversation = {
      id: randomUUID(),
      runtimeId: this.dependencies.runtimeId,
      hostId,
      provider,
      nativeId: session?.threadId || input.resumeId || randomUUID(),
      title: session?.title || history?.thread.title || "새 대화",
      cwd: session?.cwd || cwd,
      model: session?.model || input.model || "",
      status: session?.status || "idle",
      items: session?.items || history?.items || [],
      approvals: session?.approvals || [],
      historyCursor: session?.historyCursor || history?.nextCursor || null,
      historyNotice: history?.notice,
      revision: 1,
      updatedAt: now,
    };
    const managed: Managed = {
      view,
      hostKey: originalHostKey,
      hubId: session?.id,
      resumed: Boolean(input.resumeId),
      sending: false,
      pending: new Map(),
      receipts: new Map(),
    };
    this.conversations.set(view.id, managed);
    this.native.set(this.nativeKey(hostId, provider, view.nativeId), view.id);
    return view.id;
  }
  async send(
    id: string,
    input: IdeChatSend,
    actor: string,
    guard: Guard,
  ): Promise<IdeChatReceipt> {
    input = sendSchema.parse(input);
    const managed = this.managed(id);
    await guard();
    this.binding(managed, input.runtimeId);
    this.sync(managed);
    const key = `${actor}:${input.requestId}`;
    const hash = fingerprint(input.text);
    const prior = managed.receipts.get(key);
    if (prior) {
      if (prior.fingerprint !== hash)
        throw new IdeChatError(
          "같은 요청 ID에 다른 메시지를 보낼 수 없습니다.",
          409,
        );
      return { ...prior.value, duplicate: true };
    }
    if (
      managed.sending ||
      (!managed.liveBinding &&
        (managed.view.status === "running" ||
          managed.view.status === "waiting"))
    )
      throw new IdeChatError("현재 답변·승인 처리가 끝난 뒤 보내 주세요.", 409);
    if (managed.receipts.size >= 4000)
      throw new IdeChatError(
        "이 대화의 전송 기록이 가득 찼습니다. 새 대화를 시작해 주세요.",
        429,
      );
    if (!managed.liveBinding)
      this.checkNative(
        managed.view.hostId,
        managed.view.provider,
        managed.view.nativeId,
      );
    managed.sending = true;
    const receipt: IdeChatReceipt = {
      ok: true,
      requestId: input.requestId,
      status: "uncertain",
    };
    // Reserve before dispatch. A timeout or lost HTTP response never causes a
    // second prompt when the client retries the same request ID.
    managed.receipts.set(key, { fingerprint: hash, value: receipt });
    let dispatched = false;
    try {
      await guard();
      this.binding(managed, input.runtimeId);
      if (managed.liveBinding && this.dependencies.live) {
        const beforeUserIds = new Set(
          managed.view.items
            .filter(
              (item) =>
                item.kind === "user" &&
                !item.id.startsWith("harbor-live-pending-"),
            )
            .map((item) => item.id),
        );
        receipt.status = await this.dependencies.live.send(
          managed.liveBinding,
          {
            requestId: key,
            text: input.text,
          },
          async () => {
            await guard();
            this.binding(managed, input.runtimeId);
            dispatched = true;
          },
        );
        if (receipt.status === "queued") {
          const itemId = `harbor-live-pending-${randomUUID()}`;
          managed.livePending!.set(itemId, {
            text: input.text,
            requestId: ideLiveRequestId(managed.liveBinding, key),
            existing: beforeUserIds,
          });
          // A native item can reach a concurrent reader before queue/add's
          // acknowledgement. Match against pre-dispatch IDs, not that reader.
          this.reconcileLivePending(managed, managed.view.items);
          if (managed.livePending!.has(itemId))
            managed.view.items.push({
              id: itemId,
              kind: "user",
              text: input.text,
              status: "queued",
            });
        }
        managed.view.error = undefined;
        this.touch(managed);
        return { ...receipt };
      }
      this.checkNative(
        managed.view.hostId,
        managed.view.provider,
        managed.view.nativeId,
      );
      if (managed.hubId) {
        await this.dependencies.hub.send(managed.hubId, input.text, {
          beforeDispatch: async () => {
            await guard();
            this.binding(managed, input.runtimeId);
            this.checkNative(
              managed.view.hostId,
              managed.view.provider,
              managed.view.nativeId,
            );
            dispatched = true;
          },
        });
        await guard();
        if (!managed.title && !managed.resumed) {
          managed.title = promptTitle(input.text);
          const session = this.dependencies.hub.session(managed.hubId);
          session.title = managed.title;
          this.dependencies.hub.saveSession(session);
          // Persist the title in native history too. This metadata failure must
          // never change a successfully dispatched prompt into a retry.
          void this.dependencies.hub
            .rename?.(managed.hubId, managed.title)
            .catch(() => {});
        }
        this.sync(managed);
        this.touch(managed);
      } else {
        const password = await this.dependencies.password(managed.view.hostId);
        await guard();
        this.binding(managed, input.runtimeId);
        this.checkNative(
          managed.view.hostId,
          managed.view.provider,
          managed.view.nativeId,
        );
        dispatched = true;
        this.startClaude(managed, input, password, async () => {
          await guard();
          this.binding(managed, input.runtimeId);
          this.checkNative(
            managed.view.hostId,
            managed.view.provider,
            managed.view.nativeId,
          );
        });
      }
      receipt.status = "submitted";
      return { ...receipt };
    } catch (error) {
      if (
        !dispatched ||
        (error as { definiteRejection?: boolean })?.definiteRejection
      )
        managed.receipts.delete(key);
      managed.view.error = errorText(error);
      if (!managed.liveBinding && !managed.hubId && !managed.run)
        managed.view.status = "error";
      this.touch(managed);
      throw error;
    } finally {
      managed.sending = false;
    }
  }
  private startClaude(
    managed: Managed,
    input: IdeChatSend,
    password: string | undefined,
    beforeDispatch: Guard,
  ) {
    const view = managed.view;
    view.status = "running";
    view.error = undefined;
    view.items.push({ id: input.requestId, kind: "user", text: input.text });
    if (view.title === "새 대화") view.title = promptTitle(input.text);
    this.touch(managed);
    const run = this.claude({
      host: this.dependencies.host(view.hostId),
      password,
      nativeId: view.nativeId,
      resume: managed.resumed,
      cwd: view.cwd,
      model: view.model,
      text: input.text,
      requestId: input.requestId,
      beforeDispatch,
      events: {
        item: (item) => {
          const index = view.items.findIndex((old) => old.id === item.id);
          if (index < 0) view.items.push(item);
          else view.items[index] = item;
          // History is persisted by the native CLI. Bound live payloads; older
          // native records remain available through the history endpoint.
          if (view.items.length > 1200)
            view.items.splice(0, view.items.length - 1200);
          this.touch(managed);
        },
        native: (nativeId, model) => {
          if (nativeId !== view.nativeId)
            throw new IdeChatError(
              "Claude 대화 ID가 바뀌어 이 연결을 중지했습니다.",
              409,
            );
          managed.resumed = true;
          if (model) view.model = model;
          this.touch(managed);
        },
        approval: (approval) =>
          new Promise((resolve) => {
            managed.pending.set(approval.id, resolve);
            view.approvals.push(approval);
            view.status = "waiting";
            this.touch(managed);
          }),
        removeApproval: (approvalId) => {
          managed.pending.delete(approvalId);
          view.approvals = view.approvals.filter(
            (value) => value.id !== approvalId,
          );
          if (!view.approvals.length && view.status === "waiting")
            view.status = "running";
          this.touch(managed);
        },
      },
    });
    managed.run = run;
    void run.done
      .then(
        () => {
          view.status = "idle";
        },
        (error) => {
          view.status = "error";
          view.error = errorText(error);
        },
      )
      .finally(() => {
        managed.run = undefined;
        for (const resolve of managed.pending.values())
          resolve({ approved: false });
        managed.pending.clear();
        view.approvals = [];
        this.touch(managed);
      });
  }
  async interrupt(id: string, runtimeId: string, guard: Guard) {
    const managed = this.managed(id);
    await guard();
    this.binding(managed, runtimeId);
    this.sync(managed);
    if (managed.liveBinding)
      throw new IdeChatError(
        "진행 중인 작업 중단은 연결된 터미널에서 해 주세요.",
        409,
      );
    if (managed.view.status !== "running" && managed.view.status !== "waiting")
      throw new IdeChatError("진행 중인 답변이 없습니다.", 409);
    this.checkNative(
      managed.view.hostId,
      managed.view.provider,
      managed.view.nativeId,
    );
    if (managed.hubId) await this.dependencies.hub.interrupt(managed.hubId);
    else await managed.run?.interrupt();
    this.touch(managed);
    await guard();
    return this.snapshot(id);
  }
  async answer(
    id: string,
    approvalId: string,
    input: IdeChatAnswer,
    guard: Guard,
  ) {
    input = answerSchema.parse(input);
    const managed = this.managed(id);
    await guard();
    this.binding(managed, input.runtimeId);
    this.sync(managed);
    if (managed.liveBinding)
      throw new IdeChatError(
        "승인이나 질문에 대한 응답은 연결된 터미널에서 진행해 주세요.",
        409,
      );
    this.checkNative(
      managed.view.hostId,
      managed.view.provider,
      managed.view.nativeId,
    );
    const approval = managed.view.approvals.find(
      (value) => value.id === approvalId,
    );
    if (!approval)
      throw new IdeChatError(
        "이 대화에서 대기 중인 승인 요청이 아닙니다.",
        409,
      );
    if (approval.kind === "question" && input.approved !== false) {
      for (const question of approval.questions || [])
        if (!input.answers?.[question.id]?.trim())
          throw new IdeChatError("각 질문의 답변을 입력해 주세요.");
    }
    if (managed.hubId)
      await this.dependencies.hub.answer(managed.hubId, approvalId, input);
    else {
      const resolve = managed.pending.get(approvalId);
      if (!resolve) throw new IdeChatError("승인 요청이 이미 끝났습니다.", 409);
      managed.pending.delete(approvalId);
      resolve({
        approved: input.approved ?? Boolean(input.answers),
        answers: input.answers,
      });
    }
    this.touch(managed);
    await guard();
    return this.snapshot(id);
  }
  async older(id: string, runtimeId: string, guard: Guard) {
    const managed = this.managed(id);
    await guard();
    this.binding(managed, runtimeId);
    this.sync(managed);
    if (!managed.view.historyCursor) return this.snapshot(id);
    if (managed.hubId) await this.dependencies.hub.olderHistory(managed.hubId);
    else {
      const view = managed.view;
      const page =
        managed.liveBinding && this.dependencies.live
          ? await this.dependencies.live.read(
              managed.liveBinding,
              view.historyCursor || undefined,
            )
          : await this.dependencies.historyRead(
              view.hostId,
              view.provider,
              view.nativeId,
              view.historyCursor || undefined,
            );
      await guard();
      this.binding(managed, runtimeId);
      const ids = new Set(view.items.map((item) => item.id));
      view.items = [
        ...page.items.filter((item) => !ids.has(item.id)),
        ...view.items,
      ];
      view.historyCursor = page.nextCursor;
      view.historyNotice = page.notice || view.historyNotice;
      if (managed.liveBinding) managed.liveOlder = true;
      this.touch(managed);
    }
    this.touch(managed);
    await guard();
    return this.snapshot(id);
  }
  close() {
    this.dependencies.hub.off?.("session", this.onSession);
    for (const managed of this.conversations.values()) {
      managed.run?.close();
      for (const resolve of managed.pending.values())
        resolve({ approved: false });
      managed.pending.clear();
    }
  }
}

export interface IdeChatAuthorization {
  hostId: string;
  conversationId?: string;
  write: boolean;
  /** Only mutations of an already-open terminal require its input lease. */
  terminalId?: string;
}
export function createIdeChatRouter(
  chats: IdeChats,
  options: {
    authorize(
      request: Request,
      context: IdeChatAuthorization,
    ): void | Promise<void>;
    actor(request: Request): string;
  },
) {
  const router = Router();
  const route =
    (handler: (req: Request) => Promise<unknown>) =>
    async (req: Request, res: any) => {
      try {
        res.json(await handler(req));
      } catch (error) {
        const status = Number(
          (error as { status?: number; statusCode?: number })?.status ||
            (error as { statusCode?: number })?.statusCode,
        );
        res
          .status(
            error instanceof z.ZodError
              ? 400
              : status >= 400 && status <= 599
                ? status
                : 500,
          )
          .json({ error: errorText(error) });
      }
    };
  const guard =
    (req: Request, hostId: string, write: boolean, conversationId?: string) =>
    async () => {
      const terminalId =
        write && conversationId ? chats.terminalFor(conversationId) : undefined;
      if (terminalId && req.get("X-Harbor-Terminal") !== terminalId)
        throw new IdeChatError("현재 대화의 터미널 연결을 확인해 주세요.", 409);
      await options.authorize(req, {
        hostId,
        conversationId,
        write,
        ...(terminalId ? { terminalId } : {}),
      });
    };
  router.get(
    "/hosts/:hostId/history",
    route(async (req) => {
      const hostId = idSchema.parse(req.params.hostId);
      const provider = providerSchema.parse(req.query.provider);
      const cursor = z.string().max(2048).optional().parse(req.query.cursor);
      const search = z.string().max(300).optional().parse(req.query.query);
      return chats.list(
        hostId,
        provider,
        { cursor, search },
        guard(req, hostId, false),
      );
    }),
  );
  router.post(
    "/conversations",
    route(async (req) => {
      const input = createSchema.parse(req.body);
      return chats.create(
        input,
        options.actor(req),
        guard(req, input.hostId, true),
      );
    }),
  );
  router.get(
    "/conversations/:id",
    route(async (req) => {
      const id = idSchema.parse(req.params.id),
        hostId = chats.hostFor(id);
      return chats.read(id, guard(req, hostId, false, id));
    }),
  );
  router.post(
    "/conversations/:id/messages",
    route(async (req) => {
      const id = idSchema.parse(req.params.id),
        hostId = chats.hostFor(id);
      return chats.send(
        id,
        sendSchema.parse(req.body),
        options.actor(req),
        guard(req, hostId, true, id),
      );
    }),
  );
  router.post(
    "/conversations/:id/interrupt",
    route(async (req) => {
      const id = idSchema.parse(req.params.id),
        hostId = chats.hostFor(id);
      return chats.interrupt(
        id,
        runtimeSchema.parse(req.body).runtimeId,
        guard(req, hostId, true, id),
      );
    }),
  );
  router.post(
    "/conversations/:id/approvals/:approvalId",
    route(async (req) => {
      const id = idSchema.parse(req.params.id),
        hostId = chats.hostFor(id);
      return chats.answer(
        id,
        approvalIdSchema.parse(req.params.approvalId),
        answerSchema.parse(req.body),
        guard(req, hostId, true, id),
      );
    }),
  );
  router.post(
    "/conversations/:id/history",
    route(async (req) => {
      const id = idSchema.parse(req.params.id),
        hostId = chats.hostFor(id);
      return chats.older(
        id,
        runtimeSchema.parse(req.body).runtimeId,
        guard(req, hostId, false, id),
      );
    }),
  );
  return router;
}
