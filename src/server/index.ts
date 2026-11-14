import express from "express";
import { MobileAccess } from "./mobile-access.js";
import { MobileGateway } from "./mobile-gateway.js";
import { DesktopAccess } from "./desktop-access.js";
import {
  desktopPreferenceKeys,
  type DesktopWorkspace,
} from "../shared/desktop-workspace.js";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { MobileNetwork } from "./mobile-network.js";
import { TailscaleSetup } from "./tailscale-setup.js";
import {
  EditorFiles,
  createEditorRouter,
  EditorError,
} from "./editor-files.js";
import { MobileConversations } from "./mobile-conversation.js";
import { IdeChats, IdeChatError, createIdeChatRouter } from "./ide-chat.js";
import { IdeLiveChats } from "./ide-chat-live.js";
import { ResearchLabManager } from "./research-manager.js";
import {
  researchSettings,
  validateResearchSettings,
  researchReconnectOptions,
} from "./research-settings.js";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve, join, posix } from "node:path";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { AutoApproval } from "./auto-approval.js";
import { Store } from "./store.js";
import { ViewConnections, viewConnectionEvent } from "./view-connections.js";
import { startRuntimeDiagnostics } from "./runtime-diagnostics.js";
import { Hub, errorText } from "./hub.js";
import { Terminals } from "./terminals.js";
import { disconnectCategory } from "./durable-ssh.js";
import { Credentials } from "./credentials.js";
import { History } from "./history.js";
import { serializeHistoryDetailForRead } from "./history-response.js";
import { historyActivities } from "./history-activity.js";
import { HistoryResumer } from "./history-resume.js";
import { ClaudeHistory } from "./claude-history.js";
import { Mailbox } from "./mailbox.js";
import { AgentBridge } from "./agent-bridge.js";
import { createBridgeRouter } from "./bridge-router.js";
import {
  claudeUsageSnapshot,
  mergeClaudeUsage,
} from "../shared/terminal-usage.js";
import { CodexPeerRuntime } from "./codex-peer-runtime.js";
import { TerminalUsageStore } from "./terminal-usage.js";
import { CodexUsageHistory } from "./codex-usage-history.js";
import { CodexAgentTelemetry } from "./codex-agent-telemetry.js";
import {
  ResearchLabs,
  researchCreateSchema,
  researchPrepareSchema,
  researchProposalSchema,
  researchStartSchema,
} from "./research-lab.js";
import { researchConversation } from "./research-conversation.js";
import {
  prepareResearchWorkspaces,
  prepareRemoteResearchWorkspaces,
} from "./research-workspaces.js";
import {
  annotationCaptureSchema,
  annotationCommentsSchema,
  annotationNumbersSchema,
} from "./terminal-annotations.js";
import { TerminalAnnotations } from "./terminal-annotations.js";
import { annotationReference } from "../shared/annotations.js";
import { isTerminalProtocolResponse } from "../shared/terminal-protocol-response.js";
import { Requests, answerSchema } from "./requests.js";
import { TerminalNotices } from "./terminal-notices.js";
import { RichTerminals } from "./rich-terminal.js";
import { passwordConnection } from "./ssh-connect.js";
import { Files, MAX_UPLOAD_BYTES } from "./files.js";
import { SkillLibrary, createSkillRouter } from "./skill-library.js";
import { HostInsights, createInsightsRouter } from "./host-insights.js";
import { TerminalWorkMonitor } from "./terminal-work.js";
import { sendMediaFile } from "./file-media.js";
import { HtmlPreviews } from "./html-preview.js";
import { UPLOAD_ENTRY_LIMIT } from "../shared/upload-tree.js";
import { pipeline } from "node:stream/promises";
import { allowedHost, allowedOrigin, validToken } from "./security.js";
import { sshAliases } from "./ssh.js";
import type { ServerEvent } from "../shared/types.js";

