import {chatEfforts, chatPermissions, type ChatPermission, type ChatEffort} from "../shared/ide-chat.js";
import type {ResearchModel} from "../shared/research.js";
import { validateImages } from "./images.js";
import type { TerminalUsage } from "../shared/terminal-usage.js";
import { mergeClaudeUsage } from "../shared/terminal-usage.js";
import { TerminalAgentRoster } from "./terminal-agent-roster.js";
import type { IdeChatUsage } from "../shared/ide-chat.js";
import {
  ReservationJournal,
  type ReservationReceipt,
  type SavedReservation,
} from "./reservation-journal.js";
import type { ManagedPeers } from "./managed-peers.js";
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
import { worktreeAction, type GitAction } from "./worktree-review.js";
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
  models?(hostId:string,provider:IdeChatProvider):Promise<ResearchModel[]>;
  antigravityAutoAccept?(terminalId:string,nativeId:string):boolean;
  canConfigureAntigravity?(terminalId:string,nativeId:string):boolean;
  configureAntigravity?(terminalId:string,nativeId:string,config:{model?:string;effort?:ChatEffort},guard:()=>Promise<void>):Promise<{model:string;effort?:ChatEffort}>;
  setAntigravityAutoAccept?(terminalId:string,nativeId:string,enabled:boolean):void;
  folders?(hostId:string,path:string):Promise<import("../shared/ide-chat.js").IdeChatFolders>;
  managedClaudeWork?(hostId:string,nativeId:string,processId?:number):Promise<import("../shared/host-insights.js").TerminalWorkSnapshot|null>;
  sessionUsage?(target: Pick<IdeChatConversation,"id"|"hostId"|"provider"|"nativeId"|"cwd">, terminalId?:string):Promise<IdeChatUsage>;
  managedPeers?: ManagedPeers;
  reservationDirectory?: string;
  reservationQuota?(hostId:string, provider:"codex"|"claude", model:string, fresh?:boolean): Promise<{accountKey:string;notBefore?:number}|null>;
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
  worktree?(hostId: string, cwd: string, file?: string): Promise<unknown>;
  gitAction?(
    hostId: string,
    cwd: string,
    input: GitAction,
    guard: Guard,
  ): Promise<unknown>;
  nativeActive(
    hostId: string,
    provider: IdeChatProvider,
    nativeId: string,
  ): boolean;
  claude?: ClaudeChatFactory;
  live?: IdeLiveChats;
  openAntigravity?(
    hostId: string,
    cwd: string | undefined,
    resumeId: string | undefined,
    guard: Guard,
    model?: string,
    options?:{effort?:ChatEffort;autoAccept?:boolean},
  ): Promise<string>;
  antigravityModel?(hostId:string,nativeId:string):Promise<string|undefined>;
}
interface QueuedInput extends SavedReservation {
  guard?: Guard;
  error?: string;
}
interface Managed {
  roster?:TerminalAgentRoster;
  nativeUsage?: TerminalUsage;
  queue?: QueuedInput[];
  reservationReceipts?: ReservationReceipt[];
  draining?: boolean;
  alarm?:{time:number; timer:ReturnType<typeof setTimeout>};
  measuredReset?: {accountKey:string;notBefore:number;measuredAt:number};
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
const providerSchema = z.enum(["codex", "claude", "antigravity"]);
const settingsFields = {
  model: z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/@+\-\[\]]*$/).optional(),
  effort: z.enum(chatEfforts).optional(),
  permission: z.enum(chatPermissions).optional(),
};
const settingsSchema=z.object({runtimeId:idSchema,...settingsFields}).strict();
const createSchema = z
  .object({
    hostId: idSchema,
    provider: providerSchema,
    requestId: requestSchema,
    cwd: z.string().min(1).max(4096).optional(),
    ...settingsFields,
    resumeId: idSchema.optional(),
    reviewOnly: z.boolean().optional(),

  })
  .strict();
