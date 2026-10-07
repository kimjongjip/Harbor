import express from "express";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { resolve, join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { Store } from "./store.js";
import { Hub, errorText } from "./hub.js";
import { Terminals } from "./terminals.js";
import { Credentials } from "./credentials.js";
import { History } from "./history.js";
import { ClaudeHistory } from "./claude-history.js";
import { Mailbox } from "./mailbox.js";
import { AgentBridge } from "./agent-bridge.js";
import {
  annotationCaptureSchema,
  annotationNumbersSchema,
} from "./terminal-annotations.js";
import { Requests, answerSchema } from "./requests.js";
import { TerminalNotices } from "./terminal-notices.js";
import { passwordConnection } from "./ssh-connect.js";
import { Files, MAX_UPLOAD_BYTES } from "./files.js";
import { pipeline } from "node:stream/promises";
import { allowedHost, allowedOrigin, validToken } from "./security.js";
import { sshAliases } from "./ssh.js";
import type { ServerEvent } from "../shared/types.js";

const port = Number(process.env.HARBOR_PORT || process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("PORT must be between 1024 and 65535");
const token = randomBytes(32).toString("hex");
const store = new Store();
const hub = new Hub(store);
const terminals = new Terminals();
const credentials = new Credentials(store.directory);
const history = new History();
const claudeHistory = new ClaudeHistory();
const historyProvider = z.enum(["codex", "claude"]).default("codex");
const historyReader = (provider: "codex" | "claude") =>
  provider === "claude" ? claudeHistory : history;
const notices = new TerminalNotices();
const requests = new Requests(store.directory, {
  terminal: (id) => terminals.list().find((item) => item.id === id),
  host: (id) => store.data.hosts.find((item) => item.id === id),
});
const mailbox = new Mailbox(store.directory, {
  terminal: (id) => terminals.list().find((item) => item.id === id),
  host: (id) => store.data.hosts.find((item) => item.id === id),
});
const bridge = new AgentBridge(mailbox, {
  requests,
  onChange: () => broadcastState(),
  terminals: () => terminals.list(),
  host: (id) => store.data.hosts.find((item) => item.id === id),
  onConnected: (id) => terminals.markAgentConnected(id),
  onState: (id, status) => terminals.markAgentState(id, status),
  onClaudeEvent: (id, event) => {
    terminals.markClaudeEvent(id, event);
    if (event.hook_event_name === "Notification") {
      const title =
        terminals.list().find((t) => t.id === id)?.title || "Claude";
      notices.append(
        id,
        title,
        `\x1b]9;${String(event.message || "Claude 입력을 확인하세요.").replace(/[\x00-\x1f\x7f]/g, " ")}\x07`,
      );
    }
  },
});
// SSH forwards only this listener. Never expose bootstrap/UI routes through it.
const bridgeApp = express();
bridgeApp.disable("x-powered-by");
bridgeApp.all("/bridge/mcp", bridge.handle);
bridgeApp.all("/bridge/permission", bridge.permissionHandle);
bridgeApp.all("/bridge/claude", bridge.claudeHandle);
bridgeApp.all("/bridge/annotation", bridge.annotationHandle);
bridgeApp.use((_req, res) => res.sendStatus(404));
const bridgeServer = createServer(bridgeApp);
await new Promise<void>((resolve, reject) => {
  bridgeServer.once("error", reject);
  bridgeServer.listen(0, "127.0.0.1", resolve);
});
const bridgePort = (bridgeServer.address() as import("node:net").AddressInfo)
  .port;
terminals.configureBridge({
  port: bridgePort,
  issue: (id) => bridge.issue(id),
  revoke: (id) => bridge.revoke(id),
});
const files = new Files((id) => hub.passwords.get(id));
hub.on("host-closed", (id) => files.close(id));
const app = express();
const server = createServer(app);
app.disable("x-powered-by");
app.use((req, res, next) => {
  if (
    !allowedHost(req.headers.host, port) ||
    !allowedOrigin(req.headers.origin, port)
  ) {
    res.status(403).json({ error: "허용되지 않은 요청 출처입니다." });
    return;
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
    if (
      !["GET", "HEAD"].includes(req.method) &&
      !validToken(req.headers["x-harbor-token"], token)
    ) {
      res
        .status(403)
        .json({ error: "앱 연결이 만료되었습니다. 화면을 새로고침하세요." });
      return;
    }
  }
  next();
});
app.use(express.json({ limit: "30mb" }));
const state = () => {
  const current = hub.state();
  const opened = terminals.list();
  return {
    ...current,
    hosts: current.hosts.map((host) => ({
      ...host,
      hasSavedPassword: credentials.has(host),
      terminalConnected: opened.some(
        (terminal) => terminal.hostId === host.id && !terminal.exited,
      ),
    })),
    terminals: opened,
    mailbox: mailbox.list(),
    requests: requests.list(),
    connections: bridge.connections(),
    notices: notices.list(),
  };
};
async function passwordFor(id: string, supplied?: string) {
  if (supplied) return supplied;
  const cached = hub.passwords.get(id);
  if (cached) return cached;
  const saved = await credentials.get(hub.host(id));
  if (saved) hub.passwords.set(id, saved);
  return saved;
}
const wsServer = new WebSocketServer({
  noServer: true,
  maxPayload: 128 * 1024,
});
const subscriptions = new Map<
  WebSocket,
  {
    sessions: Set<string>;
    terminals: Set<string>;
    pending: Map<string, { events: ServerEvent[]; bytes: number }>;
  }
>();
function send(socket: WebSocket, event: ServerEvent) {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > 4 * 1024 * 1024) {
    socket.close(1013, "Client too slow; reconnect");
    return;
  }
  socket.send(JSON.stringify(event));
}
function broadcastState() {
  for (const socket of subscriptions.keys())
    send(socket, { type: "state", state: state() });
}
function sendTerminal(socket: WebSocket, id: string, event: ServerEvent) {
  const sub = subscriptions.get(socket);
  if (!sub?.terminals.has(id)) return;
  const pending = sub.pending.get(id);
  if (!pending) return send(socket, event);
  pending.bytes += event.type === "terminal-data" ? event.data.length : 1;
  if (pending.bytes > 4 * 1024 * 1024) {
    socket.close(1013, "Replay client too slow; reconnect");
    sub.pending.delete(id);
    return;
  }
  pending.events.push(event);
}
hub.on("state", broadcastState);
hub.on("session", (session) => {
  for (const [socket, sub] of subscriptions)
    if (sub.sessions.has(session.id))
      send(socket, { type: "session", session });
});
terminals.on("change", broadcastState);
mailbox.on("change", broadcastState);
requests.on("change", broadcastState);
notices.on("change", broadcastState);
terminals.on("data", (id, data) => {
  const terminal = terminals.list().find((item) => item.id === id);
  if (terminal) notices.append(id, terminal.title, data);
  for (const socket of subscriptions.keys())
    sendTerminal(socket, id, { type: "terminal-data", id, data });
});
terminals.on("exit", (id, exitCode) => {
  notices.close(id);
  for (const socket of subscriptions.keys())
    sendTerminal(socket, id, { type: "terminal-exit", id, exitCode });
});
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
  if (url.pathname !== "/ws") return; // Vite handles its own HMR upgrade in development.
  if (
    !allowedHost(request.headers.host, port) ||
    !allowedOrigin(request.headers.origin, port) ||
    !validToken(url.searchParams.get("token"), token)
  ) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wsServer.handleUpgrade(request, socket, head, (ws) =>
    wsServer.emit("connection", ws),
  );
});
const terminalColorsInput = z.object({
  foreground: z.string().regex(/^#[a-fA-F0-9]{6}$/),
  background: z.string().regex(/^#[a-fA-F0-9]{6}$/),
});
const clientMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe"),
    sessions: z.array(z.string()).max(64),
    terminals: z.array(z.string()).max(16),
  }),
  z.object({
    type: z.literal("terminal-input"),
    id: z.string(),
    data: z.string().max(64000),
  }),
  z.object({
    type: z.literal("terminal-resize"),
    id: z.string(),
    cols: z.number().int().min(10).max(500),
    rows: z.number().int().min(3).max(200),
  }),
  z.object({
    type: z.literal("terminal-colors"),
    id: z.string().uuid(),
    colors: terminalColorsInput,
  }),
]);
wsServer.on("connection", (socket: WebSocket) => {
  subscriptions.set(socket, {
    sessions: new Set(),
    terminals: new Set(),
    pending: new Map(),
  });
  send(socket, { type: "state", state: state() });
  socket.on("message", (data) => {
    try {
      const message = clientMessage.parse(JSON.parse(data.toString()));
      if (message.type === "subscribe") {
        const prev = subscriptions.get(socket)!;
        const next = {
          sessions: new Set(message.sessions),
          terminals: new Set(message.terminals),
          pending: new Map(
            [...prev.pending].filter(([id]) => message.terminals.includes(id)),
          ),
        };
        subscriptions.set(socket, next);
        for (const id of next.sessions) {
          const s = hub.sessions.get(id);
          if (s) send(socket, { type: "session", session: s });
        }
        for (const id of next.terminals) {
          if (prev.terminals.has(id)) continue;
          const pending = { events: [] as ServerEvent[], bytes: 0 };
          next.pending.set(id, pending);
          // Freeze the snapshot at this output boundary. Later process output
          // waits until its complete screen has been delivered, in FIFO order.
          void terminals
            .bufferSnapshot(id)
            .then((snapshot) => {
              const current = subscriptions.get(socket);
              if (current?.pending.get(id) !== pending) return;
              send(socket, { type: "terminal-data", id, ...snapshot });
              current.pending.delete(id);
              for (const event of pending.events) send(socket, event);
            })
            .catch((error) => {
              if (subscriptions.get(socket)?.pending.get(id) !== pending)
                return;
              send(socket, { type: "error", message: errorText(error) });
              socket.close(1011, "Terminal snapshot failed");
            });
        }
      } else if (message.type === "terminal-input")
        terminals.write(message.id, message.data);
      else if (message.type === "terminal-colors")
        terminals.setColors(message.id, message.colors);
      else terminals.resize(message.id, message.cols, message.rows);
    } catch (error) {
      send(socket, { type: "error", message: errorText(error) });
    }
  });
  socket.on("close", () => subscriptions.delete(socket));
  socket.on("error", () => subscriptions.delete(socket));
});
const heartbeat = setInterval(() => {
  for (const socket of subscriptions.keys())
    if (socket.readyState === WebSocket.OPEN) socket.ping();
}, 25000);
heartbeat.unref();