const port = Number(process.env.HARBOR_PORT || process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("PORT must be between 1024 and 65535");
const token = randomBytes(32).toString("hex");
const store = new Store();
const runtimeDiagnostics = startRuntimeDiagnostics(store.directory);
const hub = new Hub(store);
const terminals = new Terminals({ directory: store.directory });
const richTerminals = new RichTerminals(
  12000,
  join(store.directory, "rich-answers.json"),
);
const terminalAnnotations = new TerminalAnnotations(store.directory);
const credentials = new Credentials(store.directory);
const history = new History();
const terminalUsage = new TerminalUsageStore();
let hostInsights: HostInsights | undefined;
const codexUsageHistory = new CodexUsageHistory();
const codexAgentTelemetry = new CodexAgentTelemetry();
const claudeHistory = new ClaudeHistory();
const historyProvider = z.enum(["codex", "claude"]).default("codex");
const historyReader = (provider: "codex" | "claude") =>
  provider === "claude" ? claudeHistory : history;
const notices = new TerminalNotices();
const requests = new Requests(store.directory, {
  terminal: (id) => terminals.list().find((item) => item.id === id),
  host: (id) => store.data.hosts.find((item) => item.id === id),
});
const autoApproval = new AutoApproval(
  requests,
  (id) => terminals.list().find((terminal) => terminal.id === id),
  () => broadcastState(),
);
const mailbox = new Mailbox(store.directory, {
  terminal: (id) => terminals.list().find((item) => item.id === id),
  host: (id) => store.data.hosts.find((item) => item.id === id),
});
const peerFlushes = new Set<string>();
let researchManager: import("./research-manager.js").ResearchLabManager;
let research: ResearchLabs;
const peerGenerations = new Map<string, number>();
const codexPeers = new CodexPeerRuntime({
  onUsage: (id, usage) => terminalUsage.put(id, usage),
  onCrew: (id, sessionId, crew) =>
    terminalUsage.putCrew(id, "codex", sessionId, crew),
  onCompacted: (id) => terminalUsage.compact(id),
  connect: (id, peerPort) => terminals.connectPeerRuntime(id, peerPort),
  onSession: (id, sessionId) => {
    const runtime = bridge.peers.runtime(id);
    if (
      runtime?.state === "offline" ||
      !terminals.list().some((t) => t.id === id && !t.exited)
    )
      return;
    // The control connection identifies the primary conversation immediately,
    // including /resume before the next deferred native prompt hook.
    if (bridge.annotations.isReady(id))
      bridge.annotations.markReady(id, sessionId);
    bridge.setPeerRuntime(id, {
      kind: "codex",
      sessionId,
      state: runtime?.state === "working" ? "working" : "idle",
      delivery: "automatic",
    });
  },
  onState: (id, state, detail) => {
    const runtime = bridge.peers.runtime(id);
    bridge.setPeerRuntime(id, {
      kind: "codex",
      sessionId: runtime?.sessionId,
      state,
      delivery:
        state === "offline" ? "unavailable" : detail ? "poll" : "automatic",
      detail,
    });
  },
  onDelivered: (id, messageId, sessionId) => {
    try {
      bridge.ackPeerDelivery(id, messageId, sessionId);
    } catch {
      /* The native conversation may have closed. */
    }
  },
  onAvailable: (id) => {
    void flushPeerMessages(id);
  },
  onTurnFailed: (id, sessionId, notice) => {
    research?.nativeFailure(id, sessionId, notice);
  },
  onTurnCompleted: (id, sessionId, turnId) =>
    mobile.completions.completed(id, sessionId, `codex-turn:${turnId}`),
  onAnswer: (id, answer) => {
    const terminal = terminals
      .list()
      .find((item) => item.id === id && !item.exited);
    if (
      !terminal ||
      terminal.agentKind !== "codex" ||
      terminal.agentSessionId !== answer.sessionId
    )
      return;
    richTerminals.publishCard(id, {
      requestId: answer.id,
      sessionId: answer.sessionId,
      text: answer.text,
      cwd: answer.cwd || terminal.cwd,
      columns: 80,
      viewportRows: 30,
    });
  },
});
async function flushPeerMessages(id: string) {
  if (peerFlushes.has(id) || !codexPeers.available(id)) return;
  peerFlushes.add(id);
  try {
    const events = bridge.peerEvents(id);
    for (const message of events.messages) {
      if (
        !(await codexPeers.deliver(id, {
          ...message,
          recipientSessionId: message.recipient.sessionId,
        }))
      )
        break;
    }
  } finally {
    peerFlushes.delete(id);
  }
}
const bridge = new AgentBridge(mailbox, {
  manager: () => researchManager,
  annotations: terminalAnnotations,
  onRichRequest: (id, input) => richTerminals.request(id, input),
  research: () => research,
  requests,
  onChange: () => broadcastState(),
  terminals: () => terminals.list(),
  host: (id) => store.data.hosts.find((item) => item.id === id),
  onConnected: (id, kind) => terminals.markAgentConnected(id, kind),
  onState: (id, status) => terminals.markAgentState(id, status),
  acceptCodexSession: (id, sessionId) => {
    const primary = codexPeers.currentSession(id);
    return !primary || primary === sessionId;
  },
  onPeerRuntime: (id, runtime) => {
    terminals.markPeerRuntime(id, runtime);
    if (runtime.state === "offline") {
      terminalUsage.clear(id);
      peerGenerations.set(id, (peerGenerations.get(id) || 0) + 1);
      codexPeers.dispose(id);
    } else if (runtime.kind === "codex") {
      if (runtime.endpoint) {
        const generation = (peerGenerations.get(id) || 0) + 1;
        peerGenerations.set(id, generation);
        void codexPeers.attach(id, runtime.endpoint).catch(() => {
          const previous = bridge.peers.runtime(id);
          if (
            peerGenerations.get(id) !== generation ||
            previous?.state === "offline" ||
            !terminals.list().some((t) => t.id === id && !t.exited)
          )
            return;
          bridge.setPeerRuntime(id, {
            kind: "codex",
            sessionId: previous?.sessionId,
            state: "idle",
            delivery: "poll",
            detail:
              "자동 수신 연결을 사용할 수 없습니다. 받은 메시지 확인을 요청하세요.",
          });
        });
      } else if (runtime.sessionId)
        codexPeers.setSession(id, runtime.sessionId);
      void flushPeerMessages(id);
    }
  },
  onClaudeContinuation: (id, sessionId) => {
    terminals.markClaudeContinuation(id, sessionId);
    mobile.completions.continued(id);
  },
  onClaudeEvent: (id, event) => {
    if (
      event.hook_event_name === "SessionStart" ||
      event.hook_event_name === "SessionEnd"
    )
      terminalUsage.clear(id);
    terminals.markClaudeEvent(id, event);
    if (event.transcript_path) {
      const terminal = terminals.list().find((t) => t.id === id);
      if (terminal)
        claudeHistory.noteTranscript(
          terminal.hostId,
          event.session_id,
          event.transcript_path,
        );
    }
    mobile.completions.claudeEvent(id, event);
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
  onUsage: (id, usage) => {
    terminalUsage.put(id, usage);
    const terminal = terminals.list().find((t) => t.id === id);
    if (terminal) hostInsights?.observe(terminal.hostId, usage);
  },
});
terminals.on("peer-runtime-restored", (id, runtime) =>
  bridge.setPeerRuntime(id, runtime),
);
research = new ResearchLabs(store.directory, mailbox, {
  terminal: (id) => terminals.list().find((t) => t.id === id),
  host: (id) => store.data.hosts.find((h) => h.id === id),
  runtime: (id) => bridge.peers.runtime(id),
  artifact: async (hostId, root, cwd, filename) => {
    const host = hub.host(hostId);
    await passwordFor(host.id);
    return files.researchArtifact(host, root, cwd, filename);
  },
});
research.on("change", () => broadcastState());
researchManager = new ResearchLabManager({
  labs: research,
  terminals: () => terminals.list(),
  runtime: (id) => bridge.peers.runtime(id),
  hosts: () => store.data.hosts,
  close: (id) => terminals.close(id),
  prepare: async (input) => {
    const host = hub.host(input.hostId);
    if (input.sshSessionMode === "tmux" && host.kind !== "ssh")
      throw new Error("tmux는 SSH 서버에서만 선택할 수 있습니다.");
    const password = await passwordFor(host.id);
    const settings = await Promise.all(
      (["claude", "codex"] as const).map((kind) =>
        validateResearchSettings(
          kind,
          researchSettings(kind, input[kind], input.effort),
          () => history.models(host, password),
        ),
      ),
    );
    const cwd = await files.researchDirectory(host, input.cwd);
    const prepared =
      host.kind === "ssh"
        ? await prepareRemoteResearchWorkspaces(host, cwd, input.kind, files)
        : await prepareResearchWorkspaces(store.directory, cwd, input.kind);
    return {
      cwd,
      workspace: prepared.workspace,
      spawn: async (index) => {
        const kind = (["claude", "codex"] as const)[index];
        const terminal = await terminals.create(host, "", password, {
          program: kind,
          title: `${input.title.slice(0, 65)} · ${kind === "claude" ? "Claude" : "Codex"}`,
          sshSessionMode: input.sshSessionMode,
          researchLaunch: { cwd: prepared.folders[index], ...settings[index] },
        });
        return {
          terminalId: terminal.id,
          hostId: host.id,
          sessionId: terminal.agentSessionId,
          name: terminal.title,
          kind,
          cwd: prepared.folders[index],
          owned: true,
          settings: settings[index],
        };
      },
    };
  },
});
const researchTick = setInterval(() => research.tick(), 5000);
researchTick.unref();
// SSH forwards only this listener. Never expose bootstrap/UI routes through it.
const bridgeApp = createBridgeRouter(bridge);
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
  restore: (id, issued) => bridge.restore(id, issued),
});
terminals.configureRecovery({
  hosts: () => store.data.hosts,
  password: (host) => passwordFor(host.id),
});
bridge.peers.on("change", () => {
  queueMicrotask(() => research.tick());
  for (const terminal of terminals.list())
    if (terminal.agentKind === "codex" && !terminal.exited)
      void flushPeerMessages(terminal.id);
});
const files = new Files((id) => hub.passwords.get(id));
const workMonitor = new TerminalWorkMonitor(files);
hostInsights = new HostInsights(files, history, passwordFor);
const htmlPreviews = new HtmlPreviews(files, (id) => hub.host(id));
hub.on("host-closed", (id) => files.close(id));
const app = express();
let desktopWorkspace: DesktopWorkspace | undefined;
const desktop: DesktopAccess = new DesktopAccess(
  () => mobile.access,
  () => mobile.controls,
);
const server = createServer(app);
app.disable("x-powered-by");
app.use((req, res, next) => {
  if (desktop.device(req)) {
    res.setHeader("Cache-Control", "no-store");
    next();
    return;
  }
  if (
    !allowedHost(req.headers.host, port) ||
    (!req.path.startsWith("/html-preview/") &&
      !allowedOrigin(req.headers.origin, port))
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
app.use("/html-preview", htmlPreviews.router);
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
    terminals: opened.map((terminal) => ({
      ...terminal,
      autoApproval: autoApproval.state(terminal.id),
    })),
    mailbox: mailbox.list(),
    requests: requests.list(),
    connections: bridge.connections(),
    notices: notices.list(),
    researchLabs: research.list(),
  };
};
const mobileRuntimeId = randomUUID();
const mobileConversations = new MobileConversations(
  (id) => terminals.list().find((item) => item.id === id),
  async (hostId, provider, sessionId, cursor, options) =>
    historyReader(provider).read(
      hub.host(hostId),
      await passwordFor(hostId),
      sessionId,
      cursor,
      options,
    ),
);
const liveIdeChats = new IdeLiveChats({
  terminals: () => terminals.list(),
  terminal: (id) => terminals.list().find((terminal) => terminal.id === id),
  cacheScope: (id) => {
    const host = hub.host(id);
    return JSON.stringify([
      host.id,
      host.kind,
      host.address,
      host.username,
      host.port,
      host.identityFile,
      host.codexPath,
    ]);
  },
  readHistory: async (id, provider, nativeId, cursor) =>
    historyReader(provider).read(
      hub.host(id),
      await passwordFor(id),
      nativeId,
      cursor,
    ),
  codex: codexPeers,
  claude: {
    available: (id, nativeId) => {
      const runtime = bridge.peers.runtime(id);
      return (
        runtime?.kind === "claude" &&
        runtime.sessionId === nativeId &&
        runtime.delivery === "automatic" &&
        runtime.userInputVersion === 1 &&
        runtime.state !== "offline"
      );
    },
    send: async (id, input, beforeDispatch) => {
      await beforeDispatch();
      const runtime = bridge.peers.runtime(id);
      if (
        runtime?.kind !== "claude" ||
        runtime.sessionId !== input.sessionId ||
        runtime.delivery !== "automatic" ||
        runtime.userInputVersion !== 1 ||
        runtime.state === "offline"
      )
        throw Object.assign(
          new IdeChatError(
            "현재 Claude 채널에 연결할 수 없습니다. 같은 터미널에서 입력할 수 있습니다.",
            409,
          ),
          { definiteRejection: true },
        );
      mailbox.sendIdeUser({
        toTerminalId: id,
        sessionId: input.sessionId,
        requestId: input.requestId,
        text: input.text,
      });
      return "queued";
    },
  },
});
const ideChats = new IdeChats({
  runtimeId: mobileRuntimeId,
  hub,
  live: liveIdeChats,
  host: (id) => hub.host(id),
  password: passwordFor,
  resolveCwd: async (id, cwd) => {
    await passwordFor(id);
    const host = hub.host(id);
    const path = await files.resolvePath(host, cwd || "~", "~");
    return (await files.list(host, path)).path;
  },
  historyList: async (id, provider, options) =>
    historyReader(provider).list(hub.host(id), await passwordFor(id), {
      ...options,
      includeAutomation: true,
    }),
  historyRead: async (id, provider, nativeId, cursor) =>
    historyReader(provider).read(
      hub.host(id),
      await passwordFor(id),
      nativeId,
      cursor,
    ),
  nativeActive: (hostId, provider, nativeId) =>
    terminals
      .list()
      .some(
        (terminal) =>
          !terminal.exited &&
          terminal.hostId === hostId &&
          terminal.agentKind === provider &&
          (terminal.agentSessionId || terminal.resumeThreadId) === nativeId,
      ),
});
const editorFiles = new EditorFiles({
  files,
  terminal: (id) => terminals.list().find((t) => t.id === id),
  host: (id) => hub.host(id),
  prepareHost: (id) => passwordFor(id),
});
app.use(
  "/api/editor",
  createEditorRouter(editorFiles, {
    authorize: (req, id, write) => {
      try {
        desktop.authorize(req, id, write);
      } catch {
        throw new EditorError(
          403,
          "CONTROL_REQUIRED",
          "다른 기기에서 제어 중입니다. ‘여기서 제어’를 누른 뒤 다시 저장하세요.",
        );
      }
    },
  }),
);
const mobile: MobileGateway = new MobileGateway(
  new MobileAccess(store.directory),
  {
    desktop: {
      http: desktop.http(app),
      upgrade: (request, socket, head) => {
        try {
          desktop.upgrade(request);
          upgradeWorkbench(request, socket, head);
        } catch {
          socket.destroy();
        }
      },
      revoke: (id) => desktop.revoke(id),
    },
    editor: editorFiles,
    controlChanged: () => broadcastTerminalControls(),
    ideChat: ideChats,
    resize: (id, cols, rows) => terminals.resize(id, cols, rows),
    annotate: (id, text, comment) => {
      const terminal = annotationTerminal(id);
      const capture = bridge.annotations.capture(id, {
        text,
        source: {
          hostName: hub.host(terminal.hostId).name,
          title: terminal.title,
          ...(terminal.cwd ? { cwd: terminal.cwd } : {}),
        },
      });
      bridge.annotations.attach(id, [
        { number: capture.number, annotation: comment },
      ]);
      return { reference: capture.reference };
    },
    state: () => ({
      runtimeId: mobileRuntimeId,
      hosts: store.data.hosts.map(({ id, name, kind }) => ({ id, name, kind })),
      terminals: terminals
        .list()
        .map((t) => ({ ...t, autoApproval: autoApproval.state(t.id) })),
      requests: requests.list(),
      labs: [],
    }),
    snapshot: (id) => terminals.bufferSnapshot(id),
    write: (id, data) => terminals.write(id, data),
    answer: (id, answer) => requests.respond(id, answer),
    answers: (id) => richTerminals.list(id),
    conversation: (id, sessionId, cursor, options) =>
      mobileConversations.read(id, sessionId, cursor, options),
    upload: async (id, name, input) => {
      const target = await attachmentTarget(id);
      return files.upload(target.host, target.path, name, input, 0o600);
    },
  },
);
app.use(
  "/api/ide-chat",
  createIdeChatRouter(ideChats, {
    authorize: (request, { hostId, terminalId, write }) => {
      desktop.device(request);
      hub.host(hostId);
      if (write && terminalId) {
        try {
          desktop.authorize(request, terminalId, true);
        } catch (error) {
          throw new IdeChatError(
            error instanceof Error
              ? error.message
              : "터미널 제어권을 확인하세요.",
            409,
          );
        }
      }
    },
    actor: (request) => desktop.device(request)?.id || "local",
  }),
);
terminals.on("data", (id, data) => mobile.output(id, data));
terminals.on("resize", (id, cols, rows) => mobile.resize(id, cols, rows));
terminals.on("change", () => mobile.changed());
requests.on("change", () => mobile.changed());
research.on("change", () => mobile.changed());
app.get("/api/mobile", (_req, res) => res.json(mobile.view()));
const mobileNetwork = new MobileNetwork();
const tailscaleSetup = new TailscaleSetup();
app.get("/api/mobile/setup", async (_req, res) =>
  res.json(await tailscaleSetup.status()),
);
app.post("/api/mobile/setup", (req, res) => {
  const { action } = z
    .object({ action: z.enum(["install", "login"]) })
    .strict()
    .parse(req.body);
  res.json(tailscaleSetup.start(action));
});
let mobileSetupBusy = false;
app.get("/api/mobile/network", async (_req, res) =>
  res.json(await mobileNetwork.status(mobile.access.config.port)),
);
app.post("/api/mobile/network", async (_req, res) => {
  if (mobileSetupBusy)
    throw new Error("모바일 연결 설정 중입니다. 잠시 기다려주세요.");
  if (!mobile.view().listening)
    throw new Error("먼저 모바일 연결 설정을 저장하세요.");
  mobileSetupBusy = true;
  try {
    res.json(await mobileNetwork.connect(mobile.access.config));
  } finally {
    mobileSetupBusy = false;
  }
});
app.put("/api/mobile", async (req, res) => {
  if (mobileSetupBusy)
    throw new Error("모바일 연결 설정 중입니다. 잠시 기다려주세요.");
  const config = z
    .object({
      enabled: z.boolean(),
      origin: z.string().max(250),
      port: z.number().int().min(1024).max(65535),
      mode: z.enum(["private", "funnel"]).optional(),
    })
    .strict()
    .parse(req.body);
  if (config.port === port)
    throw new Error("PC와 모바일 포트는 달라야 합니다.");
  mobileSetupBusy = true;
  try {
    res.json(
      await mobile.configure(
        config.enabled,
        config.origin,
        config.port,
        config.mode,
      ),
    );
  } finally {
    mobileSetupBusy = false;
  }
});
app.post("/api/mobile/pair", (req, res) => {
  if (!mobile.view().listening)
    throw new Error(
      "모바일 접속 창구가 실행되지 않았습니다. 설정을 확인하세요.",
    );
  const { kind } = z
    .object({ kind: z.enum(["mobile", "desktop"]).default("mobile") })
    .parse(req.body || {});
  res.json(mobile.access.pairing(kind));
});
app.get("/api/terminals/:id/control", (req, res) =>
  res.json({ control: mobile.controls.view(req.params.id) }),
);
app.use("/api/terminals/:id", (req, _res, next) => {
  if (
    desktop.device(req) &&
    !["GET", "HEAD"].includes(req.method) &&
    !["/control", "/rename", "/close", "/reconnect"].includes(req.path) &&
    !/^\/rich\/[^/]+\/layout$/.test(req.path)
  )
    desktop.authorize(req, String(req.params.id), true);
  next();
});
app.post("/api/terminals/:id/control", (req, res) => {
  const device = desktop.device(req);
  if (device) {
    const input = z
      .object({
        action: z.enum(["claim", "renew", "release"]),
        clientId: z.string().uuid(),
        token: z.string().uuid().optional(),
        takeover: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    res.json(
      mobile.controls.change(req.params.id, device.id, device.name, input),
    );
    return;
  }
  z.object({ action: z.literal("claim") })
    .strict()
    .parse(req.body);
  res.json(
    mobile.controls.change(req.params.id, "local", "호스트 PC", {
      clientId: "local",
      action: "claim",
      takeover: true,
    }),
  );
});
app.delete("/api/mobile/devices/:id", (req, res) => {
  mobile.revoke(z.string().uuid().parse(req.params.id));
  res.json(mobile.view());
});
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
const viewConnections = new ViewConnections(store.directory);
const pongReceived = new WeakSet<WebSocket>();
const subscriptions = new Map<
  WebSocket,
  {
    sessions: Set<string>;
    terminals: Set<string>;
    pending: Map<string, { events: ServerEvent[]; bytes: number }>;
    state: boolean;
  }
>();
function send(socket: WebSocket, event: ServerEvent | string) {
  if (socket.readyState !== WebSocket.OPEN || !desktop.validSocket(socket))
    return;
  if (socket.bufferedAmount > 4 * 1024 * 1024) {
    viewConnections.trace({ reason: "slow-client" });
    socket.close(1013, "Client too slow; reconnect");
    return;
  }
  socket.send(typeof event === "string" ? event : JSON.stringify(event));
}
let stateBroadcast: ReturnType<typeof setTimeout> | undefined;
function broadcastState() {
  if (stateBroadcast) return;
  stateBroadcast = setTimeout(() => {
    stateBroadcast = undefined;
    const recipients = [...subscriptions].filter(
      ([socket, sub]) => sub.state && socket.readyState === WebSocket.OPEN,
    );
    if (!recipients.length) return;
    const message = JSON.stringify({ type: "state", state: state() });
    for (const [socket] of recipients) send(socket, message);
  }, 20);
}
function sendTerminal(socket: WebSocket, id: string, event: ServerEvent) {
  const sub = subscriptions.get(socket);
  if (!sub?.terminals.has(id)) return;
  const pending = sub.pending.get(id);
  if (!pending) return send(socket, event);
  pending.bytes += event.type === "terminal-data" ? event.data.length : 1;
  if (pending.bytes > 4 * 1024 * 1024) {
    viewConnections.trace({ terminalId: id, reason: "slow-replay" });
    socket.close(1013, "Replay client too slow; reconnect");
    sub.pending.delete(id);
    return;
  }
  pending.events.push(event);
}
function broadcastTerminalControls() {
  for (const [socket, sub] of subscriptions)
    for (const id of sub.terminals)
      sendTerminal(socket, id, {
        type: "terminal-control",
        id,
        control: mobile.controls.view(id),
      });
}
hub.on("state", broadcastState);
hub.on("session", (session) => {
  for (const [socket, sub] of subscriptions)
    if (sub.sessions.has(session.id))
      send(socket, { type: "session", session });
});
terminals.on("change", broadcastState);
terminals.on("change", autoApproval.refresh);
mailbox.on("change", broadcastState);
requests.on("change", broadcastState);
notices.on("change", broadcastState);
terminals.on("data", (id, data) => {
  const terminal = terminals.list().find((item) => item.id === id);
  if (terminal) notices.append(id, terminal.title, data);
  for (const socket of subscriptions.keys())
    sendTerminal(socket, id, { type: "terminal-data", id, data });
});
terminals.on("resize", (id, cols, rows) => {
  for (const socket of subscriptions.keys())
    sendTerminal(socket, id, { type: "terminal-resize", id, cols, rows });
});
terminals.on("exit", (id, exitCode) => {
  notices.close(id);
  const terminal = terminals.list().find((item) => item.id === id);
  for (const socket of subscriptions.keys())
    sendTerminal(socket, id, {
      type: "terminal-exit",
      id,
      exitCode,
      connectionIssue: terminal?.connectionIssue,
      disconnectReason: terminal?.disconnectReason,
      persistent: terminal?.persistent,
    });
});
function upgradeWorkbench(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) {
  const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
  if (url.pathname !== "/ws") return; // Vite handles its own HMR upgrade in development.
  if (
    !desktop.device(request) &&
    (!allowedHost(request.headers.host, port) ||
      !allowedOrigin(request.headers.origin, port) ||
      !validToken(url.searchParams.get("token"), token))
  ) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wsServer.handleUpgrade(request, socket, head, (ws) =>
    wsServer.emit("connection", ws, request),
  );
}
server.on("upgrade", upgradeWorkbench);
const terminalColorsInput = z.object({
  foreground: z.string().regex(/^#[a-fA-F0-9]{6}$/),
  background: z.string().regex(/^#[a-fA-F0-9]{6}$/),
});
const clientMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe"),
    sessions: z.array(z.string()).max(64),
    terminals: z.array(z.string()).max(16),
    state: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("terminal-input"),
    id: z.string(),
    data: z.string().max(64000),
    clientId: z.string().uuid().optional(),
    controlToken: z.string().uuid().optional(),
  }),
  z.object({
    type: z.literal("terminal-resize"),
    id: z.string(),
    cols: z.number().int().min(10).max(500),
    rows: z.number().int().min(3).max(200),
    clientId: z.string().uuid().optional(),
    controlToken: z.string().uuid().optional(),
  }),
  z.object({
    type: z.literal("terminal-colors"),
    id: z.string().uuid(),
    colors: terminalColorsInput,
    clientId: z.string().uuid().optional(),
    controlToken: z.string().uuid().optional(),
  }),
]);
wsServer.on("connection", (socket: WebSocket, request: IncomingMessage) => {
  desktop.socket(request, socket);
  subscriptions.set(socket, {
    sessions: new Set(),
    terminals: new Set(),
    pending: new Map(),
    state: true,
  });
  pongReceived.add(socket);
  socket.on("pong", () => pongReceived.add(socket));
  send(socket, { type: "state", state: state() });
  socket.on("message", (data) => {
    try {
      if (!desktop.validSocket(socket)) return;
      const message = clientMessage.parse(JSON.parse(data.toString()));
      if (message.type === "subscribe") {
        const prev = subscriptions.get(socket)!;
        const next = {
          sessions: new Set(message.sessions),
          terminals: new Set(message.terminals),
          state: message.state !== false,
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
          send(socket, {
            type: "terminal-control",
            id,
            control: mobile.controls.view(id),
          });
          const pending = { events: [] as ServerEvent[], bytes: 0 };
          next.pending.set(id, pending);
          const replayDeadline = setTimeout(() => {
            if (subscriptions.get(socket)?.pending.get(id) !== pending) return;
            viewConnections.trace({
              terminalId: id,
              reason: "snapshot-timeout",
            });
            socket.terminate();
          }, 25000);
          replayDeadline.unref();
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
              viewConnections.trace({
                terminalId: id,
                reason: "snapshot-failed",
              });
              send(socket, { type: "error", message: errorText(error) });
              socket.close(1011, "Terminal snapshot failed");
            })
            .finally(() => clearTimeout(replayDeadline));
        }
      } else if (message.type === "terminal-input") {
        if (isTerminalProtocolResponse(message.data)) {
          if (
            desktop.canResize(
              request,
              message.id,
              message.clientId,
              message.controlToken,
            )
          )
            terminals.write(message.id, message.data);
          return;
        }
        desktop.assert(
          request,
          message.id,
          message.clientId,
          message.controlToken,
        );
        terminals.write(message.id, message.data);
      } else if (message.type === "terminal-colors") {
        if (
          desktop.canResize(
            request,
            message.id,
            message.clientId,
            message.controlToken,
          )
        )
          terminals.setColors(message.id, message.colors);
      } else if (
        desktop.canResize(
          request,
          message.id,
          message.clientId,
          message.controlToken,
        )
      )
        terminals.resize(message.id, message.cols, message.rows);
    } catch (error) {
      send(socket, { type: "error", message: errorText(error) });
    }
  });
  socket.on("close", (code) => {
    viewConnections.trace({ reason: "socket-close", code });
    subscriptions.delete(socket);
  });
  socket.on("error", () => subscriptions.delete(socket));
});
let lastHeartbeatAt = Date.now();
const heartbeat = setInterval(() => {
  const delayed = Date.now() - lastHeartbeatAt > 30000;
  lastHeartbeatAt = Date.now();
  for (const socket of subscriptions.keys()) {
    if (socket.readyState !== WebSocket.OPEN) {
      socket.terminate();
      continue;
    }
    // A stalled server event loop may not have dispatched queued pong events yet.
    if (!delayed && !pongReceived.has(socket)) {
      viewConnections.trace({ reason: "pong-timeout" });
      socket.terminate();
      continue;
    }
    pongReceived.delete(socket);
    socket.ping();
    send(socket, { type: "connection-heartbeat" });
  }
}, 15000);
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
  res.json({ ok: true, name: "codex-harbor", version: "1.18.33" }),
);
app.get("/api/bootstrap", (req, res) =>
  res.json({
    token: desktop.device(req) ? "desktop" : token,
    viewer: desktop.device(req)
      ? { name: desktop.device(req)!.name, kind: "desktop" }
      : undefined,
    workspace: desktop.device(req) ? desktopWorkspace : undefined,
    state: state(),
    sshAliases: sshAliases(),
    localCwd: process.cwd(),
    credentialStorageAvailable: credentials.available,
    capabilities: {
      terminalColors: true,
      terminalInputOptimized: true,
      terminalReplayState: true,
      claudeIntegration: true,
      connectionMonitoring: !desktop.device(req),
    },
  }),
);
app.put("/api/desktop/workspace", (req, res) => {
  if (desktop.device(req)) {
    res
      .status(403)
      .json({ error: "호스트의 화면 선택은 호스트 PC에서 변경하세요." });
    return;
  }
  desktopWorkspace = z
    .object({
      activeId: z.string().max(128),
      page: z.enum(["hosts", "terminals", "files"]),
      workspaceView: z.enum(["terminal", "ide"]),
      sidebar: z.enum(["servers", "files", "activity", "research"]),
      sidebarVisible: z.boolean(),
      preferences: z.partialRecord(
        z.enum(desktopPreferenceKeys),
        z.string().max(4096),
      ),
    })
    .strict()
    .parse(req.body);
  res.json({ ok: true });
});
app.post("/api/diagnostics/view-connection", (req, res) => {
  viewConnections.trace(viewConnectionEvent.parse(req.body));
  res.json({ ok: true });
});
app.get("/api/mailbox", (_req, res) => res.json(mailbox.list()));
app.use("/api/requests/:id", (req, _res, next) => {
  if (desktop.device(req) && !["GET", "HEAD"].includes(req.method)) {
    const record = requests.list().find((item) => item.id === req.params.id);
    if (record?.terminal.terminalId)
      desktop.authorize(req, record.terminal.terminalId, true);
  }
  next();
});
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
  codexUsageHistory.clear(id);
  codexAgentTelemetry.clear(id);
  claudeHistory.close(id);
  hub.passwords.delete(id);
  files.close(id);
  res.json({ ...host, hasSavedPassword: credentials.has(host) });
});
// UI-authenticated preference only. No peer/MCP route can change approvals.
// Unlike connection settings, this affects future launches and closes nothing.
app.patch("/api/hosts/:id/cli-approval", (req, res) => {
  const { mode } = z
    .object({ mode: z.enum(["native", "full-access"]) })
    .strict()
    .parse(req.body);
  res.json(hub.setCliApprovalMode(String(req.params.id), mode));
});
app.use(
  "/api/hosts",
  createSkillRouter(
    new SkillLibrary({ files }),
    (id) => hub.host(id),
    passwordFor,
  ),
);
app.use(
  [
    "/api/hosts/:id/account-usage",
    "/api/hosts/:id/codex-context",
    "/api/terminals/:id/work",
  ],
  (req, res, next) => {
    if (
      !desktop.device(req) &&
      !validToken(req.headers["x-harbor-token"], token)
    ) {
      res.status(403).json({ error: "화면을 새로고침해 주세요." });
      return;
    }
    next();
  },
);
app.use(
  "/api/hosts",
  createInsightsRouter(hostInsights, (id) => hub.host(id)),
);
app.get("/api/terminals/:id/work", async (req, res) => {
  const terminal = terminals
    .list()
    .find((t) => t.id === req.params.id && !t.exited);
  if (!terminal) {
    res.json({ jobs: [], updatedAt: Date.now() });
    return;
  }
  const host = hub.host(terminal.hostId);
  await passwordFor(host.id);
  res.json(
    await workMonitor.read(
      host,
      terminal.id,
      bridge.processScope(terminal.id),
      terminals.monitorPid(terminal.id),
    ),
  );
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
  codexUsageHistory.clear(id);
  codexAgentTelemetry.clear(id);
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
  codexUsageHistory.clear(String(req.params.id));
  codexAgentTelemetry.clear(String(req.params.id));
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
app.get("/api/hosts/:id/research-models", async (req, res) => {
  if (
    !desktop.device(req) &&
    !validToken(req.headers["x-harbor-token"], token)
  ) {
    res
      .status(403)
      .json({ error: "화면을 새로고침한 뒤 모델 목록을 다시 불러오세요." });
    return;
  }
  const host = hub.host(String(req.params.id));
  res.json({ data: await history.models(host, await passwordFor(host.id)) });
});
app.post("/api/research/prepare", async (req, res) => {
  const body = researchPrepareSchema.parse(req.body);
  const existing = body.terminalId
    ? terminals.list().find((t) => t.id === body.terminalId && !t.exited)
    : undefined;
  if (body.terminalId && !existing?.agentKind)
    throw new Error("실행 중인 AI 대화를 선택하세요.");
  if (existing && body.agentSettings)
    throw new Error("기존 대화의 모델·effort는 해당 CLI에서 변경하세요.");
  let settings = existing
    ? existing.researchSettings
    : researchSettings(body.leadKind, body.agentSettings, body.effort);
  const hostId =
    existing?.hostId ||
    body.hostId ||
    store.data.hosts.find((h) => h.kind === "local")?.id;
  if (!hostId) throw new Error("연구할 서버를 선택하세요.");
  const host = hub.host(hostId),
    password = await passwordFor(host.id);
  if (!existing)
    settings = await validateResearchSettings(body.leadKind, settings!, () =>
      history.models(host, password),
    );
  const cwd = await files.researchDirectory(host, existing?.cwd || body.cwd);
  let ownedId: string | undefined;
  try {
    const terminal =
      existing ||
      (await terminals.create(host, "", password, {
        program: body.leadKind,
        title: `${body.title.slice(0, 65)} · 주 대화`,
        researchLaunch: { cwd, ...settings! },
      }));
    if (!existing) ownedId = terminal.id;
    res.json(
      research.prepare(
        { ...body, cwd, hostId },
        {
          terminalId: terminal.id,
          hostId,
          sessionId: terminal.agentSessionId,
          name: terminal.title,
          kind: terminal.agentKind || body.leadKind,
          cwd,
          owned: !existing,
          ...(settings ? { settings } : {}),
        },
      ),
    );
  } catch (error) {
    if (ownedId) await terminals.close(ownedId).catch(() => {});
    throw error;
  }
});

async function preparationConversation(labId: string) {
  const lab = research.preparing(labId),
    lead = lab.participants[0];
  const host = hub.host(lead.hostId || lab.hostId),
    password = await passwordFor(host.id);
  const detail = await (lead.kind === "claude" ? claudeHistory : history).read(
    host,
    password,
    lead.sessionId!,
  );
  const snapshot = researchConversation(detail);
  if (!snapshot.text.trim())
    throw new Error(
      "아직 읽을 수 있는 대화가 없습니다. 주 대화에서 이야기를 나눈 뒤 다시 시도하세요.",
    );
  return snapshot;
}
app.get("/api/research/:id/preparation-context", async (req, res) => {
  res.json(await preparationConversation(String(req.params.id)));
});
app.post("/api/research/:id/proposal", (req, res) => {
  const { revision, ...proposal } = researchProposalSchema
    .extend({ revision: z.number().int().min(1) })
    .parse(req.body);
  res.json(
    research.proposal(String(req.params.id), proposal, "user", revision),
  );
});
app.post("/api/research/:id/plan-request", (req, res) => {
  res.json(research.requestPlan(String(req.params.id)));
});
app.delete("/api/research/:id/preparation", (req, res) => {
  res.json(research.removePreparation(String(req.params.id)));
});
app.delete("/api/research/:id", (req, res) => {
  res.json(research.remove([String(req.params.id)]));
});
app.delete("/api/research", (req, res) => {
  const body = z
    .object({ ids: z.array(z.string().min(1).max(256)).min(1).max(100) })
    .strict()
    .parse(req.body);
  res.json(research.remove(body.ids));
});
const startingResearch = new Set<string>();
app.post("/api/research/:id/start", async (req, res) => {
  const id = String(req.params.id),
    body = researchStartSchema.parse(req.body);
  if (startingResearch.has(id))
    throw new Error("공동 작업을 준비 중입니다. 잠시 기다리세요.");
  startingResearch.add(id);
  let ownedId: string | undefined;
  try {
    const lab = research.preparing(id),
      lead = lab.participants[0];
    if (bridge.peers.runtime(lead.terminalId)?.state === "working")
      throw new Error("주 대화의 답변이 끝난 뒤 공동 작업을 시작하세요.");
    if (body.revision !== lab.revision)
      throw new Error("계획이 변경되었습니다. 최신 내용을 확인하세요.");
    if (body.manualContext && !body.context.trim())
      throw new Error("대화 기록 대신 공유할 배경을 입력하세요.");
    const conversation = body.manualContext
      ? undefined
      : await preparationConversation(id);
    const existing = body.partnerTerminalId
      ? terminals
          .list()
          .find((t) => t.id === body.partnerTerminalId && !t.exited)
      : undefined;
    if (body.partnerTerminalId && !existing?.agentKind)
      throw new Error("실행 중인 추가 AI 대화를 선택하세요.");
    if (existing && body.partnerSettings)
      throw new Error("기존 대화의 모델·effort는 해당 CLI에서 변경하세요.");
    let settings = existing
      ? existing.researchSettings
      : researchSettings(body.partnerKind, body.partnerSettings, lab.effort);
    const host = hub.host(existing?.hostId || body.partnerHostId || lab.hostId);
    const password = await passwordFor(host.id);
    if (!existing)
      settings = await validateResearchSettings(
        body.partnerKind,
        settings!,
        () => history.models(host, password),
      );
    let workspace: import("../shared/research.js").ResearchLab["workspace"];
    let partner: import("../shared/research.js").ResearchParticipant;
    if (existing) {
      if (
        body.kind === "code" &&
        existing.hostId === lead.hostId &&
        (host.kind === "ssh"
          ? posix.normalize(existing.cwd) === posix.normalize(lead.cwd)
          : resolve(existing.cwd).toLowerCase() ===
            resolve(lead.cwd).toLowerCase())
      )
        throw new Error(
          "코드 수정에는 서로 다른 작업 폴더의 대화를 선택하세요.",
        );
      partner = {
        terminalId: existing.id,
        hostId: host.id,
        sessionId: existing.agentSessionId,
        kind: existing.agentKind!,
        name: existing.title,
        cwd: existing.cwd,
        owned: false,
        ...(settings ? { settings } : {}),
      };
    } else {
      if (host.id !== lab.hostId && !body.partnerCwd)
        throw new Error("추가 AI 서버의 프로젝트 폴더를 입력하세요.");
      const cwd = await files.researchDirectory(
        host,
        body.partnerCwd || lab.cwd,
      );
      const prepared =
        host.kind === "ssh"
          ? await prepareRemoteResearchWorkspaces(host, cwd, body.kind, files, [
              body.partnerKind,
            ])
          : await prepareResearchWorkspaces(store.directory, cwd, body.kind, [
              body.partnerKind,
            ]);
      workspace = prepared.workspace;
      const terminal = await terminals.create(host, "", password, {
        program: body.partnerKind,
        title: `${lab.title.slice(0, 65)} · ${body.partnerKind === "claude" ? "Claude" : "Codex"}`,
        researchLaunch: { cwd: prepared.folders[0], ...settings! },
      });
      ownedId = terminal.id;
      partner = {
        terminalId: terminal.id,
        hostId: host.id,
        kind: body.partnerKind,
        name: terminal.title,
        cwd: prepared.folders[0],
        owned: true,
        settings,
      };
    }
    res.json(research.start(id, body, partner, conversation, workspace));
  } catch (error) {
    if (ownedId) await terminals.close(ownedId).catch(() => {});
    throw error;
  } finally {
    startingResearch.delete(id);
  }
});

app.post("/api/research", async (req, res) => {
  const body = researchCreateSchema.parse(req.body);
  const selectedHostId =
    body.hostId ||
    (body.terminalIds
      ? terminals.list().find((t) => t.id === body.terminalIds![0])?.hostId
      : undefined) ||
    store.data.hosts.find((h) => h.kind === "local")?.id;
  if (!selectedHostId) throw new Error("연구할 서버를 선택하세요.");
  const host = hub.host(selectedHostId);
  const password = await passwordFor(host.id);
  const cwd = await files.researchDirectory(host, body.cwd);
  let participants: import("../shared/research.js").ResearchParticipant[];
  let workspace: import("../shared/research.js").ResearchLab["workspace"];
  const owned: string[] = [];
  try {
    if (body.terminalIds) {
      participants = body.terminalIds.map((id) => {
        const terminal = terminals.list().find((t) => t.id === id && !t.exited);
        if (!terminal || !terminal.agentKind)
          throw new Error("실행 중인 AI 세션을 선택하세요.");
        return {
          terminalId: id,
          hostId: terminal.hostId,
          sessionId: terminal.agentSessionId,
          name: terminal.title,
          kind: terminal.agentKind,
          cwd: terminal.cwd,
          owned: false,
        };
      });
      if (
        body.kind === "code" &&
        participants[0].hostId === participants[1].hostId &&
        (host.kind === "ssh"
          ? posix.normalize(participants[0].cwd) ===
            posix.normalize(participants[1].cwd)
          : resolve(participants[0].cwd).toLowerCase() ===
            resolve(participants[1].cwd).toLowerCase())
      )
        throw new Error(
          "코드 공동 수정에는 서로 다른 작업 폴더의 세션을 선택하거나 새 연구 세션을 만드세요.",
        );
    } else {
      const prepared =
        host.kind === "ssh"
          ? await prepareRemoteResearchWorkspaces(host, cwd, body.kind, files)
          : await prepareResearchWorkspaces(store.directory, cwd, body.kind);
      workspace = prepared.workspace;
      participants = [];
      for (const [i, kind] of (["claude", "codex"] as const).entries()) {
        const terminal = await terminals.create(host, "", password, {
          program: kind,
          title: `${body.title.slice(0, 65)} · ${kind === "claude" ? "Claude" : "Codex"}`,
          researchLaunch: { cwd: prepared.folders[i], effort: body.effort },
        });
        owned.push(terminal.id);
        participants.push({
          terminalId: terminal.id,
          hostId: host.id,
          name: terminal.title,
          kind,
          cwd: prepared.folders[i],
          owned: true,
        });
      }
    }
    const lab = research.create(
      { ...body, cwd, hostId: host.id },
      participants,
      workspace,
    );
    res.json(lab);
  } catch (error) {
    await Promise.allSettled(owned.map((id) => terminals.close(id)));
    throw error;
  }
});
app.post("/api/research/:id/control", (req, res) => {
  const body = z
    .object({
      action: z.enum(["pause", "resume", "retry", "answer"]),
      directive: z.string().max(4000).optional(),
      decisionAssignmentId: z.string().min(1).max(256).optional(),
    })
    .strict()
    .parse(req.body);
  res.json(
    research.control(
      String(req.params.id),
      body.action,
      body.directive,
      body.decisionAssignmentId,
    ),
  );
});
app.post("/api/research/:id/rebind", (req, res) => {
  const body = z
    .object({ terminalIds: z.array(z.string()).min(1).max(2) })
    .strict()
    .parse(req.body);
  res.json(research.rebind(String(req.params.id), body.terminalIds));
});
app.post("/api/research/:id/export", (req, res) => {
  const lab = research.get(String(req.params.id));
  if (!lab.bestResult.trim())
    throw new Error("아직 저장된 연구 결과가 없습니다.");
  const directory = join(store.directory, "research-results");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${lab.id}.md`);
  writeFileSync(
    path,
    `# ${lab.title}\n\n${lab.status === "completed" ? "최종 검토를 마친 결과" : "현재까지의 결과 · 검토 진행 중"}\n\n${lab.bestResult}\n`,
    { mode: 0o600 },
  );
  const local = store.data.hosts.find((h) => h.kind === "local");
  if (!local) throw new Error("결과 문서를 볼 로컬 서버가 없습니다.");
  res.json({ path, hostId: local.id });
});
const resumingThreads = new Map<
  string,
  Promise<import("../shared/types.js").TerminalInfo>
>();
app.post("/api/research/:id/reopen", async (req, res) => {
  const lab = research.get(String(req.params.id));
  if (!["preparing", "paused", "needs-input"].includes(lab.status))
    throw new Error("과제를 일시정지한 뒤 원래 대화를 다시 연결하세요.");
  if (lab.participants.some((p) => !p.sessionId))
    throw new Error(
      "아직 원래 대화 ID가 없습니다. CLI 연결을 먼저 확인하세요.",
    );
  const ids: string[] = [];
  for (const participant of lab.participants) {
    const host = hub.host(participant.hostId || lab.hostId);
    const existing = terminals
      .list()
      .find(
        (t) =>
          !t.exited &&
          t.hostId === host.id &&
          (t.agentSessionId
            ? t.agentSessionId === participant.sessionId
            : t.resumeThreadId === participant.sessionId) &&
          (t.agentKind ||
            (t.program?.startsWith("claude") ? "claude" : "codex")) ===
            participant.kind,
      );
    if (existing) ids.push(existing.id);
    else {
      const key = `research:${host.id}:${participant.kind}:${participant.sessionId}`;
      let opening = resumingThreads.get(key);
      if (!opening) {
        opening = (async () => {
          const password = await passwordFor(host.id);
          const settings = participant.owned
            ? await validateResearchSettings(
                participant.kind,
                participant.settings || { effort: lab.effort },
                () => history.models(host, password),
              )
            : undefined;
          return terminals.create(host, "", password, {
            program: participant.kind === "claude" ? "claude-resume" : "resume",
            resumeThreadId: participant.sessionId,
            title: participant.name,
            ...researchReconnectOptions(participant, settings),
          });
        })();
        resumingThreads.set(key, opening);
        void opening.finally(() => resumingThreads.delete(key)).catch(() => {});
      }
      const terminal = await opening;
      ids.push(terminal.id);
    }
  }
  res.json({
    terminalIds: ids,
    labId: lab.id,
    note: "원래 대화가 연결되면 재연결을 누르세요.",
  });
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
      startupPlaceholder: z.boolean().optional(),
      autoApprove: z.boolean().default(false),
      sshSessionMode: z.enum(["direct", "tmux"]).optional(),
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
    {
      program: body.program,
      title: body.title,
      colors: body.colors,
      startupPlaceholder: body.startupPlaceholder,
      sshSessionMode:
        body.sshSessionMode ?? (host.kind === "ssh" ? "tmux" : "direct"),
    },
  );
  try {
    if (body.autoApprove) autoApproval.set(terminal.id, true);
    if (host.kind === "ssh" && password) {
      if (body.savePassword) await credentials.set(host, password);
      hub.passwords.set(host.id, password);
    }
  } catch (error) {
    await terminals.close(terminal.id).catch(() => {});
    throw error;
  }
  broadcastState();
  res.json({ ...terminal, autoApproval: autoApproval.state(terminal.id) });
});
app.patch("/api/terminals/:id/auto-approval", (req, res) => {
  const { enabled } = z
    .object({ enabled: z.boolean() })
    .strict()
    .parse(req.body);
  res.json(autoApproval.set(String(req.params.id), enabled));
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
  if (
    !desktop.device(req) &&
    !validToken(req.headers["x-harbor-token"], token)
  ) {
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
app.get("/api/hosts/:id/history/:threadId/activity/:ref", (req, res) => {
  const host = hub.host(String(req.params.id));
  const provider = historyProvider.parse(req.query.provider);
  const sessionId = historyThreadId.parse(req.params.threadId);
  const ref = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(req.params.ref);
  const offset = z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(0)
    .parse(req.query.offset);
  res.json(historyActivities.read(host, provider, sessionId, ref, offset));
});
app.get("/api/hosts/:id/history/:threadId", async (req, res) => {
  const host = hub.host(String(req.params.id));
  res.json(
    serializeHistoryDetailForRead(
      await historyReader(historyProvider.parse(req.query.provider)).read(
        host,
        await passwordFor(host.id),
        historyThreadId.parse(req.params.threadId),
        z.string().max(4000).optional().parse(req.query.cursor),
        {
          includeActivity:
            z.enum(["0", "1"]).optional().parse(req.query.includeActivity) ===
            "1",
        },
      ),
    ),
  );
});
const historyResumer = new HistoryResumer(
  terminals,
  passwordFor,
  (provider, host, password, threadId) =>
    historyReader(provider).summary(host, password, threadId),
  (cwd) => cleanPath.min(1).parse(cwd),
);
app.post("/api/hosts/:id/history/:threadId/resume", async (req, res) => {
  const body = z
    .object({
      colors: terminalColorsInput.optional(),
      provider: historyProvider,
      sshSessionMode: z.enum(["direct", "tmux"]).optional(),
    })
    .parse(req.body || {});
  const host = hub.host(String(req.params.id));
  const threadId = historyThreadId.parse(req.params.threadId);
  res.json(await historyResumer.resume(host, threadId, body));
});
app.post("/api/terminals/:id/close", async (req, res) => {
  await terminals.close(String(req.params.id));
  richTerminals.clear(String(req.params.id));
  res.json({ ok: true });
});
app.post("/api/terminals/:id/reconnect", async (req, res) => {
  const { password } = z
    .object({ password: z.string().max(4096).optional() })
    .parse(req.body || {});
  try {
    res.json(await terminals.reconnect(String(req.params.id), password));
  } catch (error) {
    res
      .status(409)
      .json({ error: errorText(error), code: disconnectCategory(error) });
  }
});
app.get("/api/terminals/:id/usage", async (req, res) => {
  if (
    !desktop.device(req) &&
    !validToken(req.headers["x-harbor-token"], token)
  ) {
    res.status(403).json({ error: "화면을 새로고침해 주세요." });
    return;
  }
  const terminal = terminals
    .list()
    .find((t) => t.id === req.params.id && !t.exited);
  if (!terminal || !terminal.agentKind) {
    res.json({ usage: null });
    return;
  }
  const sessionId = z.string().uuid().parse(req.query.sessionId);
  const bound = terminal.agentSessionId || terminal.resumeThreadId;
  if (bound && bound !== sessionId) {
    res.json({ usage: null });
    return;
  }
  const host = hub.host(terminal.hostId);
  const usage = await terminalUsage.read(
    terminal.id,
    terminal.agentKind,
    sessionId,
    async () => {
      const password = await passwordFor(host.id);
      if (terminal.agentKind === "claude") {
        const native = await files
          .usageSnapshot(host, `~/.cache/harbor/usage/claude-${sessionId}.json`)
          .then((text) => claudeUsageSnapshot(text, sessionId))
          .catch(() => null);
        const saved = await claudeHistory
          .usage(host, password, sessionId, terminal.cwd)
          .catch((error) => {
            if (native) return null;
            throw error;
          });
        return mergeClaudeUsage(saved, native);
      }
      const file = await history.usagePath(host, password, sessionId);
      return file
        ? codexUsageHistory.read(
            host.id,
            sessionId,
            file,
            (start) => files.usageChunk(host, file, start),
            () => files.usageTail(host, file),
          )
        : null;
    },
  );
  const enriched =
    usage?.provider === "codex" && usage.crew
      ? {
          ...usage,
          crew: codexAgentTelemetry.read(
            host.id,
            sessionId,
            usage.crew,
            async (id) =>
              history.agentTelemetryPath(host, await passwordFor(host.id), id),
            (path) => files.usageTail(host, path),
          ),
        }
      : usage;
  res.json({ usage: enriched });
});
app.get("/api/terminals/:id/rich", (req, res) => {
  res.json({
    enabled: richTerminals.enabled(String(req.params.id)),
    blocks: richTerminals.list(String(req.params.id)),
  });
});
app.post("/api/terminals/:id/rich/:blockId/layout", (req, res) => {
  const terminal = terminals.list().find((t) => t.id === String(req.params.id));
  if (!terminal || terminal.agentSessionId !== req.body?.sessionId)
    throw new Error("현재 대화의 조판 요청이 아닙니다.");
  richTerminals.acknowledge(terminal.id, String(req.params.blockId), req.body);
  res.json({ ok: true });
});
app.post("/api/terminals/:id/dismiss-startup", (req, res) => {
  res.json({ dismissed: terminals.dismissStartup(String(req.params.id)) });
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
app.post("/api/terminals/:id/annotations/attach", (req, res) => {
  const terminal = annotationTerminal(String(req.params.id));
  const { annotations } = z
    .object({ annotations: annotationCommentsSchema })
    .strict()
    .parse(req.body);
  bridge.annotations.attach(terminal.id, annotations);
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
    !desktop.device(req) &&
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
  if (
    !desktop.device(req) &&
    !validToken(req.headers["x-harbor-token"], token)
  ) {
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
app.post("/api/hosts/:id/files/html", async (req, res) => {
  res.json(
    await htmlPreviews.open(
      String(req.params.id),
      cleanPath.min(1).parse(req.body.path),
    ),
  );
});
app.get("/api/hosts/:id/files/image", async (req, res) => {
  if (!desktop.device(req) && !validToken(req.query.token, token)) {
    res.status(403).json({ error: "이미지 연결이 만료되었습니다." });
    return;
  }
  const image = await files.image(
    hub.host(String(req.params.id)),
    cleanPath.min(1).parse(req.query.path),
  );
  await sendMediaFile(req, res, image);
});
app.get("/api/hosts/:id/files/pdf", async (req, res) => {
  if (!desktop.device(req) && !validToken(req.query.token, token)) {
    res.status(403).json({ error: "PDF 연결이 만료되었습니다." });
    return;
  }
  const filename = cleanPath.min(1).parse(req.query.path);
  await sendMediaFile(
    req,
    res,
    await files.pdf(hub.host(String(req.params.id)), filename),
  );
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
app.post("/api/hosts/:id/files/upload-plan", async (req, res) => {
  const body = z
    .object({
      path: cleanPath.min(1),
      directories: z.array(cleanPath.min(1)).max(UPLOAD_ENTRY_LIMIT),
      files: z
        .array(
          z.object({
            relativePath: cleanPath.min(1),
            size: z.number().int().min(0).max(MAX_UPLOAD_BYTES),
          }),
        )
        .max(UPLOAD_ENTRY_LIMIT),
    })
    .parse(req.body);
  const controller = new AbortController();
  res.once("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  res.json(
    await files.prepareUpload(
      hub.host(String(req.params.id)),
      body.path,
      body,
      controller.signal,
    ),
  );
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
    res.status(error.status || 400).json({
      error: errorText(error).slice(0, 5000),
      ...(error?.level === "client-authentication"
        ? { code: "SSH_AUTH_REQUIRED" }
        : {}),
    });
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
await mobile.start();
await terminals.restore();
terminalAnnotations.retain(new Set(terminals.list().map((t) => t.id)));
richTerminals.on("block", (id, block) => {
  for (const [socket, subscription] of subscriptions)
    if (subscription.terminals.has(id))
      send(socket, { type: "terminal-rich", id, block });
});
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
let shuttingDown = false;
function shutdown(reason: "signal-int" | "signal-term" | "desktop-request") {
  if (shuttingDown) return;
  shuttingDown = true;
  runtimeDiagnostics.shutdown(reason);
  void mobile.stop();
  tailscaleSetup.close();
  clearTimeout(stateBroadcast);
  clearInterval(researchTick);
  research.shutdown();
  clearInterval(heartbeat);
  codexPeers.disposeAll();
  ideChats.close();
  hub.shutdown();
  history.shutdown();
  codexUsageHistory.shutdown();
  codexAgentTelemetry.shutdown();
  claudeHistory.shutdown();
  requests.shutdown();
  autoApproval.dispose();
  terminals.shutdown();
  richTerminals.dispose();
  files.shutdown();
  wsServer.close();
  server.close();
  bridgeServer.close();
  bridgeServer.closeAllConnections();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", () => shutdown("signal-int"));
process.on("SIGTERM", () => shutdown("signal-term"));
process.on("message", (message: unknown) => {
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "harbor:power" &&
    "event" in message &&
    (message.event === "suspend" || message.event === "resume")
  ) {
    terminals.powerEvent(message.event);
    return;
  }
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "harbor:shutdown"
  )
    shutdown("desktop-request");
});