const sendSchema = z
  .object({
    runtimeId: idSchema,
    requestId: requestSchema,
    delivery: z.enum(["next", "steer","reset"]).optional(),
    images: z.array(z.string().max(7_000_000)).max(4).optional(),
    text: z
      .string()
      .max(64000)
      .refine((text) => !text.includes("\0")),
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
  private journal?: ReservationJournal;
  private closed = false;
  private readonly conversations = new Map<string, Managed>();
  private readonly native = new Map<string, string>();
  private readonly creations = new Map<
    string,
    { fingerprint: string; promise: Promise<string> }
  >();
  private readonly creatingNative = new Map<string, Promise<string>>();
  private readonly claude: ClaudeChatFactory;
  private readonly onCodexUsage = (session:SessionView, usage:TerminalUsage) => {
    const id=this.native.get(this.nativeKey(session.hostId,"codex",session.threadId));
    const m=id && this.conversations.get(id);
    if(m && m.hubId===session.id && m.view.nativeId===usage.sessionId && m.hostKey===hostKey(this.dependencies.host(session.hostId))) m.nativeUsage=usage;
  };
  private readonly onRosterItem = (s:SessionView,item:unknown) => {
    const id=this.native.get(this.nativeKey(s.hostId,"codex",s.threadId));
    const m=id && this.conversations.get(id);
    if(m && m.hubId===s.id && !m.liveBinding)(m.roster??=new TerminalAgentRoster()).observe(item);
  };
  private readonly onCompact = (session:SessionView) => {
    const id=this.native.get(this.nativeKey(session.hostId,"codex",session.threadId));
    const managed=id && this.conversations.get(id);
    if(managed && managed.hubId===session.id && managed.nativeUsage){
      managed.nativeUsage={...managed.nativeUsage,usedTokens:null,usedPercent:null,updatedAt:Date.now()};
    }
  };
  private readonly onSession = (session: SessionView) => {
    const id = this.native.get(
      this.nativeKey(session.hostId, "codex", session.threadId),
    );
    if (id) {
      const managed = this.managed(id);
      this.touch(managed);
      this.scheduleQueue(managed);
    }
  };
  constructor(readonly dependencies: IdeChatDependencies) {
    this.claude = dependencies.claude || createClaudeChatFactory();
    if (dependencies.reservationDirectory)
      this.journal = new ReservationJournal(dependencies.reservationDirectory);
    dependencies.hub.on?.("session", this.onSession);
    dependencies.hub.on?.("session-usage",this.onCodexUsage);
    dependencies.hub.on?.("session-compacted",this.onCompact);
    dependencies.hub.on?.("session-roster-item",this.onRosterItem);
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
  async usage(id:string,guard:Guard):Promise<IdeChatUsage>{
    const m=this.managed(id);
    await guard();
    this.binding(m,this.dependencies.runtimeId);
    const {hostId,nativeId,provider,cwd}=m.view;
    const v={id,hostId,nativeId,provider,cwd};
    const terminalId=m.liveBinding?.terminalId;
    const stillBound=()=>m.view.nativeId===nativeId && m.view.hostId===hostId && m.view.provider===provider &&
      m.liveBinding?.terminalId===terminalId && (!terminalId || this.dependencies.live?.find(hostId,provider,nativeId)?.terminalId===terminalId);
    if(!stillBound())return {usage:null,work:null};
    const processId = m.run?.processId;
    const [snapshot, managedWork]=await Promise.all([
      this.dependencies.sessionUsage?.(v,terminalId),
      v.provider==="claude" && !terminalId ? this.dependencies.managedClaudeWork?.(v.hostId,v.nativeId,processId) : null,
    ]);
    await guard();
    this.binding(m,this.dependencies.runtimeId);
    if(!stillBound())return {usage:null,work:null};
    const matches=(u:TerminalUsage|null|undefined)=>u?.provider===v.provider && u.sessionId===v.nativeId ? u : null;
    const saved=matches(snapshot?.usage),native=matches(m.nativeUsage);
    let usage=v.provider==="claude" ? mergeClaudeUsage(saved,native) :
      !native || saved && saved.updatedAt>native.updatedAt ? saved :
      {...saved,...native,model:native.model??saved?.model,costUsd:native.costUsd??saved?.costUsd??null};
    const crew=m.roster?.snapshot("native");
    if(crew && (!usage?.crew || crew.updatedAt>=usage.crew.updatedAt)){
      usage={...(usage||{provider:v.provider,sessionId:v.nativeId,usedTokens:null,contextWindow:null,
        usedPercent:null,costUsd:null,updatedAt:crew.updatedAt,source:"native" as const}),crew};
    }
    const sameProcess = processId === undefined || m.run?.processId === processId;
    const work = terminalId || v.provider==="codex" ? snapshot?.work : sameProcess ? managedWork : null;
    return {usage,work:work??null};
  }
  private binding(managed: Managed, runtimeId: string) {
    if (
      this.closed ||
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
    managed.view.contentRevision = (managed.view.contentRevision || 0) + 1;
    managed.view.revision++;
    managed.view.updatedAt = Date.now();
    if (managed.view.peerEnabled)
      this.dependencies.managedPeers?.update(managed.view);
  }
  private sync(managed: Managed) {
    if (managed.liveBinding && this.dependencies.live) {
      const current = this.dependencies.live.get(managed.liveBinding);
      managed.view.live = current.live;
      if(managed.view.provider === "antigravity"){
        managed.view.permission=this.dependencies.antigravityAutoAccept?.(managed.liveBinding.terminalId,managed.view.nativeId)?"auto-accept":"default";
        managed.view.canConfigureNative=!!this.dependencies.canConfigureAntigravity?.(managed.liveBinding.terminalId,managed.view.nativeId);
      }
      managed.view.status = current.status;
      return;
    }
    if (!managed.hubId) return;
    const session = this.dependencies.hub.session(managed.hubId);
    Object.assign(managed.view, {
      nativeId: session.threadId,
      title: managed.title || session.title,
      cwd: session.cwd,
      model: managed.view.configuredModel || session.model,
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
    managed.view.contentRevision ||= 0;
    if (managed.queue)
      managed.view.queue = managed.queue.map(
        ({ id, text, error, guard, state, notBefore }) => ({
          notBefore,
          ...(!guard && state !== "sending"
            ? { needsAuthorization: true }
            : {}),
          id,
          text,
          error,
        }),
      );
    // Never return mutable receipt/approval resolver objects or credentials.
    return structuredClone(managed.view);
  }
  async unchanged(id: string, version: string | undefined, guard: Guard) {
    if (!version) return false;
    await guard();
    const managed = this.managed(id);
    this.binding(managed, this.dependencies.runtimeId);
    return (
      !managed.liveBinding &&
      version ===
        this.dependencies.runtimeId + ":" + (managed.view.contentRevision || 0)
    );
  }
  async worktree(id: string, file: string | undefined, guard: Guard) {
    await guard();
    const managed = this.managed(id);
    this.binding(managed, this.dependencies.runtimeId);
    if (!this.dependencies.worktree)
      throw new IdeChatError("작업 폴더 조회를 지원하지 않습니다.", 409);
    const result = await this.dependencies.worktree(
      managed.view.hostId,
      managed.view.cwd,
      file,
    );
    await guard();
    return result;
  }
  async changeWorktree(id: string, input: GitAction, guard: Guard) {
    const m = this.managed(id);
    const check = async () => {
      await guard();
      this.binding(m, input.runtimeId);
      if (m.view.reviewOnly || m.view.permission === "read-only")
        throw new IdeChatError("읽기 전용 대화입니다.", 403);
      if (
        m.hubId &&
        this.dependencies.hub.session(m.hubId).permission === "read-only"
      )
        throw new IdeChatError("읽기 전용 세션입니다.", 403);
    };
    await check();
    if (!this.dependencies.gitAction)
      throw new IdeChatError("Git 변경을 지원하지 않습니다.", 409);
    return this.dependencies.gitAction(m.view.hostId, m.view.cwd, input, check);
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
    if(input.resumeId && (input.reviewOnly || input.permission || input.effort || input.model)) throw new IdeChatError("기존 대화의 설정은 연결한 뒤 변경하세요.",409);
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
    if (input.reviewOnly && (provider === "antigravity" || (input.permission && input.permission !== "read-only")))
      throw new IdeChatError(
        "선택한 실행 방식에서 이 대화 설정을 지원하지 않습니다.",
        409,
      );
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
    if (!input.resumeId) {await this.validateSettings(hostId,provider,input); await guard();}
    let live =
      input.resumeId &&
      this.dependencies.live?.find(hostId, provider, input.resumeId);
    if (
      !live &&
      provider === "antigravity" &&
      this.dependencies.live &&
      this.dependencies.openAntigravity
    ) {
      await guard();
      const id = await this.dependencies.openAntigravity(
        hostId,
        input.cwd,
        input.resumeId,
        guard,
        input.resumeId ? undefined : input.model,
        {effort:input.effort,autoAccept:input.permission==="auto-accept"},
      );
      live = this.dependencies.live.find(hostId, provider, id);
      if (!live)
        throw new IdeChatError("Antigravity 세션 연결을 확인하세요.", 409);
    }
    if (live && this.dependencies.live) {
      await guard();
      const current = this.dependencies.live.get(live);
      const view: IdeChatConversation = {
        id: randomUUID(),
        runtimeId: this.dependencies.runtimeId,
        hostId,
        provider,
        nativeId: live.nativeId,
        ...(provider==="antigravity"?{effort:input.effort,permission:this.dependencies.antigravityAutoAccept?.(live.terminalId,live.nativeId)?"auto-accept":"default"} as const:{}),
        title: current.terminal?.title || "열린 대화",
        cwd: current.terminal?.cwd || input.cwd || "~",
        model: provider==="antigravity" ? (await this.dependencies.antigravityModel?.(hostId,live.nativeId)) || "" : "",
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
    if (provider === "antigravity")
      throw new IdeChatError(
        "새 터미널에서 Antigravity를 연 뒤 IDE의 ‘현재 터미널 대화’를 선택하세요.",
        409,
      );
    const recovered =
      input.resumeId &&
      this.journal?.read({
        hostId,
        hostKey: originalHostKey,
        provider,
        nativeId: input.resumeId,
      });
    const reviewOnly =
      input.reviewOnly || (!!recovered && recovered.reviewOnly);
    const permission: ChatPermission = reviewOnly ? "read-only" : input.permission || (recovered && recovered.permission) || "default";
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
        session.permission = permission === "read-only" ? "read-only" : "workspace-write";
        this.dependencies.hub.saveSession(session);
      } else
        session = await this.dependencies.hub.createSession(hostId, {
          title: "",
          cwd,
          model: input.model,
          permission: permission === "read-only" ? "read-only" : "workspace-write",
          ...(this.dependencies.managedPeers && !input.reviewOnly
            ? { peerTools: true }
            : {}),
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
      ...(!reviewOnly &&
      this.dependencies.managedPeers &&
      (provider === "claude" || session?.peerTools)
        ? { peerEnabled: false }
        : {}),
      reviewOnly,
      permission,
      configuredModel:input.model ?? (recovered ? recovered.model : undefined),
      effort: input.effort || (recovered ? recovered.effort : undefined),
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
    if (recovered) {
      managed.queue = recovered.entries.map((row) => ({
        ...row,
        error:
          row.state === "sending"
            ? "전송 여부 미확인 · 대화 기록을 확인한 뒤 이 항목을 취소하세요."
            : "복원된 예약 · 계속하려면 다시 승인하세요.",
      }));
      managed.reservationReceipts = recovered.receipts;
      for (const receipt of recovered.receipts)
        managed.receipts.set(receipt.actor + ":" + receipt.requestId, {
          fingerprint: receipt.hash,
          value: { ok: true, requestId: receipt.requestId, status: "queued" },
        });
    }
    if (!input.resumeId && (input.reviewOnly || input.permission || input.model || input.effort)) this.saveQueue(managed,[]);
    this.conversations.set(view.id, managed);
    this.native.set(this.nativeKey(hostId, provider, view.nativeId), view.id);
    return view.id;
  }
  async models(hostId:string,provider:IdeChatProvider,guard:Guard) {
    await guard();
    if (!this.dependencies.models) throw new IdeChatError("서버에서 모델 목록을 제공하지 않습니다.", 409);
    const key = hostKey(this.dependencies.host(hostId));
    const models=await this.dependencies.models(hostId,provider);
    await guard();
    if(key!==hostKey(this.dependencies.host(hostId)))throw new IdeChatError("서버 연결 설정이 변경되었습니다.",409);
    return {models};
  }

  private async validateSettings(hostId:string,provider:IdeChatProvider,settings:Pick<IdeChatCreate,"model"|"effort"|"permission">) {
    const {permission, effort, model} = settings;
    if (permission && permission !== "default" &&
      (permission === "auto-accept" ? provider !== "antigravity" :
       permission === "accept-edits" ? provider !== "claude" : provider === "antigravity"))
      throw new IdeChatError("이 AI 실행 방식에서 지원하지 않는 권한입니다.");
    if (effort && provider!=="codex" && ["ultra","none","minimal"].includes(effort))
      throw new IdeChatError("이 AI가 지원하지 않는 추론 강도입니다.");
    if ((!model && !effort) || !this.dependencies.models) return;
    const list=await this.dependencies.models(hostId,provider);
    const match=model ? list.find(row=>row.id===model || row.resolvedModel===model || (provider==="antigravity" && row.efforts?.some(e=>row.id+"-"+e===model))) : list.find(row=>row.isDefault);
    if (!match || effort && !match.efforts?.includes(effort))
      throw new IdeChatError("이 서버의 모델과 추론 강도 조합을 확인하세요.",409);
  }

  async settings(id:string,input:z.infer<typeof settingsSchema>,guard:Guard) {
    const m=this.managed(id), v=m.view;
    const check=async()=>{
      await guard();
      this.binding(m,input.runtimeId);
      this.sync(m);
      if(v.reviewOnly)throw new IdeChatError("옆 대화의 읽기 전용 설정은 고정되어 있습니다.",409);
      if(!m.liveBinding && (m.sending || m.run || m.draining || v.status==="running" || v.status==="waiting"))
        throw new IdeChatError("진행 중인 작업이 끝난 뒤 설정을 변경하세요.",409);
    };
    await check();
    if(m.liveBinding){
      if(v.provider!=="antigravity" || input.permission && !["default","auto-accept"].includes(input.permission))
        throw new IdeChatError("이 CLI 연결에서 실행 설정을 변경할 수 없습니다.",409);
      if(input.permission && !this.dependencies.setAntigravityAutoAccept) throw new IdeChatError("승인 정책 연결을 확인하세요.",409);
      const engineChange = (input.model !== undefined && input.model!==v.configuredModel && input.model!==v.model) ||
        (input.effort !== undefined && input.effort!==v.effort);
      if(engineChange){
        const configure = this.dependencies.configureAntigravity;
        if (!configure || !v.canConfigureNative || v.status!=="idle") throw new IdeChatError("대기 상태의 Antigravity 설정 연결을 확인하세요.",409);
        await this.validateSettings(v.hostId,v.provider,{...input,model:input.model || v.model});
        await check();
        const confirmed = await configure(m.liveBinding.terminalId, v.nativeId, {model:input.model,effort:input.effort}, async()=>{await guard();this.binding(m,input.runtimeId);});
        v.model=confirmed.model;
        v.configuredModel=input.model || confirmed.model;
        v.effort=confirmed.effort;
        await check();
      }
      if(input.permission) this.dependencies.setAntigravityAutoAccept!(m.liveBinding.terminalId,v.nativeId,input.permission==="auto-accept");
    } else {
      await this.validateSettings(v.hostId,v.provider,input);
      await check();
      this.checkNative(v.hostId,v.provider,v.nativeId);
      const permission=input.permission || "default";
      const previous={model:v.model,configuredModel:v.configuredModel,effort:v.effort,permission:v.permission};
      Object.assign(v,{model:input.model||"",configuredModel:input.model||"",effort:input.effort,permission});
      try { this.saveQueue(m,m.queue || []); }
      catch(error) {Object.assign(v,previous);throw error;}
      if(m.hubId){
        const native=this.dependencies.hub.session(m.hubId);
        native.permission=permission==="read-only"?"read-only":"workspace-write";
        native.model=input.model || "";
        this.dependencies.hub.saveSession(native);
      }
      if(permission==="read-only" && v.peerEnabled){this.dependencies.managedPeers?.pause(v);v.peerEnabled=false;}
    }
    this.touch(m);
    return this.snapshot(id);
  }
  async setCollaboration(
    id: string,
    input: { runtimeId: string; enabled: boolean },
    guard: Guard,
  ) {
    const m = this.managed(id),
      v = m.view,
      peers = this.dependencies.managedPeers;
    await guard();
    this.binding(m, input.runtimeId);
    if (!peers || v.peerEnabled === undefined || v.reviewOnly || v.permission === "read-only" || m.liveBinding)
      throw new IdeChatError("이 대화에서 협업을 사용할 수 없습니다.", 409);
    if (input.enabled) {
      this.checkNative(v.hostId, v.provider, v.nativeId);
      const checked = () => {
        this.binding(m, input.runtimeId);
        this.checkNative(v.hostId, v.provider, v.nativeId);
      };
      peers.enable(
        v,
        checked,
        () => {
          try {
            this.binding(m, input.runtimeId);
            this.checkNative(v.hostId, v.provider, v.nativeId);
            this.sync(m);
            return (
              !!v.peerEnabled &&
              !m.sending &&
              !m.run &&
              !m.queue?.length &&
              v.status === "idle"
            );
          } catch {
            return false;
          }
        },
        async (messageId) => {
          const checked = () => {
            if (!v.peerEnabled)
              throw new IdeChatError("협업이 일시정지되었습니다.", 409);
            this.binding(m, input.runtimeId);
            this.checkNative(v.hostId, v.provider, v.nativeId);
          };
          await this.send(
            id,
            {
              runtimeId: v.runtimeId,
              requestId: messageId,
              text: "Harbor 세션 알림 · harbor_inbox로 도착한 메시지를 확인하세요. 원래 사용자 작업 범위에서 처리하고 질문에는 harbor_reply로 답하세요.",
            },
            "peer",
            checked,
          );
        },
      );
    } else peers.pause(v);
    v.peerEnabled = input.enabled;
    this.touch(m);
    return this.snapshot(id);
  }
  async resetWindow(id:string, guard:Guard){
    const m=this.managed(id),v=m.view;
    await guard();this.binding(m,v.runtimeId);
    if(v.live || v.provider==="antigravity" || !this.dependencies.reservationQuota)return {};
    const q=await this.dependencies.reservationQuota(v.hostId,v.provider,v.model);
    await guard();this.binding(m,v.runtimeId);
    m.measuredReset=q?.notBefore && q.notBefore>Date.now()? {accountKey:q.accountKey,notBefore:q.notBefore,measuredAt:Date.now()} : undefined;
    return {notBefore:m.measuredReset?.notBefore};
  }
  async send(
    id: string,
    input: IdeChatSend,
    actor: string,
    guard: Guard,
  ): Promise<IdeChatReceipt> {
    input = sendSchema.parse(input);
    let images: string[];
    try {
      images = validateImages(input.images);
    } catch (e) {
      throw new IdeChatError(errorText(e));
    }
    if (!input.text.trim() && !images.length)
      throw new IdeChatError("메시지 또는 이미지를 입력하세요.");
    const managed = this.managed(id);
    await guard();
    this.binding(managed, input.runtimeId);
    this.sync(managed);
    const key = `${actor}:${input.requestId}`;
    if (images.length && managed.liveBinding)
      throw new IdeChatError("연결된 터미널의 파일 첨부를 사용하세요.", 409);
    if (images.length && (input.delivery === "next" || input.delivery==="reset"))
      throw new IdeChatError(
        "이미지는 현재 턴에 전송하세요. 다음 턴 예약에는 텍스트를 사용할 수 있습니다.",
        409,
      );
    const hash = fingerprint(
      images.length
        ? [input.text, input.delivery, images]
        : [input.text, input.delivery],
    );
    const prior = managed.receipts.get(key);
    if (prior) {
      if (prior.fingerprint !== hash)
        throw new IdeChatError(
          "같은 요청 ID에 다른 메시지를 보낼 수 없습니다.",
          409,
        );
      return { ...prior.value, duplicate: true };
    }
    const reset=input.delivery==="reset" ? managed.measuredReset : undefined;
    if(input.delivery==="reset" && (managed.liveBinding || managed.view.provider==="antigravity" || !reset ||
      reset.notBefore<=Date.now() || Date.now()-reset.measuredAt>300000))
      throw new IdeChatError("현재 계정에서 확인한 한도 초기화 시각을 갱신하세요.",409);
    if ((input.delivery === "next" || input.delivery==="reset") && !managed.liveBinding) {
      const queue = (managed.queue ||= []);
      if (queue.length >= 20 || managed.receipts.size >= 4000)
        throw new IdeChatError("예약 목록이 가득 찼습니다.", 429);
      const receipts = [
        ...(managed.reservationReceipts || []),
        { actor, requestId: input.requestId, hash },
      ];
      this.saveQueue(
        managed,
        [
          ...queue,
          { id: randomUUID(), text: input.text, guard, actor, state: "queued", ...(reset?{notBefore:reset.notBefore,accountKey:reset.accountKey}:{}) },
        ],
        receipts,
      );
      const receipt: IdeChatReceipt = {
        ok: true,
        requestId: input.requestId,
        status: "queued",
      };
      managed.receipts.set(key, { fingerprint: hash, value: receipt });
      this.touch(managed);
      this.scheduleQueue(managed);
      return { ...receipt };
    }
    const steer = input.delivery === "steer";
    if (steer && (!managed.hubId || managed.view.status !== "running"))
      throw new IdeChatError(
        "진행 중인 Codex 턴에서만 바로 반영할 수 있습니다.",
        409,
      );
    if (
      managed.sending ||
      (!steer &&
        !managed.liveBinding &&
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
        const intendedTurn =
          steer && this.dependencies.hub.session(managed.hubId).activeTurnId;
        let model = managed.view.configuredModel, effort = managed.view.effort;
        if (!steer && model !== undefined && (!model || !effort) && this.dependencies.models) {
          const catalog = await this.dependencies.models(managed.view.hostId,"codex");
          const choice = model ? catalog.find(m=>m.id===model) : catalog.find(m=>m.isDefault);
          if (!choice) throw new IdeChatError("선택한 모델을 서버에서 확인할 수 없습니다.",409);
          model=choice.id;
          effort ??= choice.defaultEffort !== "default" ? choice.defaultEffort : undefined;
        }
        await this.dependencies.hub.send(managed.hubId, input.text, {
          ...(images.length ? { images } : {}),
          ...(steer ? { mode: "steer" } : {}),
          ...(model ? {model} : {}),
          ...(managed.view.reviewOnly || managed.view.permission === "read-only"
            ? { readOnly: true, strictReview: true }
            : {}),
          ...(effort ? {effort} : {}),
          beforeDispatch: async () => {
            await guard();
            this.binding(managed, input.runtimeId);
            if (
              steer &&
              (!intendedTurn ||
                this.dependencies.hub.session(managed.hubId!).activeTurnId !==
                  intendedTurn)
            )
              throw new IdeChatError(
                "작업 턴이 바뀌어 지시를 보내지 않았습니다.",
                409,
              );
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
          managed.title = promptTitle(input.text) || "이미지 첨부";
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
      this.scheduleQueue(managed);
    }
  }
  private saveQueue(
    managed: Managed,
    queue: QueuedInput[],
    receipts = managed.reservationReceipts || [],
  ) {
    const v = managed.view;
    this.journal?.write({
      version: 1,
      scope: {
        hostId: v.hostId,
        hostKey: managed.hostKey,
        provider: v.provider,
        nativeId: v.nativeId,
      },
      reviewOnly: !!v.reviewOnly,
      model:v.configuredModel,
      permission:v.permission,
      effort: v.effort,
      entries: queue.map(({ id, text, actor, state, notBefore,accountKey }) => ({
        notBefore,accountKey,
        id,
        text,
        actor,
        state,
      })),
      receipts,
    });
    managed.queue = queue;
    managed.reservationReceipts = receipts;
  }
  private scheduleQueue(managed: Managed) {
    const first = managed.queue?.[0];
    if(managed.alarm && (first?.notBefore!==managed.alarm.time || !first.guard || first.error)){clearTimeout(managed.alarm.timer);managed.alarm=undefined;}
    if (
      this.closed ||
      !first ||
      !first.guard ||
      first.state !== "queued" ||
      first.error ||
      managed.draining ||
      managed.sending ||
      managed.run ||
      managed.liveBinding
    )
      return;
    this.sync(managed);
    if(first.notBefore && first.notBefore>Date.now()){
      if(managed.alarm?.time!==first.notBefore){
        if(managed.alarm)clearTimeout(managed.alarm.timer);
        const timer=setTimeout(()=>{managed.alarm=undefined;this.scheduleQueue(managed);},Math.min(first.notBefore-Date.now(),2**31-1));
        timer.unref?.(); managed.alarm={time:first.notBefore,timer};
      }
      return;
    }
    if (managed.view.status !== "idle" && !(first.notBefore && managed.view.status==="error")) return;
    managed.draining = true;
    queueMicrotask(async () => {
      try {
        if (this.closed || managed.queue?.[0] !== first || !first.guard) return;
        if(first.notBefore){
          await first.guard(); this.binding(managed,managed.view.runtimeId);
          const v=managed.view, quota=v.provider!=="antigravity" && await this.dependencies.reservationQuota?.(v.hostId,v.provider,v.model,true);
          if(!quota || quota.accountKey!==first.accountKey || quota.notBefore) throw new IdeChatError("한도 초기화 또는 원래 계정이 확인되지 않았습니다. 확인 후 예약을 다시 승인하세요.",409);
          if(this.closed || managed.queue?.[0]!==first)return;
        }
        // Reserve before crossing the native provider boundary. A crash leaves an uncertain row.
        this.saveQueue(managed, [
          { ...first, state: "sending" },
          ...managed.queue.slice(1),
        ]);
        await this.send(
          managed.view.id,
          {
            requestId: first.id,
            runtimeId: managed.view.runtimeId,
            text: first.text,
          },
          first.actor,
          first.guard,
        );
        if (managed.run) await managed.run.done;
        if (!this.closed) this.saveQueue(managed, managed.queue!.slice(1));
      } catch (error) {
        if (!this.closed && managed.queue?.[0]?.id === first.id) {
          const uncertain = managed.receipts.has(first.actor + ":" + first.id);
          const row: QueuedInput = {
            ...first,
            guard: undefined,
            state: uncertain ? "sending" : "blocked",
            error: uncertain
              ? "전송 여부 미확인 · 대화 기록을 확인한 뒤 이 항목을 취소하세요."
              : errorText(error),
          };
          try {
            this.saveQueue(managed, [row, ...managed.queue.slice(1)]);
          } catch {
            managed.queue[0] = row;
            row.error =
              "예약 기록을 저장하지 못했습니다. 전송 상태를 확인하세요.";
          }
        }
      } finally {
        managed.draining = false;
        this.touch(managed);
        this.scheduleQueue(managed);
      }
    });
  }
  async modifyQueue(
    id: string,
    entryId: string,
    input: {
      runtimeId: string;
      expectedText: string;
      action: "remove" | "edit" | "up" | "authorize";
      text?: string;
    },
    guard: Guard,
    actor = "local",
  ) {
    await guard();
    const managed = this.managed(id);
    this.binding(managed, input.runtimeId);
    const queue = [...(managed.queue || [])];
    const index = queue.findIndex((entry) => entry.id === entryId);
    if (
      index < 0 ||
      (managed.draining && index === 0) ||
      queue[index].text !== input.expectedText
    )
      throw new IdeChatError("예약이 변경되었거나 이미 전달됐습니다.", 409);
    if (input.action === "authorize") {
      if (queue[index].guard || queue[index].state === "sending")
        throw new IdeChatError("전송 여부를 먼저 확인하세요.", 409);
      queue[index] = {
        ...queue[index],
        state: "queued",
        error: undefined,
        guard,
        actor,
      };
    } else if (input.action === "remove") queue.splice(index, 1);
    else if (input.action === "up") {
      if (index < 1 || (managed.draining && index === 1))
        throw new IdeChatError("이미 전달 중입니다.", 409);
      [queue[index - 1], queue[index]] = [queue[index], queue[index - 1]];
    } else {
      if (!input.text?.trim() || queue[index].error)
        throw new IdeChatError("편집할 수 없는 예약입니다.", 409);
      queue[index] = { ...queue[index], text: input.text };
    }
    this.saveQueue(managed, queue);
    this.touch(managed);
    this.scheduleQueue(managed);
    return this.snapshot(id);
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
    view.items.push({
      id: input.requestId,
      kind: "user",
      text: input.text,
      ...(input.images?.length ? { imageCount: input.images.length } : {}),
    });
    if (view.title === "새 대화")
      view.title = promptTitle(input.text) || "이미지 첨부";
    this.touch(managed);
    const run = this.claude({
      host: this.dependencies.host(view.hostId),
      password,
      nativeId: view.nativeId,
      resume: managed.resumed,
      cwd: view.cwd,
      model: view.configuredModel ?? view.model,
      effort: view.effort,
      acceptEdits:view.permission==="accept-edits",
      readOnly:view.permission==="read-only",
      reviewOnly: view.reviewOnly,
      ...(view.peerEnabled && !view.reviewOnly && view.permission !== "read-only" && this.dependencies.managedPeers
        ? {
            peerCall: (name: string, args: unknown) =>
              this.dependencies.managedPeers!.call(view, name, args),
          }
        : {}),
      text: input.text,
      images: input.images,
      requestId: input.requestId,
      beforeDispatch,
      events: {
        usage: (u) => { if(u.provider==="claude" && u.sessionId===view.nativeId && !managed.liveBinding) managed.nativeUsage=u; },
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
        this.scheduleQueue(managed);
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
    if (managed.view.reviewOnly && approval.kind !== "question" && input.approved !== false)
      throw new IdeChatError("읽기 전용 대화에서는 실행 권한을 승인할 수 없습니다.",409);
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
  hasActiveWork() {
    return (
      this.creatingNative.size > 0 ||
      [...this.conversations.values()].some(
        (chat) =>
          chat.sending ||
          chat.draining ||
          chat.queue?.some((entry) => entry.guard && !entry.error) ||
          chat.pending.size ||
          chat.livePending?.size ||
          chat.run ||
          ["running", "waiting"].includes(chat.view.status),
      )
    );
  }
  close() {
    this.closed = true;
    this.dependencies.hub.off?.("session", this.onSession);
    this.dependencies.hub.off?.("session-usage",this.onCodexUsage);
    this.dependencies.hub.off?.("session-compacted",this.onCompact);
    this.dependencies.hub.off?.("session-roster-item",this.onRosterItem);
    for (const managed of this.conversations.values()) {
      if (managed.alarm)clearTimeout(managed.alarm.timer);
      if (managed.view.peerEnabled)
        this.dependencies.managedPeers?.pause(managed.view);
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
    gitWrites?(request: Request, conversationId: string): boolean;
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
  router.get("/hosts/:hostId/folders",route(async req=>{
    const hostId=idSchema.parse(req.params.hostId);
    const {path,list}=z.object({path:z.string().max(4096).regex(/^[^\0\r\n]*$/).optional(),list:z.enum(["0","1"]).default("1")}).parse(req.query);
    const validate=guard(req,hostId,false);
    await validate();
    const key=hostKey(chats.dependencies.host(hostId));
    const resolved=await chats.dependencies.resolveCwd(hostId,path);
    await validate();
    if(key!==hostKey(chats.dependencies.host(hostId)))throw new IdeChatError("서버 설정이 변경되었습니다.",409);
    if(list==="0")return {path:resolved,parent:resolved,folders:[],truncated:false};
    if(!chats.dependencies.folders)throw new IdeChatError("이 서버가 폴더 탐색을 지원하지 않습니다.",501);
    const result=await chats.dependencies.folders(hostId,resolved);
    await validate();
    if(key!==hostKey(chats.dependencies.host(hostId)))throw new IdeChatError("서버 설정이 변경되었습니다.",409);
    return result;
  }));
  router.get("/hosts/:hostId/models",route(async req=>{
    const id=idSchema.parse(req.params.hostId);
    return chats.models(id,providerSchema.parse(req.query.provider),guard(req,id,false));
  }));
  router.post("/conversations/:id/settings",route(async req=>{
    const id=idSchema.parse(req.params.id);
    return chats.settings(id,settingsSchema.parse(req.body),guard(req,chats.hostFor(id),true,id));
  }));
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
    "/conversations/:id/worktree",
    route(async (req) => {
      const id = idSchema.parse(req.params.id);
      const review = await chats.worktree(
        id,
        z.string().min(1).max(4096).optional().parse(req.query.file),
        guard(req, chats.hostFor(id), false, id),
      );
      return {
        ...(review as object),
        writesAvailable: !!options.gitWrites?.(req, id),
      };
    }),
  );
  router.post(
    "/conversations/:id/worktree",
    route(async (req) => {
      const id = idSchema.parse(req.params.id),
        input = worktreeAction.parse(req.body);
      const auth = guard(req, chats.hostFor(id), true, id);
      return chats.changeWorktree(id, input, async () => {
        await auth();
        if (!options.gitWrites?.(req, id))
          throw new IdeChatError("이 기기의 Git 쓰기 권한을 확인하세요.", 403);
      });
    }),
  );
  router.get(
    "/conversations/:id",
    route(async (req) => {
      const id = idSchema.parse(req.params.id),
        hostId = chats.hostFor(id);
      const readGuard = guard(req, hostId, false, id);
      if (
        await chats.unchanged(id, req.get("X-Harbor-Chat-Revision"), readGuard)
      )
        return { unchanged: true };
      return chats.read(id, readGuard);
    }),
  );
  router.get("/conversations/:id/usage",route(async req=>{const id=idSchema.parse(req.params.id);return chats.usage(id,guard(req,chats.hostFor(id),false,id));}));
  router.get("/conversations/:id/rate-reset",route(async req=>{const id=idSchema.parse(req.params.id);return chats.resetWindow(id,guard(req,chats.hostFor(id),false,id));}));
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
    "/conversations/:id/collaboration",
    route(async (req) => {
      const id = idSchema.parse(req.params.id);
      const input = z
        .object({ runtimeId: idSchema, enabled: z.boolean() })
        .strict()
        .parse(req.body);
      return chats.setCollaboration(
        id,
        input,
        guard(req, chats.hostFor(id), true, id),
      );
    }),
  );
  router.post(
    "/conversations/:id/queue/:entry",
    route(async (req) => {
      const id = idSchema.parse(req.params.id);
      const input = z
        .object({
          runtimeId: idSchema,
          expectedText: sendSchema.shape.text,
          action: z.enum(["edit", "remove", "up", "authorize"]),
          text: sendSchema.shape.text
            .refine((value) => Boolean(value.trim()))
            .optional(),
        })
        .strict()
        .parse(req.body);
      return chats.modifyQueue(
        id,
        idSchema.parse(req.params.entry),
        input,
        guard(req, chats.hostFor(id), true, id),
        options.actor(req),
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