const name = z.string().trim().min(1).max(100);
const cleanPath = z
  .string()
  .max(2000)
  .refine((s) => !/[\0\r\n]/.test(s), "경로에 줄바꿈은 사용할 수 없습니다.");
const hostInput = z.object({
  name,
  kind: z.enum(["local", "ssh"]),
  address: z.string().trim().max(253).default(""),
  username: z.string().trim().max(100).default(""),
  port: z.number().int().min(1).max(65535).default(22),
  identityFile: cleanPath.default(""),
  codexPath: cleanPath.min(1).default("codex"),
  defaultCwd: cleanPath.default(""),
  mode: z.enum(["auto", "shared", "isolated"]).default("auto"),
  color: z
    .string()
    .regex(/^#[a-fA-F0-9]{6}$/)
    .default("#93baf0"),
});
app.get("/api/health", (_req, res) =>
  res.json({ ok: true, name: "codex-harbor", version: "1.0.5" }),
);
app.get("/api/bootstrap", (_req, res) =>
  res.json({
    token,
    state: state(),
    sshAliases: sshAliases(),
    localCwd: process.cwd(),
    credentialStorageAvailable: credentials.available,
    capabilities: {
      terminalColors: true,
      terminalInputOptimized: true,
      terminalReplayState: true,
      claudeIntegration: true,
    },
  }),
);
app.get("/api/mailbox", (_req, res) => res.json(mailbox.list()));
app.post("/api/requests/:id/respond", (req, res) =>
  res.json(
    requests.respond(
      z.string().uuid().parse(req.params.id),
      answerSchema.parse(req.body),
    ),
  ),
);
app.post("/api/requests/:id/cancel", (req, res) =>
  res.json(requests.cancel(z.string().uuid().parse(req.params.id))),
);
app.post("/api/notices/read", (req, res) => {
  const { terminalId } = z
    .object({ terminalId: z.string().uuid().optional() })
    .parse(req.body);
  notices.read(terminalId);
  res.json({ ok: true });
});
app.post("/api/mailbox", (req, res) => res.json(mailbox.send(req.body)));
app.post("/api/mailbox/:id/read", (req, res) =>
  res.json(mailbox.mark(String(req.params.id), "read")),
);
app.post("/api/hosts", (req, res) => {
  const input = hostInput.parse(req.body);
  if (
    input.kind === "ssh" &&
    !/^[a-zA-Z0-9][a-zA-Z0-9._:@%+-]*$/.test(input.address)
  )
    throw new Error("올바른 SSH 별칭 또는 주소를 입력하세요.");
  res.json(hub.addHost(input));
});
app.patch("/api/hosts/:id", (req, res) => {
  const id = String(req.params.id);
  if (
    terminals
      .list()
      .some((terminal) => terminal.hostId === id && !terminal.exited)
  )
    throw new Error(
      "서버 설정을 변경하려면 이 서버의 열린 터미널을 먼저 닫으세요.",
    );
  const host = hub.updateHost(id, hostInput.parse(req.body));
  history.close(id);
  claudeHistory.close(id);
  hub.passwords.delete(id);
  files.close(id);
  res.json({ ...host, hasSavedPassword: credentials.has(host) });
});
app.post("/api/hosts/:id/credentials", async (req, res) => {
  const host = hub.host(String(req.params.id));
  const { password } = z
    .object({ password: z.string().min(1).max(2000) })
    .parse(req.body);
  await credentials.set(host, password);
  hub.passwords.set(host.id, password);
  files.close(host.id);
  broadcastState();
  res.json({ hasSavedPassword: true });
});
app.delete("/api/hosts/:id/credentials", async (req, res) => {
  const id = hub.host(String(req.params.id)).id;
  await credentials.remove(id);
  history.close(id);
  claudeHistory.close(id);
  hub.passwords.delete(id);
  files.close(id);
  broadcastState();
  res.json({ hasSavedPassword: false });
});
app.post("/api/hosts/:id/test-connection", async (req, res) => {
  const host = hub.host(String(req.params.id));
  const body = z
    .object({
      password: z.string().max(2000).optional(),
      savePassword: z.boolean().optional(),
    })
    .parse(req.body || {});
  const password = await passwordFor(host.id, body.password);
  if (host.kind === "ssh") {
    const connection = await passwordConnection(host, password);
    connection.end();
    if (body.savePassword && password) await credentials.set(host, password);
    if (password) hub.passwords.set(host.id, password);
  }
  broadcastState();
  res.json({ ok: true, hasSavedPassword: credentials.has(host) });
});
app.post("/api/hosts/:id/connect", async (req, res) => {
  const body = z
    .object({ password: z.string().max(2000).optional() })
    .parse(req.body || {});
  const id = String(req.params.id);
  res.json(await hub.connect(id, await passwordFor(id, body.password)));
});
app.post("/api/hosts/:id/disconnect", (req, res) => {
  history.close(String(req.params.id));
  claudeHistory.close(String(req.params.id));
  hub.disconnect(String(req.params.id));
  res.json({ ok: true });
});
app.get("/api/hosts/:id/threads", async (req, res) =>
  res.json(
    await hub.discover(
      String(req.params.id),
      typeof req.query.cursor === "string" ? req.query.cursor : undefined,
      typeof req.query.search === "string"
        ? req.query.search.slice(0, 100)
        : undefined,
    ),
  ),
);
app.post("/api/hosts/:id/sessions", async (req, res) => {
  const input = z
    .object({
      title: name,
      cwd: cleanPath.min(1),
      model: z.string().max(150).optional(),
      permission: z
        .enum(["read-only", "workspace-write"])
        .default("workspace-write"),
    })
    .parse(req.body);
  res.json(await hub.createSession(String(req.params.id), input));
});
app.post("/api/hosts/:id/import", async (req, res) =>
  res.json(
    await hub.importSession(
      String(req.params.id),
      z.object({ threadId: z.string().min(1).max(150) }).parse(req.body)
        .threadId,
    ),
  ),
);
app.post("/api/sessions/:id/open", async (req, res) =>
  res.json(await hub.openSession(String(req.params.id))),
);
app.post("/api/sessions/:id/history", async (req, res) =>
  res.json(await hub.olderHistory(String(req.params.id))),
);
app.post("/api/sessions/:id/message", async (req, res) => {
  const body = z
    .object({
      text: z.string().trim().max(60000).default(""),
      images: z
        .array(z.string().max(7 * 1024 * 1024))
        .max(4)
        .optional(),
      mode: z.enum(["send", "steer"]).default("send"),
      readOnly: z.boolean().optional(),
    })
    .parse(req.body);
  res.json(await hub.send(String(req.params.id), body.text, body));
});
app.post("/api/sessions/:id/interrupt", async (req, res) => {
  await hub.interrupt(String(req.params.id));
  res.json({ ok: true });
});
app.post("/api/sessions/:id/rename", async (req, res) =>
  res.json(
    await hub.rename(
      String(req.params.id),
      z.object({ title: name }).parse(req.body).title,
    ),
  ),
);
app.post("/api/sessions/:id/fork", async (req, res) =>
  res.json(
    await hub.fork(
      String(req.params.id),
      z.object({ title: name }).parse(req.body).title,
    ),
  ),
);
app.post("/api/sessions/:id/approval", (req, res) => {
  const body = z
    .object({
      approvalId: z.string().max(250),
      approved: z.boolean().optional(),
      answers: z.record(z.string(), z.string().max(6000)).optional(),
    })
    .parse(req.body);
  hub.answer(String(req.params.id), body.approvalId, body);
  res.json({ ok: true });
});
app.post("/api/sessions/:id/context", async (req, res) =>
  res.json({ text: await hub.context(String(req.params.id)) }),
);
app.post("/api/transfers", async (req, res) => {
  const body = z
    .object({
      fromId: z.string(),
      toId: z.string(),
      kind: z.enum(["context", "review"]),
      text: z.string().trim().min(1).max(60000),
    })
    .parse(req.body);
  await hub.transfer(body.fromId, body.toId, body.kind, body.text);
  res.json({ ok: true });
});
app.post("/api/discussions", async (req, res) => {
  const body = z
    .object({
      sessionIds: z.tuple([z.string(), z.string()]),
      topic: z.string().trim().min(1).max(4000),
    })
    .parse(req.body);
  res.json(await hub.startDiscussion(body.sessionIds, body.topic));
});
app.post("/api/discussions/:id/cancel", (req, res) => {
  hub.cancelDiscussion(String(req.params.id));
  res.json({ ok: true });
});
app.post("/api/terminals", async (req, res) => {
  const body = z
    .object({
      hostId: z.string(),
      cwd: cleanPath.default(""),
      program: z
        .enum(["shell", "codex", "resume", "claude", "claude-resume"])
        .default("shell"),
      title: name.optional(),
      password: z.string().max(2000).optional(),
      savePassword: z.boolean().optional(),
      colors: terminalColorsInput.optional(),
    })
    .parse(req.body);
  const host = hub.host(body.hostId);
  const password = await passwordFor(host.id, body.password);
  const terminal = await terminals.create(
    host,
    body.cwd || host.defaultCwd,
    password,
    { program: body.program, title: body.title, colors: body.colors },
  );
  try {
    if (host.kind === "ssh" && password) {
      if (body.savePassword) await credentials.set(host, password);
      hub.passwords.set(host.id, password);
    }
  } catch (error) {
    terminals.close(terminal.id);
    throw error;
  }
  broadcastState();
  res.json(terminal);
});
app.post("/api/terminals/:id/rename", (req, res) => {
  res.json(
    terminals.rename(
      String(req.params.id),
      z.object({ title: name }).parse(req.body).title,
    ),
  );
});
const historyThreadId = z.string().uuid();
app.use("/api/hosts/:id/history", (req, res, next) => {
  if (!validToken(req.headers["x-harbor-token"], token)) {
    res
      .status(403)
      .json({ error: "화면을 새로고침한 뒤 대화 기록을 다시 열어주세요." });
    return;
  }
  next();
});
app.get("/api/hosts/:id/history", async (req, res) => {
  const host = hub.host(String(req.params.id));
  const input = z
    .object({
      cursor: z.string().max(4000).optional(),
      search: z.string().max(200).optional(),
      includeAutomation: z.enum(["true", "false"]).optional(),
      archived: z.enum(["true", "false"]).optional(),
      provider: historyProvider,
    })
    .parse(req.query);
  res.json(
    await historyReader(input.provider).list(host, await passwordFor(host.id), {
      ...input,
      includeAutomation: input.includeAutomation === "true",
      archived: input.archived === "true",
    }),
  );
});
app.get("/api/hosts/:id/history/:threadId", async (req, res) => {
  const host = hub.host(String(req.params.id));
  res.json(
    await historyReader(historyProvider.parse(req.query.provider)).read(
      host,
      await passwordFor(host.id),
      historyThreadId.parse(req.params.threadId),
      z.string().max(4000).optional().parse(req.query.cursor),
    ),
  );
});
const resumingThreads = new Map<
  string,
  Promise<import("../shared/types.js").TerminalInfo>
>();
app.post("/api/hosts/:id/history/:threadId/resume", async (req, res) => {
  const body = z
    .object({
      colors: terminalColorsInput.optional(),
      provider: historyProvider,
    })
    .parse(req.body || {});
  const host = hub.host(String(req.params.id));
  const threadId = historyThreadId.parse(req.params.threadId);
  const key = `${body.provider}:${host.id}:${threadId}`;
  const existing = terminals
    .list()
    .find(
      (t) =>
        t.hostId === host.id &&
        (t.agentKind ||
          (t.program?.startsWith("claude") ? "claude" : "codex")) ===
          body.provider &&
        (t.resumeThreadId === threadId || t.agentSessionId === threadId) &&
        !t.exited,
    );
  if (existing) {
    if (body.colors) terminals.setColors(existing.id, body.colors);
    res.json(existing);
    return;
  }
  let opening = resumingThreads.get(key);
  if (!opening) {
    opening = (async () => {
      const password = await passwordFor(host.id);
      const thread = await historyReader(body.provider).summary(
        host,
        password,
        threadId,
      );
      if (thread.active)
        throw new Error("이 대화는 실행 중입니다. 기존 터미널에서 이어가세요.");
      const cwd = cleanPath.min(1).parse(thread.cwd);
      return terminals.create(host, cwd, password, {
        program: body.provider === "claude" ? "claude-resume" : "resume",
        title: thread.title.slice(0, 100),
        resumeThreadId: threadId,
        ...(body.provider === "claude" ? { resumeCwd: cwd } : {}),
        colors: body.colors,
      });
    })();
    resumingThreads.set(key, opening);
    void opening.finally(() => resumingThreads.delete(key)).catch(() => {});
  }
  res.json(await opening);
});
app.post("/api/terminals/:id/close", (req, res) => {
  terminals.close(String(req.params.id));
  res.json({ ok: true });
});
function annotationTerminal(id: string) {
  const terminal = terminals
    .list()
    .find((item) => item.id === id && !item.exited);
  if (!terminal || !terminal.agentConnected)
    throw new Error("인용을 추가할 실행 중인 AI 터미널을 찾을 수 없습니다.");
  if (!bridge.annotations.isReady(id))
    throw new Error(
      "번호 인용 연결이 준비되지 않았습니다. Harbor 업데이트 후 Codex를 다시 실행하고 인용 훅을 검토해주세요.",
    );
  return terminal;
}
app.post("/api/terminals/:id/annotations", (req, res) => {
  const terminal = annotationTerminal(String(req.params.id));
  const { snapshot } = z
    .object({
      snapshot: z.object({
        text: annotationCaptureSchema.shape.text,
        source: z.object({
          terminalId: z.string().min(1).max(256),
          threadId: z.string().max(256).optional(),
        }),
      }),
    })
    .parse(req.body);
  if (snapshot.source.terminalId !== terminal.id)
    throw new Error("인용한 터미널과 입력 대상이 다릅니다.");
  const threadId = terminal.agentSessionId || terminal.resumeThreadId;
  if (
    threadId &&
    snapshot.source.threadId &&
    threadId !== snapshot.source.threadId
  )
    throw new Error(
      "참조를 추가한 뒤 대화가 변경되었습니다. 현재 대화에서 다시 선택해주세요.",
    );
  res.json(
    bridge.annotations.capture(terminal.id, {
      text: snapshot.text,
      source: {
        hostName: hub.host(terminal.hostId).name,
        title: terminal.title,
        ...(terminal.cwd ? { cwd: terminal.cwd } : {}),
      },
    }),
  );
});
app.post("/api/terminals/:id/annotations/validate", (req, res) => {
  const terminal = annotationTerminal(String(req.params.id));
  const { numbers } = z
    .object({ numbers: annotationNumbersSchema })
    .parse(req.body);
  bridge.annotations.validate(terminal.id, numbers);
  res.json({ ready: true });
});
app.post("/api/terminals/:id/annotations/remove", (req, res) => {
  const { numbers } = z
    .object({ numbers: annotationNumbersSchema })
    .parse(req.body);
  bridge.annotations.remove(String(req.params.id), numbers);
  res.json({ ok: true });
});
async function attachmentTarget(id: string) {
  const terminal = terminals
    .list()
    .find((item) => item.id === id && !item.exited);
  if (!terminal)
    throw new Error("첨부파일을 올릴 실행 중인 터미널을 찾을 수 없습니다.");
  await passwordFor(terminal.hostId);
  const host = hub.host(terminal.hostId);
  return {
    terminal,
    host,
    path: await files.prepareAttachments(host, terminal.id),
  };
}
app.post("/api/terminals/:id/attachments/prepare", async (req, res) => {
  const target = await attachmentTarget(z.string().uuid().parse(req.params.id));
  res.json({
    path: target.path,
    terminalId: target.terminal.id,
    hostId: target.host.id,
  });
});
app.put("/api/terminals/:id/attachments", async (req, res) => {
  if (Number(req.headers["content-length"]) > MAX_UPLOAD_BYTES) {
    res
      .status(413)
      .json({ error: "파일은 개당 512MB까지 업로드할 수 있습니다." });
    return;
  }
  const target = await attachmentTarget(z.string().uuid().parse(req.params.id));
  const result = await files.upload(
    target.host,
    target.path,
    z.string().min(1).max(255).parse(req.query.name),
    req,
    0o600,
  );
  res.json(result);
});
app.use("/api/hosts/:id/files", async (req, _res, next) => {
  await passwordFor(String(req.params.id));
  next();
});
app.get("/api/hosts/:id/files", async (req, res) => {
  res.json(
    await files.list(
      hub.host(String(req.params.id)),
      cleanPath.parse(req.query.path || ""),
    ),
  );
});
app.get("/api/hosts/:id/files/download", async (req, res) => {
  if (
    !validToken(req.query.token, token) &&
    !validToken(req.headers["x-harbor-token"], token)
  ) {
    res.status(403).json({
      error: "다운로드 연결이 만료되었습니다. 화면을 새로고침하세요.",
    });
    return;
  }
  const file = await files.download(
    hub.host(String(req.params.id)),
    cleanPath.min(1).parse(req.query.path),
  );
  res.attachment(file.name);
  res.setHeader("Content-Length", file.size);
  res.setHeader("Content-Type", "application/octet-stream");
  await pipeline(file.stream, res).catch((error) => {
    if (!res.headersSent && !res.destroyed) throw error;
  });
});
app.get("/api/hosts/:id/files/preview", async (req, res) => {
  if (!validToken(req.headers["x-harbor-token"], token)) {
    res
      .status(403)
      .json({ error: "화면을 새로고침한 뒤 파일을 다시 열어주세요." });
    return;
  }
  res.json(
    await files.preview(
      hub.host(String(req.params.id)),
      cleanPath.min(1).parse(req.query.path),
      cleanPath.parse(req.query.cwd || ""),
    ),
  );
});
app.get("/api/hosts/:id/files/image", async (req, res) => {
  if (!validToken(req.query.token, token)) {
    res.status(403).json({ error: "이미지 연결이 만료되었습니다." });
    return;
  }
  const image = await files.image(
    hub.host(String(req.params.id)),
    cleanPath.min(1).parse(req.query.path),
  );
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.type(image.mime).send(image.bytes);
});
app.put("/api/hosts/:id/files/upload", async (req, res) => {
  if (Number(req.headers["content-length"]) > MAX_UPLOAD_BYTES) {
    res
      .status(413)
      .json({ error: "파일은 개당 512MB까지 업로드할 수 있습니다." });
    return;
  }
  const host = hub.host(String(req.params.id));
  const result = await files.upload(
    host,
    cleanPath.min(1).parse(req.query.path),
    z.string().min(1).max(255).parse(req.query.name),
    req,
  );
  hub.activity("transfer", `${host.name} · 파일 업로드: ${result.path}`);
  res.json(result);
});
app.post("/api/hosts/:id/files/mkdir", async (req, res) => {
  const body = z.object({ path: cleanPath.min(1), name: name }).parse(req.body);
  res.json(
    await files.mkdir(hub.host(String(req.params.id)), body.path, body.name),
  );
});
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "요청한 기능을 찾을 수 없습니다." }),
);
app.use(
  (
    error: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("\n"),
      });
      return;
    }
    res.status(400).json({ error: errorText(error).slice(0, 5000) });
  },
);

