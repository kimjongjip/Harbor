import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { researchSettings } from "./research-settings.js";
import { cliApprovalArgs } from "./cli-approval.js";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { connect as tcpConnect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { PeerRuntime } from "./peer-delivery.js";
import * as pty from "node-pty";
import type { Client, ClientChannel } from "ssh2";
import type {
  HostConfig,
  TerminalColors,
  TerminalInfo,
} from "../shared/types.js";
import { sshArgs } from "./ssh.js";
import { passwordConnection } from "./ssh-connect.js";
import { shellQuote } from "./ssh.js";
import {
  DurableRegistry,
  DurableSshError,
  checkDurableSession,
  createDurableSession,
  disconnectCategory,
  safeSshErrorDetails,
  durableNames,
  durableEnvironmentScript,
  execRemote,
  hostFingerprint,
  restoreDurableSecrets,
  tmux,
  tmuxTarget,
  type DurableRecord,
  type DurableSecrets,
  type DisconnectCategory,
} from "./durable-ssh.js";
import { TerminalScreen } from "./terminal-screen.js";
import { TerminalColorResponder } from "./terminal-colors.js";
import { TerminalCwdObserver } from "./terminal-cwd.js";
import { claudeArguments, type ClaudeHookEvent } from "./claude-hooks.js";
import {
  bashInitialization,
  codexArguments,
  powershellInitialization,
  powershellStartup,
  remoteTerminalCommand,
  type TerminalOptions,
} from "./terminal-shell.js";

interface TerminalBridge {
  port: number;
  issue(id: string): {
    token: string;
    path: string;
    hookToken?: string;
    hookPath?: string;
  };
  revoke(id: string): void;
  restore?(id: string, secrets: DurableSecrets): void;
}
interface Entry {
  info: TerminalInfo;
  process: Pick<pty.IPty, "write" | "resize" | "kill">;
  buffer: TerminalScreen;
  colors: TerminalColorResponder;
  cwdObserver: TerminalCwdObserver;
  connection?: Client;
  durable?: {
    record: DurableRecord;
    host: HostConfig;
    password?: string;
    secrets?: DurableSecrets;
    stopped: boolean;
    timer?: ReturnType<typeof setTimeout>;
    monitor?: ReturnType<typeof setInterval>;
    reconnecting?: Promise<TerminalInfo>;
    generation: number;
    channel?: ClientChannel;
    cols: number;
    rows: number;
    sockets: Set<Socket>;
    peerRuntime?: PeerRuntime;
    launching?: Promise<void>;
  };
}

export class Terminals extends EventEmitter {
  private entries = new Map<string, Entry>();
  private opening = 0;
  private sequence = new Map<string, number>();
  private bridge?: TerminalBridge;
  private registry?: DurableRegistry;
  private recovery?: {
    hosts(): HostConfig[];
    password(host: HostConfig): Promise<string | undefined>;
  };
  private readonly connect: typeof passwordConnection;
  private readonly monitorInterval: number;
  constructor(
    options: {
      directory?: string;
      connect?: typeof passwordConnection;
      monitorIntervalMs?: number;
    } = {},
  ) {
    super();
    if (options.directory)
      this.registry = new DurableRegistry(resolve(options.directory));
    this.connect = options.connect || passwordConnection;
    this.monitorInterval = Math.max(100, options.monitorIntervalMs || 15000);
  }
  configureRecovery(recovery: {
    hosts(): HostConfig[];
    password(host: HostConfig): Promise<string | undefined>;
  }) {
    this.recovery = recovery;
  }
  powerEvent(event: "suspend" | "resume", at = Date.now()) {
    if (event !== "suspend" && event !== "resume") return;
    this.registry?.trace(
      "system",
      event === "suspend" ? "power-suspend" : "power-resume",
      { at: Number.isSafeInteger(at) && at > 0 ? at : Date.now() },
    );
    if (event === "resume")
      for (const entry of this.entries.values()) {
        if (
          !entry.durable ||
          entry.durable.stopped ||
          entry.info.exited ||
          entry.info.connectionState === "connected"
        )
          continue;
        void this.reconnect(entry.info.id).catch(() => undefined);
      }
  }
  configureBridge(bridge: TerminalBridge) {
    this.bridge = bridge;
  }
  markAgentConnected(id: string, kind: "codex" | "claude" = "codex") {
    const entry = this.entries.get(id);
    if (entry && !entry.info.exited) {
      entry.info.agentConnected = true;
      entry.info.agentKind = kind;
      this.persist(entry);
      this.emit("change");
    }
  }
  markPeerRuntime(id: string, runtime: PeerRuntime) {
    const entry = this.entries.get(id);
    if (!entry || entry.info.exited) return;
    if (
      entry.durable &&
      runtime.kind === "claude" &&
      runtime.state !== "offline"
    )
      entry.durable.peerRuntime = { ...runtime };
    if (
      entry.durable &&
      runtime.kind === "codex" &&
      runtime.state !== "offline"
    ) {
      const prior = entry.durable.peerRuntime;
      if (runtime.endpoint || prior?.endpoint) {
        entry.durable.peerRuntime = {
          ...prior,
          ...runtime,
          endpoint: runtime.endpoint || prior!.endpoint,
        };
        const connection = entry.connection;
        if (connection) {
          const encoded = Buffer.from(
            JSON.stringify(entry.durable.peerRuntime),
          ).toString("base64");
          // The private app-server capability travels over SSH stdin only.
          void execRemote(
            connection,
            "sh -s",
            `${durableEnvironmentScript(entry.durable.record, "HARBOR_CODEX_RUNTIME", encoded)}\n`,
          ).catch(() => undefined);
        }
      }
    }
    entry.info.peerDelivery = runtime.delivery;
    entry.info.peerDetail = runtime.detail;
    if (runtime.state !== "offline") {
      entry.info.agentKind = runtime.kind;
      if (runtime.sessionId) entry.info.agentSessionId = runtime.sessionId;
      if (runtime.kind !== "claude" || !entry.info.agentState)
        entry.info.agentState = runtime.state;
    }
    this.persist(entry);
    this.emit("change");
  }
  /** Only connect to this terminal's loopback, through its existing SSH connection. */
  async connectPeerRuntime(id: string, port: number): Promise<Duplex> {
    const entry = this.entries.get(id);
    if (
      !entry ||
      entry.info.exited ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw new Error("세션의 자동 연결을 사용할 수 없습니다.");
    if (
      entry.durable &&
      (!entry.connection || entry.info.connectionState !== "connected")
    )
      throw new Error("SSH 재연결이 끝난 뒤 AI 연결을 다시 시도하세요.");
    if (entry.connection) {
      return new Promise<Duplex>((resolve, reject) =>
        entry.connection!.forwardOut(
          "127.0.0.1",
          0,
          "127.0.0.1",
          port,
          (error, stream) => (error ? reject(error) : resolve(stream)),
        ),
      );
    }
    // Interactive system-SSH fallback has no managed control connection.
    if (entry.info.integration !== "ready")
      throw new Error("관리형 연결이 아닙니다.");
    return new Promise<Duplex>((resolve, reject) => {
      const socket = tcpConnect({ host: "127.0.0.1", port });
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", fail);
      socket.once("connect", () => {
        socket.setTimeout(0);
        socket.off("error", fail);
        resolve(socket);
      });
      socket.setTimeout(10000, () => fail(new Error("세션 연결 시간 초과")));
    });
  }
  markAgentState(id: string, state: "shell" | "codex") {
    const entry = this.entries.get(id);
    if (entry && !entry.info.exited) {
      entry.info.agentConnected = state === "codex";
      // Once Codex exits, this shell no longer owns the resumed conversation.
      if (state === "shell") {
        if (entry.durable) {
          delete entry.durable.peerRuntime;
          if (entry.connection)
            void execRemote(
              entry.connection,
              `${tmux(entry.durable.record)} set-environment -u -t ${tmuxTarget(entry.durable.record)} HARBOR_CODEX_RUNTIME`,
            ).catch(() => undefined);
        }
        delete entry.info.resumeThreadId;
        delete entry.info.agentKind;
        delete entry.info.agentState;
        delete entry.info.agentSessionId;
        delete entry.info.peerDelivery;
        delete entry.info.peerDetail;
      }
      this.persist(entry);
      this.emit("change");
    }
  }
  markClaudeEvent(id: string, event: ClaudeHookEvent) {
    const entry = this.entries.get(id);
    if (!entry || entry.info.exited) return;
    const info = entry.info;
    if (event.hook_event_name === "SessionEnd") {
      if (info.agentSessionId !== event.session_id) return;
      if (entry.durable?.peerRuntime?.kind === "claude")
        delete entry.durable.peerRuntime;
      delete info.agentKind;
      delete info.agentSessionId;
      delete info.agentState;
      delete info.resumeThreadId;
      info.agentConnected = false;
    } else {
      info.agentKind = "claude";
      info.agentConnected = true;
      info.agentSessionId = event.session_id;
      if (
        event.cwd &&
        !/[\x00-\x1f]/.test(event.cwd) &&
        (isAbsolute(event.cwd) || event.cwd.startsWith("/"))
      )
        info.cwd = event.cwd;
      if (
        ["UserPromptSubmit", "PostToolUse", "PostToolUseFailure"].includes(
          event.hook_event_name,
        )
      )
        info.agentState = "working";
      else if (
        event.hook_event_name === "PermissionRequest" ||
        event.hook_event_name === "Notification"
      )
        info.agentState = "waiting";
      else if (
        ["SessionStart", "Stop", "StopFailure"].includes(event.hook_event_name)
      )
        info.agentState = "idle";
    }
    this.persist(entry);
    this.emit("change");
  }
  markClaudeContinuation(id: string, sessionId: string) {
    const entry = this.entries.get(id);
    if (
      !entry ||
      entry.info.exited ||
      entry.info.agentKind !== "claude" ||
      entry.info.agentSessionId !== sessionId
    )
      return;
    // A successful Stop response requested more native work, rather than input.
    entry.info.agentState = "working";
    this.persist(entry);
    this.emit("change");
  }
  list() {
    return [...this.entries.values()].map((t) => t.info);
  }
  private receive(entry: Entry, data: string) {
    const reported = entry.cwdObserver.consume(data).at(-1);
    if (reported && reported !== entry.info.cwd) {
      entry.info.cwd = reported;
      this.persist(entry);
      this.emit("change");
    }
    const { output, replies } = entry.colors.consume(data);
    if (!entry.info.exited)
      for (const reply of replies) {
        try {
          entry.process.write(reply);
        } catch {
          /* The PTY may have just closed. */
        }
      }
    if (output) {
      entry.buffer.append(output);
      this.emit("data", entry.info.id, output);
    }
  }
  private exited(entry: Entry, code: number) {
    if (entry.info.exited) return;
    const pending = entry.colors.flush();
    if (pending) {
      entry.buffer.append(pending);
      this.emit("data", entry.info.id, pending);
    }
    entry.info.exited = true;
    entry.info.connectionState = "exited";
    entry.info.exitCode = code;
    entry.info.agentConnected = false;
    this.registry?.trace(entry.info.id, "state", { state: "exited" });
    this.bridge?.revoke(entry.info.id);
    this.emit("exit", entry.info.id, code);
    this.emit("change");
  }
  async create(
    host: HostConfig,
    cwd: string,
    password?: string,
    options: TerminalOptions = {},
  ) {
    if (options.sshSessionMode === "tmux" && host.kind !== "ssh")
      throw new Error("tmux 세션 유지는 SSH 서버에서만 선택할 수 있습니다.");
    // Snapshot the user's launch preference. Saving a new server default must
    // never change a running CLI or an existing tmux session's approval mode.
    host = { ...host };
    if (options.researchLaunch) {
      const kind = (options.program || "").startsWith("claude")
        ? "claude"
        : "codex";
      const settings = researchSettings(kind, {
        model: options.researchLaunch.model,
        effort: options.researchLaunch.effort,
      });
      options = {
        ...options,
        researchLaunch: { cwd: options.researchLaunch.cwd, ...settings },
      };
    }
    if (this.entries.size + this.opening >= 16)
      throw new Error(
        "터미널은 최대 16개까지 열 수 있습니다. 사용하지 않는 터미널을 닫으세요.",
      );
    cwd = host.kind === "local" ? homedir() : "~";
    this.opening++;
    const program = options.program || "shell";
    const sequence = (this.sequence.get(host.id) || 0) + 1;
    this.sequence.set(host.id, sequence);
    const info: TerminalInfo = {
      cliApprovalMode:
        host.cliApprovalMode === "full-access" ? "full-access" : "native",
      id: randomUUID(),
      hostId: host.id,
      cwd,
      program,
      title: options.title?.trim() || `${host.name} ${sequence}`,
      exited: false,
      integration: "unavailable",
      ...(options.researchLaunch
        ? {
            researchSettings: {
              model: options.researchLaunch.model,
              effort: options.researchLaunch.effort,
            },
          }
        : {}),
      ...(host.kind === "local" &&
      program === "shell" &&
      options.startupPlaceholder
        ? { startupPlaceholder: true }
        : {}),
      agentConnected: false,
      connectionState: "connected",
      ...(options.resumeThreadId
        ? { resumeThreadId: options.resumeThreadId }
        : {}),
    };
    try {
      if (host.kind === "ssh") {
        let connection: Client | undefined;
        try {
          connection = await this.connect(host, password);
        } catch (error) {
          // Interactive OpenSSH remains available for key passphrases and jump hosts.
          // A supplied/saved password must fail visibly rather than silently changing auth.
          if (
            password ||
            options.researchLaunch ||
            options.sshSessionMode === "tmux"
          )
            throw error;
        }
        if (connection && options.sshSessionMode === "tmux")
          return await this.remote(
            host,
            info,
            connection,
            options.colors,
            options.resumeCwd,
            options.researchLaunch,
            password,
          );
        if (connection) {
          info.persistent = false;
          info.persistenceDetail =
            "일반 SSH 연결입니다. tmux를 자동 실행하지 않습니다. 연결이 종료되면 원격 작업도 종료될 수 있습니다.";
          return await this.ephemeralRemote(
            host,
            info,
            connection,
            options.colors,
            options.resumeCwd,
            options.researchLaunch,
          );
        }
      }
      let command: string;
      let args: string[];
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      };
      delete env.HARBOR_SESSION_TOKEN;
      if (host.kind === "local") {
        if (!isAbsolute(cwd) || !statSync(cwd).isDirectory())
          throw new Error("터미널의 작업 폴더를 확인하세요.");
        if (process.platform === "win32") {
          command = "powershell.exe";
          const issued = this.bridge?.issue(info.id);
          if (issued) {
            env.HARBOR_SESSION_TOKEN = issued.token;
            if (issued.hookToken && issued.hookPath) {
              env.HARBOR_HOOK_TOKEN = issued.hookToken;
              env.HARBOR_HOOK_URL = `http://127.0.0.1:${this.bridge!.port}${issued.hookPath}`;
            }
            info.integration = "ready";
          }
          const url =
            issued && `http://127.0.0.1:${this.bridge!.port}${issued.path}`;
          const script = powershellInitialization(
            host,
            program,
            url,
            options.resumeThreadId,
            !!issued?.hookToken,
            options.resumeCwd,
            options.researchLaunch,
          );
          const startup = powershellStartup(script);
          args = startup.args;
          Object.assign(env, startup.env);
        } else if (program !== "shell") {
          command = program.startsWith("claude")
            ? "claude"
            : host.codexPath || "codex";
          args = program.startsWith("claude")
            ? [
                ...cliApprovalArgs(host, "claude"),
                ...claudeArguments(
                  undefined,
                  options.resumeThreadId,
                  program === "claude-resume",
                ),
              ]
            : [
                ...cliApprovalArgs(host, "codex"),
                ...codexArguments(program, undefined, options.resumeThreadId),
              ];
        } else {
          if (host.cliApprovalMode === "full-access")
            throw new Error(
              "이 로컬 셸에는 AI 실행 승인 설정을 자동 적용할 수 없습니다. Codex·Claude로 직접 시작하거나 CLI 옵션을 지정하세요.",
            );
          command = process.env.SHELL || "/bin/bash";
          args = ["-l"];
        }
      } else {
        if (program === "shell" && host.cliApprovalMode === "full-access")
          throw new Error(
            "현재 SSH 인증 방식에서는 승인 설정을 적용하는 셸 연결을 사용할 수 없습니다. 저장된 SSH 인증으로 연결하거나 CLI 설정 사용으로 바꾸세요.",
          );
        command = process.platform === "win32" ? "ssh.exe" : "ssh";
        info.persistent = false;
        info.persistenceDetail =
          "일반 SSH 연결: 현재 인증·점프 호스트 방식에서는 작업 유지와 자동 재연결을 지원하지 않습니다. 연결이 끊기면 이 터미널의 작업도 종료될 수 있습니다.";
        args = [
          ...sshArgs(host, true),
          remoteTerminalCommand(host, cwd, program, options.resumeThreadId),
        ];
      }
      const child = pty.spawn(command, args, {
        useConptyDll: process.platform === "win32",
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd: host.kind === "local" ? cwd : process.cwd(),
        env,
      });
      const entry = {
        info,
        process: child,
        buffer: new TerminalScreen(),
        colors: new TerminalColorResponder(options.colors),
        cwdObserver: new TerminalCwdObserver(),
      };
      this.entries.set(info.id, entry);
      child.onData((data) => this.receive(entry, data));
      child.onExit(({ exitCode }) => this.exited(entry, exitCode));
      this.registry?.trace(info.id, "state", { state: "connected" });
      this.emit("change");
      return info;
    } catch (error) {
      this.bridge?.revoke(info.id);
      throw error;
    } finally {
      this.opening--;
    }
  }
  private state(
    entry: Entry,
    state: NonNullable<TerminalInfo["connectionState"]>,
    category?: DisconnectCategory,
  ) {
    entry.info.connectionState = state;
    if (category) {
      entry.info.connectionIssue = category;
      const reasons: Record<DisconnectCategory, string> = {
        network:
          "네트워크 연결이 끊겼습니다. 재연결 후 서버 작업 상태를 확인합니다.",
        timeout:
          "SSH 응답 시간이 초과됐습니다. 재연결 후 서버 작업 상태를 확인합니다.",
        authentication:
          "SSH 인증을 다시 확인하세요. 서버 작업을 재실행하지 않습니다.",
        forwarding:
          "기존 Harbor 연결 포트를 복구하지 못했습니다. 서버 작업 상태를 확인해야 합니다.",
        "remote-missing":
          "서버 유지 세션을 찾을 수 없습니다. 서버 재부팅·외부 종료 여부를 확인하세요.",
        capability: "서버에 tmux와 bash가 필요합니다.",
        management:
          "SSH 접속 후 서버의 세션 상태를 확인하지 못했습니다. tmux와 접근 권한을 확인하세요.",
        transport:
          "SSH 연결이 끊겼습니다. 재연결 후 서버 작업 상태를 확인합니다.",
        "remote-exit": "서버의 셸이 종료됐습니다.",
        "backend-stop": "Harbor 연결을 분리했습니다. 서버 작업은 유지됩니다.",
      };
      entry.info.disconnectReason = reasons[category];
      entry.info.lastDisconnectedAt = Date.now();
      this.registry?.diagnose(
        entry.info.id,
        category,
        entry.info.reconnectAttempt,
        state,
      );
    } else {
      if (state === "connected") {
        delete entry.info.disconnectReason;
        delete entry.info.connectionIssue;
      }
      this.registry?.trace(entry.info.id, "state", {
        state,
        attempt: entry.info.reconnectAttempt,
      });
    }
    this.persist(entry);
    this.emit("change");
  }
  private persist(entry: Entry) {
    if (entry.durable && !entry.info.exited) {
      entry.durable.record.info = { ...entry.info };
      this.registry?.put(entry.durable.record);
    }
  }
  private async forward(
    connection: Client,
    sockets: Set<Socket>,
    requested = 0,
  ) {
    if (!this.bridge) return 0;
    let remotePort: number;
    try {
      remotePort = await new Promise<number>((resolve, reject) =>
        connection.forwardIn("127.0.0.1", requested, (error, port) =>
          error ? reject(error) : resolve(port),
        ),
      );
    } catch {
      throw new DurableSshError(
        "forwarding",
        "SSH TCP forwarding을 사용할 수 없습니다. 서버 연결 설정을 확인하세요.",
      );
    }
    if (requested && requested !== remotePort)
      throw new DurableSshError(
        "forwarding",
        "기존 SSH 포트를 복원하지 못했습니다.",
      );
    connection.on("tcp connection", (details, accept, reject) => {
      if (details.destIP !== "127.0.0.1" || details.destPort !== remotePort) {
        reject();
        return;
      }
      const socket = tcpConnect({ host: "127.0.0.1", port: this.bridge!.port });
      sockets.add(socket);
      const stream = accept();
      socket.on("error", () => stream.destroy());
      stream.on("error", () => socket.destroy());
      socket.on("close", () => {
        sockets.delete(socket);
        stream.destroy();
      });
      stream.on("close", () => socket.destroy());
      stream.pipe(socket).pipe(stream);
    });
    return remotePort;
  }
  private async remote(
    host: HostConfig,
    info: TerminalInfo,
    connection: Client,
    colors?: TerminalColors,
    resumeCwd?: string,
    researchLaunch?: TerminalOptions["researchLaunch"],
    password?: string,
  ) {
    const sockets = new Set<Socket>();
    let remotePort = 0;
    try {
      try {
        remotePort = await this.forward(connection, sockets);
      } catch (error) {
        if (researchLaunch) throw error;
      }
      try {
        await execRemote(
          connection,
          "command -v tmux >/dev/null 2>&1 || exit 72; command -v bash >/dev/null 2>&1 || exit 73",
        );
      } catch (error) {
        if (
          !(error instanceof DurableSshError) ||
          error.category !== "capability"
        )
          throw error;
        throw new DurableSshError(
          "capability",
          "이 서버에 tmux와 bash가 필요합니다. 설치 후 다시 시도하거나 SSH 세션 방식을 ‘일반 SSH’로 선택하세요.",
        );
      }
      const secrets = remotePort ? this.bridge?.issue(info.id) : undefined;
      if (
        !secrets &&
        (info.program || "shell") === "shell" &&
        host.cliApprovalMode === "full-access"
      )
        throw new Error(
          "AI 실행 승인 설정을 적용하려면 관리형 SSH 연결과 TCP forwarding이 필요합니다. CLI 설정 사용으로 바꾸거나 서버 연결 설정을 확인하세요.",
        );
      const record: DurableRecord = {
        info,
        target: hostFingerprint(host),
        ...durableNames(info.id),
        remotePort,
      };
      info.persistent = true;
      info.persistenceDetail = secrets
        ? "SSH 연결이 끊겨도 서버의 같은 셸·AI 프로세스를 유지합니다. 터미널 탭의 X → 터미널 종료는 서버 작업도 종료합니다."
        : "서버 tmux에서 작업을 유지합니다. SSH TCP forwarding을 사용할 수 없어 Harbor AI 연동은 사용할 수 없습니다.";
      info.connectionState = "connecting";
      const initialization = secrets
        ? bashInitialization(
            host,
            info.cwd,
            info.program || "shell",
            {
              token: secrets.token,
              url: `http://127.0.0.1:${remotePort}${secrets.path}`,
              ...(secrets.hookToken && secrets.hookPath
                ? {
                    hook: {
                      token: secrets.hookToken,
                      url: `http://127.0.0.1:${remotePort}${secrets.hookPath}`,
                    },
                  }
                : {}),
            },
            info.resumeThreadId,
            resumeCwd,
            researchLaunch,
          )
        : `${remoteTerminalCommand(host, info.cwd, info.program || "shell", info.resumeThreadId)}\n`;
      const entry = this.durableEntry(
        host,
        info,
        record,
        colors,
        password,
        secrets,
      );
      entry.connection = connection;
      entry.durable!.sockets = sockets;
      this.entries.set(info.id, entry);
      this.state(entry, "connecting");
      try {
        entry.durable!.launching = createDurableSession(
          connection,
          record,
          initialization,
          secrets,
        );
        await entry.durable!.launching;
      } catch (error) {
        if (
          error instanceof DurableSshError &&
          (error.category === "capability" ||
            error.category === "remote-missing")
        ) {
          this.entries.delete(info.id);
          this.registry?.remove(info.id);
          entry.buffer.dispose();
          throw error;
        }
        // A dropped acknowledgement may follow a successful remote launch.
        // Keep its identity visible and recover; never launch a second CLI.
        this.disconnected(entry, error);
        return info;
      } finally {
        delete entry.durable!.launching;
      }
      if (entry.durable!.stopped) return info;
      try {
        await this.attach(entry, connection);
      } catch (error) {
        this.disconnected(entry, error);
      }
      return info;
    } catch (error) {
      connection.end();
      for (const socket of sockets) socket.destroy();
      throw error;
    }
  }
  private durableEntry(
    host: HostConfig,
    info: TerminalInfo,
    record: DurableRecord,
    colors?: TerminalColors,
    password?: string,
    secrets?: DurableSecrets,
  ): Entry {
    const entry: Entry = {
      info,
      buffer: new TerminalScreen(),
      colors: new TerminalColorResponder(colors),
      cwdObserver: new TerminalCwdObserver(),
      durable: {
        record,
        host,
        password,
        secrets,
        stopped: false,
        generation: 0,
        cols: 100,
        rows: 30,
        sockets: new Set(),
        ...(info.agentKind === "claude" && info.agentSessionId
          ? {
              peerRuntime: {
                kind: "claude" as const,
                sessionId: info.agentSessionId,
                state:
                  info.agentState === "working"
                    ? ("working" as const)
                    : ("idle" as const),
                delivery: info.peerDelivery || "hook",
              },
            }
          : {}),
      },
      process: {
        write: (data) => {
          if (info.connectionState !== "connected" || !entry.durable?.channel)
            throw new Error(
              "SSH가 다시 연결될 때까지 입력을 기다려 주세요. 입력은 자동 재전송하지 않습니다.",
            );
          entry.durable.channel.write(data);
        },
        resize: (cols, rows) => {
          entry.durable!.cols = cols;
          entry.durable!.rows = rows;
          if (info.connectionState === "connected")
            entry.durable?.channel?.setWindow(rows, cols, 0, 0);
        },
        kill: () => {
          void this.close(info.id);
        },
      },
    };
    return entry;
  }
  private async attach(entry: Entry, connection: Client) {
    const durable = entry.durable!;
    entry.connection = connection;
    const status = await checkDurableSession(connection, durable.record);
    if (status.dead) {
      this.finishRemote(entry, status.code, status.signal);
      return;
    }
    // Repair pre-1.8.3 sessions too. This changes only our dedicated tmux
    // session's input routing; it never restarts a CLI or sends it a prompt.
    await execRemote(
      connection,
      `${tmux(durable.record)} set-option -t ${tmuxTarget(durable.record)} mouse on`,
    );
    const generation = ++durable.generation;
    const channel = await new Promise<ClientChannel>((resolve, reject) =>
      connection.exec(
        `exec ${tmux(durable.record)} attach-session -t ${tmuxTarget(durable.record)}`,
        {
          pty: {
            term: "xterm-256color",
            cols: durable.cols,
            rows: durable.rows,
          },
        },
        (error, result) => (error ? reject(error) : resolve(result)),
      ),
    );
    if (durable.stopped) {
      channel.close();
      connection.end();
      return;
    }
    entry.connection = connection;
    durable.channel = channel;
    entry.info.integration = durable.secrets ? "ready" : "unavailable";
    entry.info.reconnectAttempt = 0;
    channel.setEncoding("utf8");
    channel.stderr.setEncoding("utf8");
    const current = () => !durable.stopped && generation === durable.generation;
    channel.on("data", (data: string) => {
      if (current()) this.receive(entry, data);
    });
    channel.stderr.on("data", (data: string) => {
      if (current()) this.receive(entry, data);
    });
    const lost = (error?: Error) => {
      if (current()) this.disconnected(entry, error);
    };
    channel.once("error", lost);
    channel.once("close", () => lost());
    connection.once("error", lost);
    connection.once("close", () => lost());
    // A dead pane is retained by tmux so normal exit remains distinguishable from transport loss.
    let checking = false;
    durable.monitor = setInterval(() => {
      if (checking) return;
      checking = true;
      void checkDurableSession(connection, durable.record)
        .then((status) => {
          if (!current()) return;
          if (status.dead) this.finishRemote(entry, status.code, status.signal);
          else if (status.cwd && status.cwd !== entry.info.cwd) {
            entry.info.cwd = status.cwd;
            this.persist(entry);
            this.emit("change");
          }
        })
        .catch(lost)
        .finally(() => {
          checking = false;
        });
    }, this.monitorInterval);
    durable.monitor.unref();
    this.state(entry, "connected");
    this.emit("reconnected", entry.info.id);
    if (durable.peerRuntime)
      this.emit("peer-runtime-restored", entry.info.id, {
        ...durable.peerRuntime,
        ...(entry.info.agentSessionId
          ? { sessionId: entry.info.agentSessionId }
          : {}),
      });
  }
  private finishRemote(entry: Entry, code: number, signal?: string) {
    const durable = entry.durable!;
    durable.stopped = true;
    if (signal) {
      entry.info.exitSignal = signal;
      entry.info.disconnectReason = `서버의 셸이 ${signal} 신호로 종료됐습니다.`;
    } else if (code < 0)
      entry.info.disconnectReason =
        "서버의 셸이 종료됐지만 정상 종료 코드를 확인할 수 없습니다.";
    durable.generation++;
    clearTimeout(durable.timer);
    clearInterval(durable.monitor);
    this.registry?.diagnose(entry.info.id, "remote-exit");
    this.registry?.remove(entry.info.id);
    if (entry.connection)
      void execRemote(
        entry.connection,
        `${tmux(durable.record)} kill-session -t ${tmuxTarget(durable.record)} 2>/dev/null || true`,
      )
        .finally(() => entry.connection?.end())
        .catch(() => undefined);
    for (const socket of durable.sockets) socket.destroy();
    this.exited(entry, code);
  }
  private disconnected(entry: Entry, error?: unknown) {
    const durable = entry.durable!;
    if (
      durable.stopped ||
      entry.info.connectionState === "reconnecting" ||
      entry.info.connectionState === "disconnected"
    )
      return;
    durable.generation++;
    clearInterval(durable.monitor);
    durable.channel?.close();
    durable.channel = undefined;
    entry.connection?.destroy();
    entry.connection = undefined;
    for (const socket of durable.sockets) socket.destroy();
    durable.sockets.clear();
    const category = disconnectCategory(error);
    this.state(entry, "reconnecting", category);
    this.scheduleReconnect(entry);
  }
  private scheduleReconnect(entry: Entry) {
    const durable = entry.durable!;
    if (durable.stopped) return;
    const attempt = entry.info.reconnectAttempt || 0;
    durable.timer = setTimeout(
      () => {
        void this.reconnect(entry.info.id).catch(() => undefined);
      },
      Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)),
    );
    durable.timer.unref();
  }
  async reconnect(id: string, password?: string): Promise<TerminalInfo> {
    const entry = this.entries.get(id),
      durable = entry?.durable;
    if (!entry || !durable || durable.stopped || entry.info.exited)
      throw new Error("유지 중인 SSH 세션을 찾을 수 없습니다.");
    if (entry.info.connectionState === "connected") return entry.info;
    if (durable.reconnecting) return durable.reconnecting;
    clearTimeout(durable.timer);
    durable.reconnecting = (async () => {
      let connection: Client | undefined;
      try {
        const host =
          this.recovery
            ?.hosts()
            .find((host) => host.id === entry.info.hostId) || durable.host;
        if (hostFingerprint(host) !== durable.record.target)
          throw new DurableSshError(
            "authentication",
            "서버 연결 대상이 변경됐습니다. 이전 작업에 자동 연결하지 않습니다.",
          );
        entry.info.reconnectAttempt = (entry.info.reconnectAttempt || 0) + 1;
        this.state(entry, "reconnecting");
        const secret =
          password ??
          durable.password ??
          (this.recovery
            ? await this.recovery.password(host)
            : durable.password);
        connection = await this.connect(host, secret);
        if (durable.stopped) {
          connection.end();
          return entry.info;
        }
        await checkDurableSession(connection, durable.record);
        if (durable.record.remotePort) {
          await this.forward(
            connection,
            durable.sockets,
            durable.record.remotePort,
          );
          if (!durable.secrets) {
            durable.secrets = await restoreDurableSecrets(
              connection,
              durable.record,
            );
            if (durable.secrets.peerRuntime && entry.info.agentKind === "codex")
              durable.peerRuntime = durable.secrets.peerRuntime;
            if (!this.bridge?.restore)
              throw new DurableSshError(
                "forwarding",
                "기존 Harbor 인증을 복구할 수 없습니다.",
              );
            this.bridge.restore(id, durable.secrets);
          }
        }
        if (password) durable.password = password;
        await this.attach(entry, connection);
        return entry.info;
      } catch (error) {
        connection?.destroy();
        for (const socket of durable.sockets) socket.destroy();
        durable.sockets.clear();
        const category = disconnectCategory(error);
        this.state(entry, "disconnected", category);
        // Authentication and a missing remote job need explicit user action, never a new CLI.
        if (
          category !== "authentication" &&
          category !== "remote-missing" &&
          category !== "capability"
        )
          this.scheduleReconnect(entry);
        throw error;
      } finally {
        durable.reconnecting = undefined;
      }
    })();
    return durable.reconnecting;
  }
  async restore() {
    if (!this.registry || !this.recovery) return;
    for (const record of this.registry.list()) {
      if (this.entries.has(record.info.id) || this.entries.size >= 16) continue;
      const host =
        this.recovery.hosts().find((host) => host.id === record.info.hostId) ||
        ({
          id: record.info.hostId,
          name: "삭제된 서버",
          kind: "ssh",
          address: "",
          username: "",
          port: 22,
          identityFile: "",
          codexPath: "codex",
          defaultCwd: "~",
          mode: "auto",
          color: "#888888",
          createdAt: 0,
        } as HostConfig);
      const info: TerminalInfo = {
        ...record.info,
        exited: false,
        persistent: true,
        connectionState: "disconnected",
      };
      const entry = this.durableEntry(host, info, record);
      this.entries.set(info.id, entry);
      if (host.kind !== "ssh" || hostFingerprint(host) !== record.target) {
        this.state(entry, "disconnected", "authentication");
        info.persistenceDetail =
          "서버 설정이 변경되거나 삭제되어 자동 연결을 중단했습니다. 기존 서버 설정을 복원하면 같은 작업에 다시 연결할 수 있습니다. 이전 작업 기록은 유지됩니다.";
        this.persist(entry);
        continue;
      }
      // Do not block application startup on offline hosts or credential prompts.
      void this.reconnect(info.id).catch(() => undefined);
    }
    this.emit("change");
  }
  private async ephemeralRemote(
    host: HostConfig,
    info: TerminalInfo,
    connection: Client,
    colors?: TerminalColors,
    resumeCwd?: string,
    researchLaunch?: TerminalOptions["researchLaunch"],
  ) {
    const sockets = new Set<Socket>();
    let remotePort: number | undefined;
    let issued: ReturnType<TerminalBridge["issue"]> | undefined;
    try {
      if (this.bridge) {
        try {
          remotePort = await new Promise<number>((resolve, reject) =>
            connection.forwardIn("127.0.0.1", 0, (error, port) =>
              error ? reject(error) : resolve(port),
            ),
          );
          issued = this.bridge.issue(info.id);
          connection.on("tcp connection", (details, accept, reject) => {
            if (
              details.destIP !== "127.0.0.1" ||
              details.destPort !== remotePort
            ) {
              reject();
              return;
            }
            const socket = tcpConnect({
              host: "127.0.0.1",
              port: this.bridge!.port,
            });
            sockets.add(socket);
            const stream = accept();
            socket.on("error", () => stream.destroy());
            stream.on("error", () => socket.destroy());
            socket.on("close", () => {
              sockets.delete(socket);
              stream.destroy();
            });
            stream.on("close", () => socket.destroy());
            stream.pipe(socket).pipe(stream);
          });
        } catch {
          /* Servers can disable TCP forwarding; retain an ordinary terminal. */
        }
      }
      const marker = `HARBOR_READY_${randomUUID().replaceAll("-", "")}`;
      const unavailableMarker = `HARBOR_PLAIN_${randomUUID().replaceAll("-", "")}`;
      const managed = issued && remotePort;
      if (
        !managed &&
        (info.program || "shell") === "shell" &&
        host.cliApprovalMode === "full-access"
      )
        throw new Error(
          "AI 실행 승인 설정을 적용하려면 관리형 SSH 연결과 TCP forwarding이 필요합니다. CLI 설정 사용으로 바꾸거나 서버 연결 설정을 확인하세요.",
        );
      if (researchLaunch && !managed)
        throw new Error(
          "원격 연구실에는 관리형 SSH 연결과 TCP forwarding이 필요합니다. 서버 연결 설정을 확인하세요.",
        );
      const noBash = researchLaunch
        ? "printf 'Remote research requires Bash. Install bash on this server.\\n' >&2; exit 1"
        : remoteTerminalCommand(
            host,
            info.cwd,
            info.program || "shell",
            info.resumeThreadId,
          );
      const launch = managed
        ? `if command -v bash >/dev/null 2>&1; then stty -echo -icanon min 1 time 0 && printf '${marker}\\n' && exec bash --noprofile --norc +x +v +i -s; else printf '${unavailableMarker}\\n'; ${noBash}; fi`
        : remoteTerminalCommand(
            host,
            info.cwd,
            info.program || "shell",
            info.resumeThreadId,
          );
      const channel = await new Promise<ClientChannel>((resolve, reject) =>
        connection.exec(
          launch,
          { pty: { term: "xterm-256color", cols: 100, rows: 30 } },
          (error, result) => (error ? reject(error) : resolve(result)),
        ),
      );
      const entry: Entry = {
        info,
        connection,
        buffer: new TerminalScreen(),
        colors: new TerminalColorResponder(colors),
        cwdObserver: new TerminalCwdObserver(),
        process: {
          write: (data) => {
            if (finished || !channel.writable)
              throw new Error(
                "SSH 연결이 끊겼습니다. 새 터미널로 다시 연결하세요.",
              );
            if (awaitingMarker)
              throw new Error(
                "SSH 터미널을 준비하고 있습니다. 잠시 뒤 입력하세요.",
              );
            channel.write(data);
          },
          resize: (cols, rows) => {
            if (!finished) channel.setWindow(rows, cols, 0, 0);
          },
          kill: () => {
            userClosing = true;
            channel.close();
            connection.end();
            for (const socket of sockets) socket.destroy();
          },
        },
      };
      this.entries.set(info.id, entry);
      let awaitingMarker = !!managed;
      let pending = "";
      let exitCode: number | undefined;
      let exitSignal: string | undefined;
      let finished = false;
      let userClosing = false;
      channel.setEncoding("utf8");
      channel.stderr.setEncoding("utf8");
      const receive = (data: string) => {
        if (finished) return;
        if (!awaitingMarker) {
          this.receive(entry, data);
          return;
        }
        pending += data;
        const plainAt = pending.indexOf(unavailableMarker);
        if (plainAt >= 0) {
          awaitingMarker = false;
          this.bridge?.revoke(info.id);
          this.receive(
            entry,
            pending.slice(0, plainAt) +
              pending
                .slice(plainAt + unavailableMarker.length)
                .replace(/^\r?\n/, ""),
          );
          pending = "";
          return;
        }
        const at = pending.indexOf(marker);
        if (at < 0) {
          if (pending.length > 16000) {
            awaitingMarker = false;
            this.receive(entry, pending);
            pending = "";
          }
          return;
        }
        awaitingMarker = false;
        this.receive(
          entry,
          pending.slice(0, at) +
            pending.slice(at + marker.length).replace(/^\r?\n/, ""),
        );
        pending = "";
        info.integration = "ready";
        channel.write(
          bashInitialization(
            host,
            info.cwd,
            info.program || "shell",
            {
              token: issued!.token,
              url: `http://127.0.0.1:${remotePort}${issued!.path}`,
              ...(issued!.hookToken && issued!.hookPath
                ? {
                    hook: {
                      token: issued!.hookToken,
                      url: `http://127.0.0.1:${remotePort}${issued!.hookPath}`,
                    },
                  }
                : {}),
            },
            info.resumeThreadId,
            resumeCwd,
            researchLaunch,
          ),
        );
        this.emit("change");
      };
      channel.on("data", receive);
      channel.stderr.on("data", receive);
      channel.on("exit", (code: number | null, signal?: string) => {
        if (typeof code === "number") exitCode = code;
        if (signal && /^(?:SIG)?[A-Z][A-Z0-9]{0,19}$/.test(signal))
          exitSignal = signal;
      });
      const finish = (
        source: "ssh-error" | "ssh-close" | "channel-error" | "channel-close",
        error?: unknown,
      ) => {
        if (finished) return;
        finished = true;
        const normalExit = exitCode !== undefined || !!exitSignal;
        const category = normalExit ? "remote-exit" : disconnectCategory(error);
        if (exitSignal) info.exitSignal = exitSignal;
        if (!userClosing) {
          info.connectionIssue = category;
          info.disconnectReason = normalExit
            ? exitSignal
              ? `서버의 셸이 ${exitSignal} 신호로 종료됐습니다.`
              : `서버의 셸이 종료됐습니다 (종료 코드 ${exitCode}).`
            : "SSH 연결이 끊겼습니다. 원격 프로그램의 종료 여부는 확인되지 않았습니다. 새 터미널로 다시 연결하세요.";
        }
        this.registry?.trace(info.id, userClosing ? "user-close" : category, {
          state: "exited",
          source,
          ...safeSshErrorDetails(error),
        });
        for (const socket of sockets) socket.destroy();
        this.exited(entry, exitCode ?? -1);
        connection.end();
      };
      channel.once("close", () => finish("channel-close"));
      channel.on("error", (error: Error) => finish("channel-error", error));
      connection.once("close", () => finish("ssh-close"));
      connection.on("error", (error) => finish("ssh-error", error));
      this.registry?.trace(info.id, "state", { state: "connected" });
      this.emit("change");
      return info;
    } catch (error) {
      connection.end();
      for (const socket of sockets) socket.destroy();
      throw error;
    }
  }
  setColors(id: string, colors: TerminalColors) {
    const entry = this.entries.get(id);
    if (!entry || entry.info.exited) throw new Error("종료된 터미널입니다.");
    entry.colors.update(colors);
  }
  rename(id: string, title: string) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("터미널을 찾을 수 없습니다.");
    entry.info.title = title;
    this.persist(entry);
    this.emit("change");
    return entry.info;
  }
  buffer(id: string) {
    return this.entries.get(id)?.buffer.history.read() || "";
  }
  async bufferSnapshot(id: string) {
    return (
      this.entries.get(id)?.buffer.snapshot() || {
        data: "",
        replay: { cols: 100, rows: 30, resizes: [] },
      }
    );
  }
  write(id: string, data: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.info.exited) throw new Error("종료된 터미널입니다.");
    if (data.length > 64000) throw new Error("터미널 입력이 너무 깁니다.");
    entry.process.write(data);
    if (data && entry.info.startupPlaceholder) {
      delete entry.info.startupPlaceholder;
      this.emit("change");
    }
  }
  resize(id: string, cols: number, rows: number) {
    const entry = this.entries.get(id);
    if (!entry || entry.info.exited) return;
    cols = Math.min(500, Math.max(10, Math.floor(cols)));
    rows = Math.min(200, Math.max(3, Math.floor(rows)));
    if (!entry.buffer.resize(cols, rows)) return;
    entry.process.resize(cols, rows);
    this.emit("resize", id, cols, rows);
  }
  close(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve();
    if (entry.durable) return this.closeDurable(entry);
    this.registry?.trace(id, "user-close");
    this.bridge?.revoke(id);
    if (!entry.info.exited) entry.process.kill();
    entry.buffer.dispose();
    this.entries.delete(id);
    this.emit("change");
    return Promise.resolve();
  }
  private async closeDurable(entry: Entry) {
    const durable = entry.durable!;
    if (durable.stopped && !entry.info.exited)
      throw new Error("SSH 세션 종료를 처리하고 있습니다.");
    const priorState = entry.info.connectionState;
    durable.stopped = true;
    durable.generation++;
    clearTimeout(durable.timer);
    clearInterval(durable.monitor);
    let connection = entry.connection;
    try {
      // A close during initial startup must wait for that one launch before
      // killing it; otherwise a late tmux acknowledgement could hide a new job.
      if (durable.launching) await durable.launching.catch(() => undefined);
      if (!entry.info.exited) {
        if (!connection) {
          const host =
            this.recovery
              ?.hosts()
              .find((host) => host.id === entry.info.hostId) || durable.host;
          if (hostFingerprint(host) !== durable.record.target)
            throw new DurableSshError(
              "authentication",
              "서버 대상이 바뀌어 이전 세션을 종료할 수 없습니다.",
            );
          connection = await this.connect(
            host,
            durable.password ??
              (this.recovery ? await this.recovery.password(host) : undefined),
          );
        }
        try {
          await execRemote(
            connection,
            `${tmux(durable.record)} kill-session -t ${tmuxTarget(durable.record)} 2>/dev/null`,
          );
        } catch (killError) {
          // Verified absence can be dismissed; permission/binary/socket errors
          // must never be mistaken for successfully terminating a live job.
          try {
            await checkDurableSession(connection, durable.record);
          } catch (error) {
            if (
              !(error instanceof DurableSshError) ||
              error.category !== "remote-missing"
            )
              throw killError;
            this.removeClosedDurable(entry, connection);
            return;
          }
          throw killError;
        }
      }
      this.removeClosedDurable(entry, connection);
    } catch (error) {
      connection?.destroy();
      entry.connection = undefined;
      durable.stopped = false;
      entry.info.connectionState =
        priorState === "connected" ? "disconnected" : priorState;
      const category = disconnectCategory(error);
      this.state(entry, "disconnected", category);
      if (
        !["authentication", "remote-missing", "capability"].includes(category)
      )
        this.scheduleReconnect(entry);
      throw new Error(
        "서버 작업 종료를 확인하지 못했습니다. 목록을 보존했습니다. SSH 연결을 복구한 뒤 다시 닫아 주세요.",
      );
    }
  }
  private removeClosedDurable(entry: Entry, connection?: Client) {
    connection?.end();
    for (const socket of entry.durable!.sockets) socket.destroy();
    this.bridge?.revoke(entry.info.id);
    this.registry?.trace(entry.info.id, "user-close", { state: "exited" });
    this.registry?.remove(entry.info.id);
    entry.buffer.dispose();
    this.entries.delete(entry.info.id);
    this.emit("change");
  }
  dismissStartup(id: string): boolean {
    const entry = this.entries.get(id);
    if (
      !entry?.info.startupPlaceholder ||
      entry.info.program !== "shell" ||
      entry.info.agentConnected
    )
      return false;
    this.close(id);
    return true;
  }
  shutdown(options: { preserveRemote?: boolean } = { preserveRemote: true }) {
    const closing: Promise<void>[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.durable && options.preserveRemote !== false) {
        const durable = entry.durable;
        durable.stopped = true;
        durable.generation++;
        clearTimeout(durable.timer);
        clearInterval(durable.monitor);
        this.state(entry, "disconnected", "backend-stop");
        durable.channel?.close();
        entry.connection?.end();
        for (const socket of durable.sockets) socket.destroy();
        entry.buffer.dispose();
        this.entries.delete(id);
      } else closing.push(this.close(id));
    }
    return Promise.allSettled(closing).then(() => undefined);
  }
}
