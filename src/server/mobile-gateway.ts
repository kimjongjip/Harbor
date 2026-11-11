import express from "express";
import compression from "compression";
import { constants as zlibConstants } from "node:zlib";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import { resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { MobileAccess } from "./mobile-access.js";
import { MobileCompletions } from "./mobile-completion.js";
import { TerminalControl } from "./terminal-control.js";
import {
  createEditorRouter,
  EditorError,
  type EditorFiles,
} from "./editor-files.js";
import { answerSchema } from "./requests.js";
import {
  createIdeChatRouter,
  IdeChatError,
  type IdeChats,
} from "./ide-chat.js";
import {
  createIdeConversationRouter,
  type IdeConversations,
} from "./ide-conversation.js";
import {
  ANNOTATION_TEXT_LIMIT,
  ANNOTATION_COMMENT_LIMIT,
} from "../shared/annotations.js";
import type { MobileState, MobileConversationPage } from "../shared/mobile.js";
import type { TerminalReplayMetadata } from "../shared/types.js";

export interface MobileOperations {
  desktop?: {
    http: express.RequestHandler;
    upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
    revoke(id?: string): void;
  };
  editor?: EditorFiles;
  ide?: IdeConversations;
  ideChat?: IdeChats;
  resize?(id: string, cols: number, rows: number): void;
  annotate?(id: string, text: string, comment: string): { reference: string };
  state(): MobileState;
  snapshot(
    id: string,
  ): Promise<{ data: string; replay: TerminalReplayMetadata }>;
  write(id: string, data: string): void;
  answer(id: string, answer: z.infer<typeof answerSchema>): unknown;
  upload(id: string, name: string, input: Readable): Promise<unknown>;
  answers(id: string): unknown;
  conversation?(
    id: string,
    sessionId: string,
    cursor?: string,
    options?: { includeActivity?: boolean },
  ): Promise<MobileConversationPage>;
}
type View = {
  deviceId: string;
  terminalId?: string;
  generation: number;
  subscriptionId?: string;
  pending?: string[];
  bytes: number;
  lastPong: number;
};
const uuid = z.string().uuid();
const keyValues = {
  Enter: "\r",
  Escape: "\x1b",
  Tab: "\t",
  "Ctrl+C": "\x03",
  Up: "\x1b[A",
  Down: "\x1b[B",
  Left: "\x1b[D",
  Right: "\x1b[C",
};
export class MobileGateway {
  private server?: Server;
  private sockets?: WebSocketServer;
  private views = new Map<WebSocket, View>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private broadcastTimer?: ReturnType<typeof setTimeout>;
  private receipts = new Map<
    string,
    { body: string; at: number; written: boolean; settled?: Promise<void> }
  >();
  private pendingInputs = new Set<string>();
  private previous?: MobileState;
  private changing = false;
  private uploads = 0;
  private previews = new Set<string>();
  readonly completions: MobileCompletions;
  readonly controls: TerminalControl;
  error = "";
  constructor(
    readonly access: MobileAccess,
    private operations: MobileOperations,
    private assets = resolve("dist/client"),
  ) {
    this.controls = new TerminalControl(
      (id) => {
        const s = this.operations.state(),
          t = s.terminals.find(
            (t) =>
              t.id === id && !t.exited && t.connectionState === "connected",
          );
        return t
          ? JSON.stringify([
              s.runtimeId,
              t.id,
              t.hostId,
              t.agentKind,
              t.agentSessionId,
              t.resumeThreadId,
            ])
          : undefined;
      },
      () => this.changed(),
    );
    this.completions = new MobileCompletions(
      () => this.operations.state(),
      (id, key) => {
        if (this.server?.listening)
          void this.access.notify(
            "Harbor · 답변 완료",
            "AI 답변이 완료되었습니다. 눌러서 해당 세션을 확인하세요.",
            id,
            undefined,
            key,
          );
      },
    );
  }
  view() {
    return {
      ...this.access.view(),
      listening: !!this.server?.listening,
      error: this.error || this.access.loadError || undefined,
    };
  }
  async configure(
    enabled: boolean,
    origin: string,
    port: number,
    mode = this.access.config.mode,
  ) {
    if (this.changing)
      throw new Error("설정 변경 중입니다. 잠시 후 다시 시도하세요.");
    this.changing = true;
    try {
      this.access.configure(enabled, origin, port, mode);
      await this.stop();
      await this.start();
    } finally {
      this.changing = false;
    }
    return this.view();
  }
  revoke(id: string) {
    this.controls.revoke(id);
    this.access.revoke(id);
    this.operations.desktop?.revoke(id);
    for (const [socket, v] of this.views)
      if (v.deviceId === id) socket.close(4001, "Device revoked");
  }
  private stateFor(deviceId: string): MobileState {
    const state = this.operations.state(),
      device = this.access.config.devices.find((d) => d.id === deviceId);
    const terminals = state.terminals.filter((t) => !t.exited),
      ids = new Set(terminals.map((t) => t.id));
    return {
      ...state,
      terminals,
      hosts:
        device?.kind === "desktop"
          ? state.hosts
          : state.hosts.filter((h) => terminals.some((t) => t.hostId === h.id)),
      labs: [],
      requests: state.requests.filter(
        (r) => !!r.terminal.terminalId && ids.has(r.terminal.terminalId),
      ),
      controls: this.controls.views(),
      viewer: device
        ? { deviceId, name: device.name, kind: device.kind }
        : undefined,
    };
  }
  private checkIdentity(
    id: string,
    input: { runtimeId: string; sessionId?: string },
  ) {
    const state = this.operations.state(),
      t = state.terminals.find(
        (t) => t.id === id && !t.exited && t.connectionState === "connected",
      );
    if (
      !t ||
      input.runtimeId !== state.runtimeId ||
      input.sessionId !== t.agentSessionId
    )
      throw Object.assign(
        new Error("세션이 변경되었습니다. 화면을 다시 연결하세요."),
        { status: 409 },
      );
  }
  private validHost(host?: string) {
    return host === new URL(this.access.config.origin).host;
  }
  private readerBinding(id: string) {
    const state = this.operations.state();
    const terminal = state.terminals.find((t) => t.id === id && !t.exited);
    if (!terminal)
      throw Object.assign(new Error("열려 있는 세션만 사용할 수 있습니다."), {
        status: 404,
      });
    return JSON.stringify([
      state.runtimeId,
      terminal.id,
      terminal.hostId,
      terminal.agentKind,
      terminal.agentSessionId,
      terminal.resumeThreadId,
    ]);
  }
  private authenticated(
    request: express.Request,
    expectedId?: string,
    desktop = false,
  ) {
    const device = this.access.authenticate(request.headers.cookie);
    if (!device || (expectedId && device.id !== expectedId))
      throw new EditorError(
        401,
        "DEVICE_REVOKED",
        "기기 연결이 해제되었습니다. 다시 등록하세요.",
      );
    if (desktop && device.kind !== "desktop")
      throw new EditorError(
        403,
        "DESKTOP_REQUIRED",
        "PC용 연결 링크로 등록하세요.",
      );
    return device;
  }
  private deviceActive(deviceId: string) {
    return (
      this.access.config.enabled &&
      this.access.config.devices.some(
        (device) => device.id === deviceId && device.expiresAt > Date.now(),
      )
    );
  }
  private send(socket: WebSocket, event: unknown) {
    if (socket.readyState !== WebSocket.OPEN) return;
    const view = this.views.get(socket);
    if (view && !this.deviceActive(view.deviceId)) {
      socket.close(4001, "Device revoked");
      return;
    }
    if (socket.bufferedAmount > 8 * 1024 * 1024) {
      socket.close(1013, "Reconnect for snapshot");
      return;
    }
    socket.send(typeof event === "string" ? event : JSON.stringify(event));
  }
  output(id: string, data: string) {
    this.terminalEvent(id, { type: "data", id, data });
  }
  resize(id: string, cols: number, rows: number) {
    this.terminalEvent(id, { type: "resize", id, cols, rows });
  }
  private terminalEvent(id: string, event: unknown) {
    for (const [socket, v] of this.views) {
      if (v.terminalId !== id) continue;
      if (!this.deviceActive(v.deviceId)) {
        socket.close(4001, "Device revoked");
        continue;
      }
      const encoded = JSON.stringify({
        ...(event as object),
        subscriptionId: v.subscriptionId,
      });
      if (v.pending) {
        v.bytes += encoded.length;
        if (v.bytes > 8 * 1024 * 1024) {
          socket.close(1013, "Snapshot overflow");
          continue;
        }
        v.pending.push(encoded);
      } else this.send(socket, encoded);
    }
  }
  changed() {
    if (!this.server?.listening || this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = undefined;
      const state = this.operations.state();
      for (const [socket, view] of this.views)
        this.send(socket, {
          type: "state",
          state: this.stateFor(view.deviceId),
          protocol: 4,
        });
      if (this.previous) {
        const oldRequests = new Set(this.previous.requests.map((r) => r.id));
        for (const r of state.requests)
          if (r.status === "pending" && !oldRequests.has(r.id))
            void this.access.notify(
              "Harbor · 확인 필요",
              "세션에서 승인 또는 답변을 기다립니다.",
              r.terminal.terminalId,
            );
      }
      this.previous = structuredClone(state);
    }, 100);
  }
  async start() {
    if (!this.access.config.enabled || this.server) return;
    this.error = "";
    this.previous = structuredClone(this.operations.state());
    const app = express();
    app.disable("x-powered-by");
    app.use((req, res, next) => {
      if (
        req.headers["tailscale-funnel-request"] &&
        this.access.config.mode !== "funnel"
      ) {
        res.sendStatus(403);
        return;
      }
      if (
        !this.validHost(req.headers.host) ||
        (req.headers.origin &&
          req.headers.origin !== this.access.config.origin &&
          !(
            req.path.startsWith("/html-preview/") &&
            req.headers.origin === "null" &&
            ["GET", "HEAD"].includes(req.method)
          ))
      ) {
        res.sendStatus(403);
        return;
      }
      res.set({
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data: blob:; img-src 'self' https: data: blob:; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; connect-src 'self' ${this.access.config.origin.replace("https:", "wss:")}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
      });
      if (
        !["GET", "HEAD"].includes(req.method) &&
        (req.headers.origin !== this.access.config.origin ||
          (req.path.startsWith("/api/")
            ? req.headers["x-harbor-token"] !== "desktop"
            : req.headers["x-harbor-mobile"] !== "1"))
      ) {
        res.sendStatus(403);
        return;
      }
      next();
    });
    // Use the very same workbench APIs as the host, behind desktop-only pairing.
    // Do this before the smaller mobile JSON parser (uploads must remain streams).
    app.use((req, res, next) => {
      if (
        !req.path.startsWith("/api/") &&
        !req.path.startsWith("/html-preview/")
      )
        return next();
      if (!this.operations.desktop) {
        res
          .status(404)
          .json({ error: "호스트 Harbor를 업데이트한 뒤 정상 재실행하세요." });
        return;
      }
      this.operations.desktop.http(req, res, next);
    });
    app.use((req, res, next) =>
      express.json({
        limit: req.path.startsWith("/desktop-api/editor/") ? "12mb" : "96kb",
        strict: false,
      })(req, res, next),
    );
    app.post("/mobile-api/pair", (req, res) => {
      const { code, name } = z
        .object({
          code: z.string().min(20).max(100),
          name: z.string().min(1).max(80),
        })
        .parse(req.body);
      const { token } = this.access.pair(code, name);
      res.setHeader(
        "Set-Cookie",
        `harbor_mobile=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=7776000`,
      );
      res.json({ ok: true });
    });
    app.use(["/mobile-api", "/desktop-api"], (req, res, next) => {
      const device = this.access.authenticate(req.headers.cookie);
      if (!device) {
        res
          .status(401)
          .json({ error: "PC에서 기기 연결 링크를 만들어 등록하세요." });
        return;
      }
      res.locals.deviceId = device.id;
      res.locals.device = device;
      next();
    });
    app.use("/desktop-api", (_req, res, next) => {
      if (res.locals.device.kind !== "desktop") {
        res.status(403).json({ error: "PC용 연결 링크로 등록하세요." });
        return;
      }
      next();
    });
    if (this.operations.ideChat)
      app.use(
        "/desktop-api/ide-chat",
        createIdeChatRouter(this.operations.ideChat, {
          authorize: (req, { hostId, terminalId, write }) => {
            try {
              const device = this.authenticated(req, undefined, true);
              if (write && terminalId) {
                if (req.get("X-Harbor-Terminal") !== terminalId)
                  throw new IdeChatError(
                    "대화의 터미널 연결이 바뀌었습니다.",
                    409,
                  );
                this.controls.assert(
                  terminalId,
                  device.id,
                  req.get("X-Harbor-Client"),
                  req.get("X-Harbor-Control"),
                );
              }
            } catch (error) {
              if (error instanceof EditorError)
                throw new IdeChatError(error.message, error.status);
              if (
                error instanceof Error &&
                "status" in error &&
                error.status === 409
              )
                throw new IdeChatError(error.message, 409);
              throw error;
            }
            if (
              !this.operations.state().hosts.some((host) => host.id === hostId)
            )
              throw new IdeChatError("서버를 찾을 수 없습니다.", 404);
          },
          actor: (req) => this.authenticated(req, undefined, true).id,
        }),
      );
    if (this.operations.ide)
      app.use(
        "/desktop-api/ide",
        createIdeConversationRouter(this.operations.ide, {
          authorize: (req, id, write) => {
            const device = this.authenticated(req, undefined, true);
            if (write)
              this.controls.assert(
                id,
                device.id,
                req.get("X-Harbor-Client"),
                req.get("X-Harbor-Control"),
              );
          },
          actor: (req) => this.authenticated(req, undefined, true).id,
        }),
      );
    if (this.operations.editor)
      app.use(
        "/desktop-api/editor",
        createEditorRouter(this.operations.editor, {
          authorize: (req, id, write) => {
            const device = this.authenticated(req, undefined, true);
            if (
              !this.operations
                .state()
                .terminals.some((t) => t.id === id && !t.exited)
            )
              throw new EditorError(
                404,
                "EDITOR_TERMINAL_MISSING",
                "열려 있는 세션만 사용할 수 있습니다.",
              );
            if (write) {
              try {
                this.controls.assert(
                  id,
                  device.id,
                  req.get("X-Harbor-Client"),
                  req.get("X-Harbor-Control"),
                );
              } catch {
                throw new EditorError(
                  403,
                  "CONTROL_REQUIRED",
                  "제어권을 가져온 뒤 다시 저장하세요. 편집 내용은 유지됩니다.",
                );
              }
            }
          },
        }),
      );
    app.get("/mobile-api/state", (_req, res) =>
      res.json(this.stateFor(res.locals.deviceId)),
    );
    app.post("/mobile-api/terminals/:id/control", (req, res) => {
      const id = uuid.parse(req.params.id);
      const input = z
        .object({
          action: z.enum(["claim", "renew", "release"]),
          clientId: uuid,
          token: uuid.optional(),
          fresh: z.boolean().optional(),
          runtimeId: uuid,
          sessionId: z.string().optional(),
          takeover: z.boolean().optional(),
        })
        .strict()
        .parse(req.body);
      this.checkIdentity(id, input);
      res.json(
        this.controls.change(
          id,
          res.locals.deviceId,
          res.locals.device.name,
          input,
        ),
      );
    });
    app.post("/desktop-api/terminals/:id/resize", (req, res) => {
      const id = uuid.parse(req.params.id),
        input = z
          .object({
            runtimeId: uuid,
            sessionId: z.string().optional(),
            clientId: uuid,
            controlToken: uuid,
            cols: z.number().int().min(10).max(500),
            rows: z.number().int().min(3).max(200),
          })
          .strict()
          .parse(req.body);
      this.checkIdentity(id, input);
      this.controls.assert(
        id,
        res.locals.deviceId,
        input.clientId,
        input.controlToken,
      );
      if (!this.operations.resize)
        throw new Error("크기 변경을 지원하지 않습니다.");
      this.operations.resize(id, input.cols, input.rows);
      res.json({ ok: true });
    });
    app.post("/desktop-api/terminals/:id/annotation", (req, res) => {
      const id = uuid.parse(req.params.id);
      const input = z
        .object({
          runtimeId: uuid,
          sessionId: z.string().max(256).optional(),
          clientId: uuid,
          controlToken: uuid,
          text: z.string().trim().min(1).max(ANNOTATION_TEXT_LIMIT),
          comment: z.string().trim().min(1).max(ANNOTATION_COMMENT_LIMIT),
        })
        .strict()
        .parse(req.body);
      this.checkIdentity(id, input);
      this.controls.assert(
        id,
        res.locals.deviceId,
        input.clientId,
        input.controlToken,
      );
      if (!this.operations.annotate)
        throw Object.assign(
          new Error("번호 인용 연결이 준비되지 않았습니다."),
          { status: 409 },
        );
      res.json(this.operations.annotate(id, input.text, input.comment));
    });
    app.get("/mobile-api/terminals/:id/preview", async (req, res) => {
      const id = uuid.parse(req.params.id),
        deviceId = res.locals.deviceId as string;
      const input = z
        .object({ runtimeId: uuid, sessionId: z.string().max(256) })
        .parse(req.query);
      const matches = () => {
        const state = this.operations.state();
        return (
          state.runtimeId === input.runtimeId &&
          state.terminals.some(
            (t) =>
              t.id === id &&
              !t.exited &&
              t.connectionState === "connected" &&
              (t.agentSessionId || t.resumeThreadId || "") === input.sessionId,
          )
        );
      };
      if (!matches()) {
        res.status(409).json({ error: "세션이 변경되었습니다." });
        return;
      }
      if (this.previews.has(deviceId) || this.previews.size >= 2) {
        res.status(429).json({ error: "화면 준비 중입니다." });
        return;
      }
      this.previews.add(deviceId);
      // Keep the slot until the underlying read settles, even if the phone cancels.
      const read = Promise.resolve()
        .then(() => this.operations.snapshot(id))
        .finally(() => this.previews.delete(deviceId));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const snapshot = await Promise.race([
          read,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("화면 준비 시간 초과")),
              8000,
            );
            timer.unref();
          }),
        ]);
        if (res.destroyed) return;
        if (!this.access.authenticate(req.headers.cookie)) {
          res.sendStatus(401);
          return;
        }
        if (!matches()) {
          res.status(409).json({ error: "세션이 변경되었습니다." });
          return;
        }
        if (snapshot.data.length > 2_000_000) {
          res.status(413).json({ error: "실시간 연결에서 화면을 불러옵니다." });
          return;
        }
        res.json({
          ...snapshot,
          runtimeId: input.runtimeId,
          terminalId: id,
          sessionId: input.sessionId,
        });
      } finally {
        clearTimeout(timer);
      }
    });
    app.post("/mobile-api/input", async (req, res) => {
      const input = z
        .object({
          requestId: uuid,
          runtimeId: uuid,
          terminalId: uuid,
          sessionId: z.string().optional(),
          clientId: uuid.optional(),
          controlToken: uuid.optional(),
          raw: z.string().min(1).max(16000).optional(),
          text: z.string().max(32000).optional(),
          key: z
            .enum([
              "Enter",
              "Escape",
              "Tab",
              "Ctrl+C",
              "Up",
              "Down",
              "Left",
              "Right",
            ])
            .optional(),
          submit: z.boolean().default(false),
          bracketed: z.boolean().default(true),
        })
        .strict()
        .parse(req.body);
      const state = this.operations.state();
      if (input.runtimeId !== state.runtimeId)
        throw new Error(
          "Harbor가 다시 시작됐습니다. 화면을 다시 연결하고 입력을 확인하세요.",
        );
      const receiptKey = `${res.locals.deviceId}:${input.requestId}`,
        body = JSON.stringify(input);
      for (const [key, value] of this.receipts)
        if (Date.now() - value.at > 86400000) this.receipts.delete(key);
      const receipt = this.receipts.get(receiptKey);
      if (receipt) {
        if (receipt.body !== body)
          throw new Error("같은 요청 번호에 다른 입력을 보낼 수 없습니다.");
        // A duplicate may arrive between a native paste and its submit key.
        // It observes the original result; it must never send either part again.
        if (receipt.settled) await receipt.settled;
        if (!receipt.written)
          throw new Error(
            "이 입력의 전송 결과가 불확실합니다. 터미널에서 확인하세요.",
          );
        res.json({ ok: true, duplicate: true });
        return;
      }
      if (this.receipts.size >= 10000)
        throw new Error("오늘의 모바일 입력 한도에 도달했습니다.");
      const terminal = state.terminals.find(
        (t) => t.id === input.terminalId && !t.exited,
      );
      if (!terminal || terminal.connectionState !== "connected")
        throw new Error("연결된 터미널을 선택하세요.");
      if (terminal.agentSessionId !== input.sessionId)
        throw new Error("대화가 변경됐습니다. 현재 세션을 확인하세요.");
      this.controls.assert(
        input.terminalId,
        res.locals.deviceId,
        input.clientId,
        input.controlToken,
        res.locals.device.kind === "mobile",
      );
      if (
        input.raw !== undefined &&
        (res.locals.device.kind !== "desktop" ||
          !input.clientId ||
          !input.controlToken)
      )
        throw new Error("PC 제어권이 필요합니다.");
      if (
        [input.text, input.key, input.raw].filter((v) => v !== undefined)
          .length !== 1
      )
        throw new Error("텍스트 또는 특수키 하나를 보내세요.");
      if (this.pendingInputs.has(input.terminalId))
        throw Object.assign(
          new Error(
            "이전 메시지를 전송 중입니다. 전송 결과를 확인한 뒤 다시 입력하세요.",
          ),
          { status: 409 },
        );
      // Do not allow paste text to break out of bracketed paste into terminal control sequences.
      const text = (input.text || "")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
        .replace(/\r\n?/g, "\n");
      if (!input.key && !input.bracketed && text.includes("\n"))
        throw new Error(
          "현재 프로그램이 여러 줄 붙여넣기를 지원하지 않습니다. 한 줄씩 보내세요.",
        );
      const separatedSubmit =
        process.platform === "win32" &&
        res.locals.device.kind === "mobile" &&
        input.text !== undefined &&
        input.submit &&
        !!text &&
        ["codex", "claude"].includes(terminal.agentKind || "") &&
        state.hosts.some(
          (host) => host.id === terminal.hostId && host.kind === "local",
        );
      const data =
        input.raw !== undefined
          ? input.raw
          : input.key
            ? keyValues[input.key]
            : `${input.bracketed ? `\x1b[200~${text}\x1b[201~` : text}${input.submit && !separatedSubmit ? "\r" : ""}`;
      const binding = this.readerBinding(input.terminalId);
      const server = this.server;
      // Pin the lease even for legacy mobile senders. Releasing and claiming
      // the same terminal again must not authorize this pending submit.
      const legacyLease =
        separatedSubmit && !input.clientId && !input.controlToken
          ? this.controls.change(
              input.terminalId,
              res.locals.deviceId,
              "휴대폰",
              {
                clientId: "legacy",
                action: "renew",
              },
            ).token
          : undefined;
      // Reserve before writing: an uncertain acknowledgement is never replayed automatically.
      let settle!: () => void;
      const reserved = {
        body,
        at: Date.now(),
        written: false,
        settled: new Promise<void>((resolve) => {
          settle = resolve;
        }),
      };
      this.receipts.set(receiptKey, reserved);
      this.pendingInputs.add(input.terminalId);
      try {
        this.operations.write(input.terminalId, data);
        if (separatedSubmit) {
          // ConPTY/native Windows CLI paste-burst handling can consume Enter
          // delivered in the same write as the pasted text. Let that burst end,
          // then revalidate every authority before sending the one submit key.
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
          if (
            this.server !== server ||
            !server?.listening ||
            !this.deviceActive(res.locals.deviceId)
          )
            throw new Error(
              "기기 연결이 변경되어 제출을 중단했습니다. 터미널의 입력 내용을 확인하세요.",
            );
          this.checkIdentity(input.terminalId, input);
          if (this.readerBinding(input.terminalId) !== binding)
            throw new Error(
              "세션이 변경되어 제출을 중단했습니다. 터미널의 입력 내용을 확인하세요.",
            );
          this.controls.assert(
            input.terminalId,
            res.locals.deviceId,
            legacyLease ? "legacy" : input.clientId,
            legacyLease || input.controlToken,
          );
          this.operations.write(input.terminalId, "\r");
        }
        reserved.written = true;
      } finally {
        this.pendingInputs.delete(input.terminalId);
        settle();
      }
      res.json({ ok: true });
    });
    app.post("/mobile-api/requests/:id/answer", (req, res) => {
      const request = this.stateFor(res.locals.deviceId).requests.find(
        (r) => r.id === req.params.id,
      );
      if (!request || request.status !== "pending")
        throw new Error("현재 세션의 요청을 확인하세요.");
      this.controls.assert(
        request.terminal.terminalId!,
        res.locals.deviceId,
        req.body.clientId,
        req.body.controlToken,
        res.locals.device.kind === "mobile",
      );
      res.json(
        this.operations.answer(
          uuid.parse(req.params.id),
          answerSchema.parse({
            text: req.body.text,
            optionId: req.body.optionId,
          }),
        ),
      );
    });
    app.get("/mobile-api/terminals/:id/answers", async (req, res) => {
      const id = uuid.parse(req.params.id);
      const binding = this.readerBinding(id);
      const result = await this.operations.answers(id);
      this.authenticated(req, res.locals.deviceId);
      if (this.readerBinding(id) !== binding)
        throw Object.assign(new Error("조회 중 세션이 변경되었습니다."), {
          status: 409,
        });
      res.json(result);
    });
    app.get("/mobile-api/terminals/:id/conversation", async (req, res) => {
      if (!this.operations.conversation) {
        res.sendStatus(404);
        return;
      }
      const { sessionId, cursor, includeActivity } = z
        .object({
          sessionId: z.string().min(1).max(150),
          cursor: z.string().min(1).max(4096).optional(),
          includeActivity: z.enum(["0", "1"]).optional(),
        })
        .strict()
        .parse(req.query);
      const id = uuid.parse(req.params.id);
      const binding = this.readerBinding(id);
      const terminal = this.operations
        .state()
        .terminals.find((t) => t.id === id)!;
      if ((terminal.agentSessionId || terminal.resumeThreadId) !== sessionId)
        throw Object.assign(new Error("현재 열린 대화만 조회할 수 있습니다."), {
          status: 409,
        });
      const result = await this.operations.conversation(id, sessionId, cursor, {
        includeActivity: includeActivity === "1",
      });
      this.authenticated(req, res.locals.deviceId);
      if (this.readerBinding(id) !== binding)
        throw Object.assign(new Error("조회 중 세션이 변경되었습니다."), {
          status: 409,
        });
      res.json(result);
    });
    app.put(
      "/mobile-api/terminals/:id/attachment",
      (_req, res, next) => {
        if (this.uploads >= 2) {
          res
            .status(429)
            .json({ error: "다른 첨부 전송이 끝난 뒤 다시 시도하세요." });
          return;
        }
        this.uploads++;
        res.once("close", () => this.uploads--);
        next();
      },
      express.raw({ type: "application/octet-stream", limit: "32mb" }),
      async (req, res) => {
        const id = uuid.parse(req.params.id),
          binding = this.readerBinding(id);
        const authorize = () => {
          const device = this.authenticated(req, res.locals.deviceId);
          if (this.readerBinding(id) !== binding)
            throw Object.assign(new Error("첨부 중 세션이 변경되었습니다."), {
              status: 409,
            });
          this.controls.assert(
            id,
            device.id,
            req.get("X-Harbor-Client"),
            req.get("X-Harbor-Control"),
            device.kind === "mobile",
          );
        };
        authorize();
        if (!Buffer.isBuffer(req.body))
          throw new Error("파일 데이터를 확인하세요.");
        const name = z
          .string()
          .min(1)
          .max(150)
          .regex(/^[^/\\\x00-\x1f]+$/)
          .parse(req.query.name);
        const buffer: Buffer = req.body;
        const input = Readable.from(
          (async function* () {
            for (let offset = 0; offset < buffer.length; offset += 64 * 1024) {
              authorize();
              yield buffer.subarray(offset, offset + 64 * 1024);
            }
            authorize();
          })(),
        );
        const result = await this.operations.upload(
          id,
          `${randomUUID()}-${name}`,
          input,
        );
        authorize();
        res.json(result);
      },
    );
    app.get("/mobile-api/push", (_req, res) =>
      res.json(this.access.pushView(res.locals.deviceId)),
    );
    app.post("/mobile-api/push", (req, res) => {
      this.access.setPush(res.locals.deviceId, req.body);
      res.json({ ok: true });
    });
    app.post("/mobile-api/push/test", async (_req, res) =>
      res.json(
        await this.access.notify(
          "Harbor",
          "테스트 알림입니다. AI 답변이 완료되면 이 기기로 알려드립니다.",
          undefined,
          res.locals.deviceId,
        ),
      ),
    );
    app.post("/mobile-api/logout", (_req, res) => {
      this.revoke(res.locals.deviceId);
      res.setHeader(
        "Set-Cookie",
        "harbor_mobile=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
      );
      res.json({ ok: true });
    });
    app.use(
      "/desktop",
      express.static(resolve(this.assets, "remote-desktop"), {
        redirect: true,
      }),
    );
    app.get("/", (_req, res) => res.redirect("/desktop/"));
    app.get("/harbor.svg", (_req, res) =>
      res.sendFile(resolve(this.assets, "harbor.svg")),
    );
    app.use(
      "/mobile",
      express.static(resolve(this.assets, "mobile"), { redirect: true }),
    );
    // Cache/compress public application files only; all API data stays no-store.
    app.use(
      "/assets",
      compression({
        threshold: 1024,
        brotli: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } },
      }),
      express.static(resolve(this.assets, "assets"), {
        setHeaders: (res) =>
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable"),
      }),
    );
    app.use(
      "/fonts",
      express.static(resolve(this.assets, "fonts"), {
        setHeaders: (res) =>
          res.setHeader("Cache-Control", "public, max-age=86400"),
      }),
    );
    app.use("/pdfjs", express.static(resolve(this.assets, "pdfjs")));
    app.use((_req, res) => res.sendStatus(404));
    app.use(
      (
        error: Error,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        if (!res.headersSent)
          res
            .status((error as Error & { status?: number }).status || 400)
            .json({
              error:
                error instanceof z.ZodError
                  ? "입력 형식을 확인하세요."
                  : error.message,
            });
      },
    );
    const server = createServer(app),
      sockets = new WebSocketServer({
        noServer: true,
        maxPayload: 4096,
        perMessageDeflate: {
          serverNoContextTakeover: true,
          clientNoContextTakeover: true,
          threshold: 1024,
          concurrencyLimit: 2,
          zlibDeflateOptions: { level: 3, memLevel: 7 },
        },
      });
    server.requestTimeout = 45000;
    server.headersTimeout = 10000;
    server.on("upgrade", (req, socket, head) => {
      const device = this.access.authenticate(req.headers.cookie);
      if (
        new URL(req.url || "/", this.access.config.origin).pathname === "/ws" &&
        this.operations.desktop &&
        device?.kind === "desktop" &&
        this.validHost(req.headers.host) &&
        req.headers.origin === this.access.config.origin &&
        (!req.headers["tailscale-funnel-request"] ||
          this.access.config.mode === "funnel")
      ) {
        this.operations.desktop.upgrade(req, socket, head);
        return;
      }
      if (
        (req.headers["tailscale-funnel-request"] &&
          this.access.config.mode !== "funnel") ||
        req.url !== "/mobile-ws" ||
        !this.validHost(req.headers.host) ||
        req.headers.origin !== this.access.config.origin ||
        !device
      ) {
        socket.destroy();
        return;
      }
      if (
        [...this.views.values()].filter((v) => v.deviceId === device.id)
          .length >= 3
      ) {
        socket.destroy();
        return;
      }
      sockets.handleUpgrade(req, socket, head, (ws) => {
        const view: View = {
          deviceId: device.id,
          generation: 0,
          bytes: 0,
          lastPong: Date.now(),
        };
        this.views.set(ws, view);
        this.send(ws, {
          type: "state",
          state: this.stateFor(view.deviceId),
          protocol: 4,
        });
        ws.on("close", () => this.views.delete(ws));
        ws.on("pong", () => {
          view.lastPong = Date.now();
        });
        ws.on("error", () => ws.close());
        ws.on("message", async (raw) => {
          let generation = view.generation;
          let restoring = false;
          try {
            if (!this.access.authenticate(req.headers.cookie)) {
              ws.close(4001);
              return;
            }
            const message = z
              .object({
                type: z.literal("subscribe"),
                id: uuid,
                subscriptionId: uuid.optional(),
              })
              .strict()
              .parse(JSON.parse(raw.toString()));
            const binding = this.readerBinding(message.id);
            generation = ++view.generation;
            restoring = true;
            view.subscriptionId = message.subscriptionId;
            view.terminalId = message.id;
            view.pending = [];
            view.bytes = 0;
            let timer: ReturnType<typeof setTimeout>;
            const snapshot = await Promise.race([
              this.operations.snapshot(message.id),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("화면 복원 시간 초과")),
                  25000,
                );
                timer.unref();
              }),
            ]).finally(() => clearTimeout(timer));
            if (
              view.generation !== generation ||
              ws.readyState !== WebSocket.OPEN
            )
              return;
            if (
              !this.access.authenticate(req.headers.cookie) ||
              !this.deviceActive(view.deviceId)
            ) {
              ws.close(4001, "Device revoked");
              return;
            }
            if (this.readerBinding(message.id) !== binding) {
              view.pending = undefined;
              view.terminalId = undefined;
              view.bytes = 0;
              throw new Error(
                "복원 중 세션이 변경되었습니다. 다시 연결하세요.",
              );
            }
            this.send(ws, {
              type: "snapshot",
              id: message.id,
              ...snapshot,
              subscriptionId: view.subscriptionId,
            });
            for (const event of view.pending || []) this.send(ws, event);
            view.pending = undefined;
            view.bytes = 0;
          } catch (error) {
            if (view.generation === generation) {
              if (restoring) {
                view.pending = undefined;
                view.terminalId = undefined;
                view.bytes = 0;
              }
              this.send(ws, {
                type: "error",
                error: (error as Error).message,
                subscriptionId: view.subscriptionId,
              });
            }
          }
        });
      });
    });
    try {
      await new Promise<void>((ok, fail) => {
        server.once("error", fail);
        server.listen(this.access.config.port, "127.0.0.1", ok);
      });
    } catch (error) {
      sockets.close();
      server.close();
      this.error = (error as Error).message;
      return;
    }
    this.server = server;
    this.sockets = sockets;
    this.heartbeat = setInterval(() => {
      for (const [socket, v] of this.views) {
        if (
          !this.access.config.devices.some(
            (d) => d.id === v.deviceId && d.expiresAt > Date.now(),
          )
        )
          socket.close(4001);
        else if (Date.now() - v.lastPong > 60000) socket.terminate();
        else {
          socket.ping();
          this.send(socket, { type: "heartbeat" });
        }
      }
    }, 15000);
    this.heartbeat.unref();
  }
  async stop() {
    this.operations.desktop?.revoke();
    this.controls.clear();
    this.completions.dispose();
    clearInterval(this.heartbeat);
    clearTimeout(this.broadcastTimer);
    this.broadcastTimer = undefined;
    for (const socket of this.views.keys()) socket.terminate();
    this.views.clear();
    this.sockets?.close();
    const server = this.server;
    this.server = undefined;
    this.sockets = undefined;
    if (server)
      await new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      });
  }
}