const development = process.argv[1]?.endsWith(".ts");
if (development) {
  const { createServer: createVite } = await import("vite");
  const vite = await createVite({
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  const clientDirectory = resolve("dist/client");
  if (!existsSync(join(clientDirectory, "index.html")))
    throw new Error("먼저 npm run build를 실행하세요.");
  app.use(express.static(clientDirectory));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(join(clientDirectory, "index.html")),
  );
}
server.listen(port, "127.0.0.1", () => {
  writeFileSync(
    join(store.directory, "server.json"),
    JSON.stringify({ pid: process.pid, port, url: `http://127.0.0.1:${port}` }),
  );
  console.log(`Harbor is ready at http://127.0.0.1:${port}`);
  if (process.env.HARBOR_AUTO_CONNECT === "1")
    void hub
      .connect("local")
      .catch((error) => console.warn("Local Codex:", errorText(error)));
});
server.on("error", (error) => {
  console.error(errorText(error));
  process.exitCode = 1;
});
function shutdown() {
  clearInterval(heartbeat);
  hub.shutdown();
  history.shutdown();
  claudeHistory.shutdown();
  requests.shutdown();
  terminals.shutdown();
  files.shutdown();
  wsServer.close();
  server.close();
  bridgeServer.close();
  bridgeServer.closeAllConnections();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("message", (message: unknown) => {
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "harbor:shutdown"
  )
    shutdown();
});
