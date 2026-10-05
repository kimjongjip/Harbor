import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import type {
  Activity,
  AppState,
  Approval,
  Discussion,
  HostConfig,
  HostView,
  PermissionMode,
  SessionMeta,
  SessionSummary,
  SessionView,
} from "../shared/types.js";
import { sessionKey } from "../shared/types.js";
import { RpcClient, type RpcMessage } from "./rpc.js";
import { Store } from "./store.js";
import { processCommand } from "./ssh.js";
import { sshCodexChannel } from "./ssh-connect.js";
import { validateImages } from "./images.js";
import {
  appendDelta,
  normalizeItem,
  statusOf,
  transcriptContext,
  upsertItem,
} from "./session.js";

export class Hub extends EventEmitter {
  hosts = new Map<string, HostView>();
  sessions = new Map<string, SessionView>();
  clients = new Map<string, RpcClient>();
  readonly passwords = new Map<string, string>();
  private connecting = new Map<string, Promise<HostView>>();
  private opening = new Map<string, Promise<SessionView>>();
  private sending = new Set<string>();
  private completedTurns = new Set<string>();
  private publishTimers = new Map<string, NodeJS.Timeout>();
  private requestOwners = new Map<
    string,
    { client: RpcClient; sessionId: string; approval: Approval }
  >();
  private jobControllers = new Map<string, AbortController>();
  private stateTimer?: NodeJS.Timeout;
  constructor(readonly store: Store) {
    super();
    for (const h of store.data.hosts)
      this.hosts.set(h.id, { ...h, status: "disconnected", models: [] });
    for (const meta of store.data.sessions)
      this.sessions.set(meta.id, {
        ...meta,
        status: "offline",
        preview: "",
        loaded: false,
        items: [],
        approvals: [],
      });
  }
  state(): Omit<AppState, "terminals"> {
    return {
      hosts: [...this.hosts.values()],
      sessions: [...this.sessions.values()].map(
        ({ items, approvals, historyCursor, ...s }) => s,
      ),
      activities: this.store.data.activities,
      transfers: this.store.data.transfers,
      discussions: this.store.data.discussions,
    };
  }
  changed() {
    if (!this.stateTimer)
      this.stateTimer = setTimeout(() => {
        this.stateTimer = undefined;
        this.emit("state");
      }, 70);
  }
  publish(s: SessionView) {
    if (!this.publishTimers.has(s.id))
      this.publishTimers.set(
        s.id,
        setTimeout(() => {
          this.publishTimers.delete(s.id);
          this.emit("session", s);
        }, 70),
      );
  }
  activity(type: Activity["type"], text: string, sessionId?: string) {
    this.store.activity({
      id: randomUUID(),
      type,
      text,
      at: Date.now(),
      sessionId,
    });
    this.changed();
  }
  host(id: string) {
    const h = this.hosts.get(id);
    if (!h) throw new Error("서버를 찾을 수 없습니다.");
    return h;
  }
  session(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw new Error("세션을 찾을 수 없습니다.");
    return s;
  }
  client(hostId: string) {
    const c = this.clients.get(hostId);
    if (!c?.alive) throw new Error("서버에 먼저 연결하세요.");
    return c;
  }
  saveSession(s: SessionView) {
    const {
      id,
      hostId,
      threadId,
      title,
      cwd,
      model,
      permission,
      createdAt,
      updatedAt,
      imported,
      pinned,
    } = s;
    this.store.session({
      id,
      hostId,
      threadId,
      title,
      cwd,
      model,
      permission,
      createdAt,
      updatedAt,
      imported,
      pinned,
    });
  }
  addHost(input: Omit<HostConfig, "id" | "createdAt">) {
    const host = { ...input, id: randomUUID(), createdAt: Date.now() };
    this.store.data.hosts.push(host);
    this.store.save();
    const view: HostView = { ...host, status: "disconnected", models: [] };
    this.hosts.set(host.id, view);
    this.activity("connection", `${host.name} 서버 등록`);
    return view;
  }
  updateHost(id: string, input: Partial<HostConfig>) {
    const h = this.host(id);
    if (h.status === "connected" || h.status === "connecting")
      throw new Error("서버 설정을 변경하려면 먼저 연결을 해제하세요.");
    const original = this.store.data.hosts.find((x) => x.id === id)!;
    Object.assign(original, input, { id, createdAt: original.createdAt });
    Object.assign(h, original);
    this.store.save();
    this.changed();
    return h;
  }
  connect(id: string, password?: string): Promise<HostView> {
    if (this.host(id).status === "connected")
      return Promise.resolve(this.host(id));
    const existing = this.connecting.get(id);
    if (existing) return existing;
    const promise = this.connectHost(id, password).finally(() =>
      this.connecting.delete(id),
    );
    this.connecting.set(id, promise);
    return promise;
  }
  private async connectHost(id: string, password?: string) {
    const host = this.host(id);
    host.status = "connecting";
    host.error = undefined;
    this.changed();
    let lastError: unknown;
    for (const shared of host.mode === "shared"
      ? [true]
      : host.mode === "isolated"
        ? [false]
        : [true, false]) {
      const client = new RpcClient();
      try {
        if (host.kind === "ssh" && password) {
          const { channel, connection } = await sshCodexChannel(
            host,
            password,
            shared,
          );
          await client.startChannel(channel, connection);
        } else {
          const proc = processCommand(host, shared);
          await client.start(
            proc.command,
            proc.args,
            host.kind === "local" ? process.cwd() : undefined,
          );
        }
        if (password) this.passwords.set(id, password);
        this.clients.set(id, client);
        client.on("notification", (m: RpcMessage) => this.notification(id, m));
        client.on("request", (m: RpcMessage) => this.request(id, client, m));
        client.on("closed", (error: Error) => {
          if (this.clients.get(id) !== client) return;
          this.clients.delete(id);
          host.status = "error";
          host.error = error.message.slice(0, 2000);
          this.passwords.delete(id);
          for (const s of this.sessions.values())
            if (s.hostId === id) {
              s.loaded = false;
              s.status = "offline";
              s.activeTurnId = undefined;
              s.approvals = [];
              this.publish(s);
            }
          for (const [key, owner] of this.requestOwners)
            if (owner.client === client) this.requestOwners.delete(key);
          this.emit("host-closed", id);
          this.changed();
        });
        host.status = "connected";
        host.transport = shared ? "shared" : "isolated";
        try {
          const models = await client.call("model/list", { limit: 100 }, 12000);
          host.models = (models.data || [])
            .filter((m: any) => !m.hidden)
            .map((m: any) => ({
              id: m.model || m.id,
              name: m.displayName || m.model || m.id,
              isDefault: Boolean(m.isDefault),
            }));
        } catch {
          host.models = [];
        }
        await Promise.all(
          [...this.sessions.values()]
            .filter((s) => s.hostId === id)
            .map(async (s) => {
              try {
                const result = await client.call("thread/read", {
                  threadId: s.threadId,
                  includeTurns: false,
                });
                this.hydrateMeta(s, result.thread);
              } catch (error) {
                s.status = "error";
                s.error = errorText(error);
              }
            }),
        );
        this.activity("connection", `${host.name} 연결됨`);
        return host;
      } catch (error) {
        lastError = error;
        client.stop();
      }
    }
    host.status = "error";
    host.error = errorText(lastError).slice(0, 2000);
    this.changed();
    throw new Error(host.error);
  }
  disconnect(id: string) {
    const host = this.host(id);
    if (host.status === "connecting")
      throw new Error("연결 확인이 끝난 뒤 다시 시도하세요.");
    if (
      [...this.sessions.values()].some(
        (s) =>
          s.hostId === id &&
          (s.jobId || ["running", "waiting"].includes(s.status)),
      )
    )
      throw new Error("실행 중인 작업을 먼저 중지한 뒤 연결을 해제하세요.");
    const client = this.clients.get(id);
    this.clients.delete(id);
    client?.stop();
    this.passwords.delete(id);
    this.emit("host-closed", id);
    host.status = "disconnected";
    host.error = undefined;
    for (const s of this.sessions.values())
      if (s.hostId === id) {
        s.loaded = false;
        s.status = "offline";
        this.publish(s);
      }
    for (const [key, owner] of this.requestOwners)
      if (owner.client === client) this.requestOwners.delete(key);
    this.activity("connection", `${host.name} 연결 해제`);
  }
  async discover(hostId: string, cursor?: string, searchTerm?: string) {
    const result = await this.client(hostId).call("thread/list", {
      limit: 50,
      cursor: cursor || null,
      sortKey: "updated_at",
      sourceKinds: ["cli", "vscode", "appServer", "exec"],
      ...(searchTerm ? { searchTerm } : {}),
    });
    return {
      data: (result.data || []).map((t: any) => ({
        id: t.id,
        title: t.name || t.preview?.slice(0, 80) || "제목 없는 세션",
        cwd: t.cwd,
        status: statusOf(t.status),
        updatedAt: t.updatedAt * 1000,
        model: t.model || "",
      })),
      nextCursor: result.nextCursor,
    };
  }
  private track(
    hostId: string,
    thread: any,
    opts: {
      title?: string;
      model?: string;
      permission?: PermissionMode;
      imported?: boolean;
    } = {},
  ) {
    const id = sessionKey(hostId, thread.id);
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const now = Date.now();
    const s: SessionView = {
      id,
      hostId,
      threadId: thread.id,
      title:
        opts.title || thread.name || thread.preview?.slice(0, 70) || "새 세션",
      cwd: thread.cwd || this.host(hostId).defaultCwd,
      model: opts.model || thread.model || "",
      permission: opts.permission || "workspace-write",
      createdAt: thread.createdAt ? thread.createdAt * 1000 : now,
      updatedAt: now,
      imported: opts.imported,
      status: statusOf(thread.status),
      preview: thread.preview || "",
      loaded: false,
      items: [],
      approvals: [],
    };
    this.sessions.set(id, s);
    this.saveSession(s);
    this.changed();
    return s;
  }
  private hydrateMeta(s: SessionView, thread: any) {
    if (!thread) return;
    s.status = statusOf(thread.status);
    if (thread.name) s.title = thread.name;
    if (thread.model) s.model = thread.model;
    if (thread.cwd) s.cwd = thread.cwd;
    s.preview = thread.preview || s.preview;
    if (thread.updatedAt) s.updatedAt = thread.updatedAt * 1000;
    s.error = undefined;
    const active = thread.turns?.find((t: any) => t.status === "inProgress");
    if (active) s.activeTurnId = active.id;
  }
  async createSession(
    hostId: string,
    input: {
      title: string;
      cwd: string;
      model?: string;
      permission: PermissionMode;
    },
  ) {
    const host = this.host(hostId);
    const cwd = input.cwd || host.defaultCwd;
    if (
      !cwd ||
      (host.kind === "ssh" ? !cwd.startsWith("/") : !path.isAbsolute(cwd))
    )
      throw new Error("프로젝트의 절대 경로를 입력하세요.");
    if (host.kind === "local" && !statSync(cwd).isDirectory())
      throw new Error("프로젝트 폴더를 찾을 수 없습니다.");
    const client = this.client(hostId);
    const result = await client.call("thread/start", {
      cwd,
      ...(input.model ? { model: input.model } : {}),
      sandbox: input.permission,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      serviceName: "codex-harbor",
    });
    const s = this.track(hostId, result.thread, input);
    s.loaded = true;
    if (input.title)
      await client
        .call("thread/name/set", { threadId: s.threadId, name: input.title })
        .catch(() => {});
    this.activity("session", `${host.name} · ${s.title} 세션 생성`, s.id);
    return s;
  }
  async importSession(hostId: string, threadId: string) {
    const result = await this.client(hostId).call("thread/read", {
      threadId,
      includeTurns: false,
    });
    return this.track(hostId, result.thread, {
      imported: true,
      permission: "read-only",
    });
  }
  openSession(id: string): Promise<SessionView> {
    const s = this.session(id);
    if (s.loaded && this.clients.get(s.hostId)?.alive)
      return Promise.resolve(s);
    const existing = this.opening.get(id);
    if (existing) return existing;
    const p = this.loadSession(s).finally(() => this.opening.delete(id));
    this.opening.set(id, p);
    return p;
  }
  private async loadSession(s: SessionView) {
    const client = this.client(s.hostId);
    const result = await client.call("thread/resume", {
      threadId: s.threadId,
      excludeTurns: true,
    });
    this.hydrateMeta(s, result.thread);
    try {
      const page = await client.call("thread/turns/list", {
        threadId: s.threadId,
        limit: 30,
        sortDirection: "desc",
        itemsView: "full",
      });
      this.hydrateTurns(s, [...(page.data || [])].reverse());
      s.historyCursor = page.nextCursor;
    } catch {
      const full = await client.call("thread/read", {
        threadId: s.threadId,
        includeTurns: true,
      });
      this.hydrateTurns(s, full.thread?.turns || []);
      s.historyCursor = null;
    }
    s.loaded = true;
    this.changed();
    this.publish(s);
    return s;
  }
  private hydrateTurns(s: SessionView, turns: any[]) {
    const loaded = turns.flatMap((t) =>
      (t.items || []).map((i: any) => normalizeItem(i, t.id)).filter(Boolean),
    );
    const ids = new Set(loaded.map((i) => i.id));
    s.items = [...loaded, ...s.items.filter((i) => !ids.has(i.id))].slice(-600);
    const active = turns.find((t) => t.status === "inProgress");
    if (active) s.activeTurnId = active.id;
  }
  async olderHistory(id: string) {
    const s = this.session(id);
    if (!s.historyCursor) return s;
    const page = await this.client(s.hostId).call("thread/turns/list", {
      threadId: s.threadId,
      cursor: s.historyCursor,
      limit: 20,
      sortDirection: "desc",
      itemsView: "full",
    });
    const older = [...(page.data || [])]
      .reverse()
      .flatMap((t) =>
        (t.items || []).map((i: any) => normalizeItem(i, t.id)).filter(Boolean),
      );
    const ids = new Set(s.items.map((i) => i.id));
    s.items = [...older.filter((i) => !ids.has(i.id)), ...s.items];
    s.historyCursor = page.nextCursor;
    this.publish(s);
    return s;
  }
  async rename(id: string, title: string) {
    const s = this.session(id);
    await this.client(s.hostId).call("thread/name/set", {
      threadId: s.threadId,
      name: title,
    });
    s.title = title;
    this.saveSession(s);
    this.changed();
    this.publish(s);
    return s;
  }
  async fork(id: string, title: string) {
    const source = this.session(id);
    if (["running", "waiting"].includes(source.status))
      throw new Error("작업이 끝난 뒤 대화를 분기하세요.");
    const client = this.client(source.hostId);
    const result = await client.call("thread/fork", {
      threadId: source.threadId,
      excludeTurns: true,
      deferGoalContinuation: true,
    });
    const s = this.track(source.hostId, result.thread, {
      title,
      model: source.model,
      permission: source.permission,
    });
    await this.rename(s.id, title);
    this.activity("session", `${source.title}에서 대화 분기`, s.id);
    return s;
  }
  async send(
    id: string,
    text: string,
    options: {
      mode?: "send" | "steer";
      readOnly?: boolean;
      jobId?: string;
      images?: string[];
    } = {},
  ) {
    const s = this.session(id);
    if (s.jobId && s.jobId !== options.jobId)
      throw new Error(
        "이 세션은 토론에 참여 중입니다. 토론 완료 후 메시지를 보내세요.",
      );
    if (this.sending.has(id)) throw new Error("이전 메시지를 보내는 중입니다.");
    this.sending.add(id);
    try {
      await this.openSession(id);
      const client = this.client(s.hostId);
      const busy = ["running", "waiting"].includes(s.status);
      if (s.status === "waiting")
        throw new Error("대기 중인 승인 또는 질문에 먼저 답하세요.");
      if (busy && options.mode !== "steer")
        throw new Error(
          "작업 중입니다. 방향 수정으로 보내거나 작업이 끝난 뒤 보내세요.",
        );
      const images = validateImages(options.images);
      if (!text.trim() && !images.length)
        throw new Error("메시지 또는 이미지를 입력하세요.");
      const input = [
        ...(text.trim() ? [{ type: "text", text, text_elements: [] }] : []),
        ...images.map((url) => ({ type: "image", url })),
      ];
      let result;
      if (busy) {
        if (!s.activeTurnId)
          throw new Error("진행 중인 작업 정보를 다시 불러온 뒤 시도하세요.");
        result = await client.call("turn/steer", {
          threadId: s.threadId,
          expectedTurnId: s.activeTurnId,
          input,
        });
      } else {
        const readOnly = options.readOnly || s.permission === "read-only";
        result = await client.call("turn/start", {
          threadId: s.threadId,
          input,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: readOnly
            ? { type: "readOnly" }
            : {
                type: "workspaceWrite",
                writableRoots: [s.cwd],
                networkAccess: false,
              },
        });
        if (!this.completedTurns.has(`${s.id}:${result.turn.id}`))
          s.activeTurnId = result.turn.id;
      }
      if (
        !result.turn ||
        !this.completedTurns.has(`${s.id}:${result.turn.id}`)
      ) {
        s.status = s.approvals.length ? "waiting" : "running";
        s.error = undefined;
      }
      s.updatedAt = Date.now();
      this.saveSession(s);
      this.changed();
      this.publish(s);
      return result;
    } finally {
      this.sending.delete(id);
    }
  }
  async interrupt(id: string) {
    const s = this.session(id);
    if (s.jobId) this.cancelDiscussion(s.jobId);
    if (!s.activeTurnId) throw new Error("중지할 실행 중인 작업이 없습니다.");
    await this.client(s.hostId).call("turn/interrupt", {
      threadId: s.threadId,
      turnId: s.activeTurnId,
    });
  }
  private notification(hostId: string, message: RpcMessage) {
    const p = message.params || {};
    const method = message.method;
    const threadId = p.threadId || p.thread?.id;
    if (!threadId) return;
    const s = this.sessions.get(sessionKey(hostId, threadId));
    if (!s) return;
    switch (method) {
      case "thread/status/changed":
        s.status = statusOf(p.status);
        this.changed();
        break;
      case "thread/name/updated":
        s.title = p.threadName || p.name || s.title;
        this.saveSession(s);
        this.changed();
        break;
      case "turn/started":
        s.activeTurnId = p.turn.id;
        s.status = "running";
        s.error = undefined;
        this.changed();
        break;
      case "turn/completed":
        this.completedTurns.add(`${s.id}:${p.turn.id}`);
        if (this.completedTurns.size > 1000)
          this.completedTurns.delete(
            this.completedTurns.values().next().value!,
          );
        s.activeTurnId = undefined;
        s.status = p.turn.status === "failed" ? "error" : "idle";
        if (p.turn.error) s.error = p.turn.error.message;
        s.approvals = [];
        for (const [key, owner] of this.requestOwners)
          if (owner.sessionId === s.id) this.requestOwners.delete(key);
        s.updatedAt = Date.now();
        this.saveSession(s);
        this.changed();
        this.emit("turn-completed", s.id, p.turn);
        break;
      case "item/started":
      case "item/completed": {
        const item = normalizeItem(p.item, p.turnId);
        if (item) upsertItem(s, item);
        break;
      }
      case "item/agentMessage/delta":
        appendDelta(s, p);
        break;
      case "item/commandExecution/outputDelta":
        appendDelta(s, p, true);
        break;
      case "turn/plan/updated":
        upsertItem(s, {
          id: `plan:${p.turnId}`,
          turnId: p.turnId,
          kind: "plan",
          text: (p.plan || [])
            .map(
              (x: any) => `${x.status === "completed" ? "✓" : "○"} ${x.step}`,
            )
            .join("\n"),
        });
        break;
      case "error":
        s.error = p.error?.message || p.message || "실행 오류";
        if (!p.willRetry) s.status = "error";
        this.changed();
        break;
      case "serverRequest/resolved":
        for (const a of s.approvals)
          if (a.requestId === p.requestId) this.requestOwners.delete(a.id);
        s.approvals = s.approvals.filter((a) => a.requestId !== p.requestId);
        if (s.status === "waiting" && !s.approvals.length)
          s.status = s.activeTurnId ? "running" : "idle";
        this.changed();
        break;
      case "thread/closed":
        s.loaded = false;
        if (s.status !== "running") s.status = "idle";
        this.changed();
        break;
    }
    this.publish(s);
  }
  private request(hostId: string, client: RpcClient, m: RpcMessage) {
    const p = m.params || {};
    if (m.method === "currentTime/read") {
      client.respond(m.id!, { currentTimeAt: Math.floor(Date.now() / 1000) });
      return;
    }
    const s = this.sessions.get(
      sessionKey(hostId, p.threadId || p.conversationId),
    );
    // A shared daemon may deliver a request belonging to another client; never decide it here.
    if (!s) return;
    const approval: Approval = {
      id: `${hostId}:${String(m.id)}`,
      requestId: m.id!,
      method: m.method!,
      kind: "unsupported",
      title: "사용자 확인 필요",
      detail: p.reason || "",
    };
    if (
      m.method === "item/commandExecution/requestApproval" ||
      m.method === "execCommandApproval"
    ) {
      approval.kind = "command";
      approval.title = "명령 실행 승인";
      approval.detail = [p.command, p.cwd, p.reason].filter(Boolean).join("\n");
    }
    if (
      m.method === "item/fileChange/requestApproval" ||
      m.method === "applyPatchApproval"
    ) {
      approval.kind = "file";
      approval.title = "파일 변경 승인";
      approval.detail =
        [p.reason, p.grantRoot].filter(Boolean).join("\n") ||
        "이 작업의 파일 변경을 승인할까요?";
    }
    if (m.method === "item/tool/requestUserInput") {
      approval.kind = "question";
      approval.title = "답변이 필요합니다";
      approval.questions = p.questions || [];
    }
    if (m.method === "item/permissions/requestApproval") {
      approval.kind = "permissions";
      approval.title = "추가 권한 요청";
      approval.detail = JSON.stringify(p.permissions || p, null, 2);
    }
    if (approval.kind === "unsupported") {
      client.rejectRequest(
        m.id!,
        "Harbor does not support this request. Continue in the Codex CLI for this action.",
      );
      upsertItem(s, {
        id: randomUUID(),
        kind: "notice",
        text: `이 요청은 Codex CLI에서 처리해 주세요: ${m.method}`,
      });
      this.publish(s);
      return;
    }
    this.requestOwners.set(approval.id, { client, sessionId: s.id, approval });
    if (!s.approvals.some((a) => a.id === approval.id))
      s.approvals.push(approval);
    s.status = "waiting";
    this.changed();
    this.publish(s);
  }
  answer(
    id: string,
    approvalId: string,
    value: { approved?: boolean; answers?: Record<string, string> },
  ) {
    const s = this.session(id);
    const owner = this.requestOwners.get(approvalId);
    if (!owner || owner.sessionId !== id)
      throw new Error("이미 처리되었거나 만료된 요청입니다.");
    const { approval, client } = owner;
    if (approval.kind === "question")
      client.respond(approval.requestId, {
        answers: Object.fromEntries(
          (approval.questions || []).map((q) => [
            q.id,
            { answers: [value.answers?.[q.id] || "답변하지 않음"] },
          ]),
        ),
      });
    else if (approval.kind === "permissions")
      client.respond(approval.requestId, { permissions: {}, scope: "turn" });
    else if (
      ["execCommandApproval", "applyPatchApproval"].includes(approval.method)
    )
      client.respond(approval.requestId, {
        decision: value.approved ? "approved" : "denied",
      });
    else
      client.respond(approval.requestId, {
        decision: value.approved ? "accept" : "decline",
      });
    this.requestOwners.delete(approvalId);
    s.approvals = s.approvals.filter((a) => a.id !== approvalId);
    s.status = s.approvals.length ? "waiting" : "running";
    this.changed();
    this.publish(s);
  }
  async context(id: string) {
    const s = await this.openSession(id);
    return transcriptContext(s);
  }
  async transfer(
    fromId: string,
    toId: string,
    kind: "context" | "review",
    text: string,
  ) {
    if (fromId === toId) throw new Error("다른 대상 세션을 선택하세요.");
    const source = this.session(fromId);
    const target = this.session(toId);
    await this.send(toId, text, { readOnly: kind === "review" });
    this.store.data.transfers.unshift({
      id: randomUUID(),
      fromId,
      toId,
      kind,
      text,
      createdAt: Date.now(),
    });
    this.store.data.transfers = this.store.data.transfers.slice(0, 60);
    this.store.save();
    this.activity(
      "transfer",
      `${source.title} → ${target.title} · ${kind === "review" ? "검토 요청" : "맥락 전달"}`,
      toId,
    );
  }
  async startDiscussion(ids: [string, string], topic: string) {
    if (ids[0] === ids[1]) throw new Error("서로 다른 두 세션을 선택하세요.");
    for (const id of ids) {
      const s = this.session(id);
      if (s.jobId || ["running", "waiting"].includes(s.status))
        throw new Error("두 세션의 작업이 끝난 뒤 토론을 시작하세요.");
      this.client(s.hostId);
    }
    const job: Discussion = {
      id: randomUUID(),
      topic,
      sessionIds: ids,
      status: "running",
      steps: [],
      createdAt: Date.now(),
    };
    for (const id of ids) this.session(id).jobId = job.id;
    const controller = new AbortController();
    this.jobControllers.set(job.id, controller);
    this.store.data.discussions.unshift(job);
    this.store.save();
    this.changed();
    void this.runDiscussion(job, controller.signal);
    return job;
  }
  private async runDiscussion(job: Discussion, signal: AbortSignal) {
    try {
      const [a, b] = job.sessionIds;
      const contexts = await Promise.all(
        job.sessionIds.map((id) => this.context(id)),
      );
      const prompts = [
        {
          id: a,
          label: "첫 번째 관점",
          prompt: `다른 세션과 검토 토론을 진행합니다. 파일을 변경하지 말고 논점, 근거, 위험, 확인할 질문을 간결하게 제시하세요.\n주제: ${job.topic}\n상대 세션의 참고 기록:\n${contexts[1]}`,
        },
        { id: b, label: "상호 검토", prompt: "" },
        { id: a, label: "결론 정리", prompt: "" },
      ];
      for (let i = 0; i < prompts.length; i++) {
        if (signal.aborted) throw new Error("토론이 중지되었습니다.");
        const step = prompts[i];
        if (i === 1)
          step.prompt = `읽기 전용 검토 토론입니다. 파일을 변경하지 마세요.\n주제: ${job.topic}\n첫 번째 세션의 의견:\n${job.steps[0].text}\n\n자신의 작업 맥락을 활용해 동의점, 반론, 검증 방법을 제시하세요.`;
        if (i === 2)
          step.prompt = `읽기 전용 토론을 마무리하세요. 파일을 변경하지 마세요.\n주제: ${job.topic}\n상대 의견:\n${job.steps[1].text}\n\n합의한 결정, 남은 이견, 검증할 항목, 다음 담당 작업을 구분해서 정리하세요. 의견을 검증된 사실로 취급하지 마세요.`;
        const text = await this.runAndWait(
          step.id,
          step.prompt,
          job.id,
          signal,
        );
        job.steps.push({ sessionId: step.id, label: step.label, text });
        this.store.save();
        this.changed();
      }
      job.status = "completed";
      this.activity("discussion", `토론 완료 · ${job.topic}`);
    } catch (error) {
      job.status = signal.aborted ? "cancelled" : "failed";
      job.error = errorText(error);
    } finally {
      for (const id of job.sessionIds) {
        const s = this.sessions.get(id);
        if (s?.jobId === job.id) {
          s.jobId = undefined;
          this.publish(s);
        }
      }
      this.jobControllers.delete(job.id);
      this.store.save();
      this.changed();
    }
  }
  private runAndWait(
    id: string,
    text: string,
    jobId: string,
    signal: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let turnId: string | undefined;
      let settled = false;
      let shouldInterrupt = false;
      const s = this.session(id);
      const stopTurn = () => {
        const client = this.clients.get(s.hostId);
        if (s.activeTurnId && client?.alive)
          void client
            .call("turn/interrupt", {
              threadId: s.threadId,
              turnId: s.activeTurnId,
            })
            .catch(() => {});
      };
      const timer = setTimeout(
        () => {
          shouldInterrupt = true;
          stopTurn();
          fail(new Error("토론 응답 대기 시간이 초과되었습니다."));
        },
        20 * 60 * 1000,
      );
      const cleanup = () => {
        clearTimeout(timer);
        this.off("turn-completed", done);
        this.off("host-closed", disconnected);
        signal.removeEventListener("abort", aborted);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const done = (sessionId: string, turn: any) => {
        if (settled || sessionId !== id || (turnId && turn.id !== turnId))
          return;
        settled = true;
        cleanup();
        if (turn.status !== "completed") {
          reject(
            new Error(turn.error?.message || "토론 응답이 중단되었습니다."),
          );
          return;
        }
        const answer = s.items
          .filter((i) => i.kind === "assistant" && i.turnId === turn.id)
          .map((i) => i.text)
          .join("\n\n");
        if (!answer) reject(new Error("토론 응답이 비어 있습니다."));
        else resolve(answer.slice(-22000));
      };
      const disconnected = (hostId: string) => {
        if (hostId === s.hostId)
          fail(new Error("서버 연결이 끊겨 토론이 중단되었습니다."));
      };
      const aborted = () => {
        shouldInterrupt = true;
        stopTurn();
        fail(new Error("토론이 중지되었습니다."));
      };
      this.on("turn-completed", done);
      this.on("host-closed", disconnected);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) {
        aborted();
        return;
      }
      void this.send(id, text, { readOnly: true, jobId })
        .then((r) => {
          turnId = r.turn?.id;
          if (shouldInterrupt) stopTurn();
        })
        .catch(fail);
    });
  }
  cancelDiscussion(id: string) {
    this.jobControllers.get(id)?.abort();
  }
  shutdown() {
    for (const controller of this.jobControllers.values()) controller.abort();
    for (const client of this.clients.values()) client.stop();
    this.passwords.clear();
    if (this.stateTimer) clearTimeout(this.stateTimer);
    for (const timer of this.publishTimers.values()) clearTimeout(timer);
    this.publishTimers.clear();
  }
}
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
