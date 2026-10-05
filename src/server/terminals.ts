import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { connect as tcpConnect, type Socket } from "node:net";
import * as pty from "node-pty";
import type { Client, ClientChannel } from "ssh2";
import type {
  HostConfig,
  TerminalColors,
  TerminalInfo,
} from "../shared/types.js";
import { sshArgs } from "./ssh.js";
import { passwordConnection } from "./ssh-connect.js";
import { TerminalScreen } from "./terminal-screen.js";
import { TerminalColorResponder } from "./terminal-colors.js";
import { TerminalCwdObserver } from "./terminal-cwd.js";
import { claudeArguments, type ClaudeHookEvent } from "./claude-hooks.js";
import {
  bashInitialization,
  codexArguments,
  powershellInitialization,
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
}
interface Entry {
  info: TerminalInfo;
  process: Pick<pty.IPty, "write" | "resize" | "kill">;
  buffer: TerminalScreen;
  colors: TerminalColorResponder;
  cwdObserver: TerminalCwdObserver;
}

export class Terminals extends EventEmitter {
  private entries = new Map<string, Entry>();
  private opening = 0;
  private sequence = new Map<string, number>();
  private bridge?: TerminalBridge;
  configureBridge(bridge: TerminalBridge) {
    this.bridge = bridge;
  }
  markAgentConnected(id: string) {
    const entry = this.entries.get(id);
    if (entry && !entry.info.exited) {
      entry.info.agentConnected = true;
      entry.info.agentKind = "codex";
      this.emit("change");
    }
  }
  markAgentState(id: string, state: "shell" | "codex") {
    const entry = this.entries.get(id);
    if (entry && !entry.info.exited) {
      entry.info.agentConnected = state === "codex";
      // Once Codex exits, this shell no longer owns the resumed conversation.
      if (state === "shell") { delete entry.info.resumeThreadId; delete entry.info.agentKind; delete entry.info.agentState; delete entry.info.agentSessionId; }
      this.emit("change");
    }
  }
  markClaudeEvent(id: string, event: ClaudeHookEvent) {
    const entry = this.entries.get(id);
    if (!entry || entry.info.exited) return;
    const info = entry.info;
    if (event.hook_event_name === "SessionEnd") {
      if (info.agentSessionId !== event.session_id) return;
      delete info.agentKind; delete info.agentSessionId; delete info.agentState; delete info.resumeThreadId;
      info.agentConnected = false;
    } else {
      info.agentKind = "claude";
      info.agentConnected = true;
      info.agentSessionId = event.session_id;
      if (event.cwd && !/[\x00-\x1f]/.test(event.cwd) && (isAbsolute(event.cwd) || event.cwd.startsWith("/"))) info.cwd = event.cwd;
      if (["UserPromptSubmit", "PostToolUse", "PostToolUseFailure"].includes(event.hook_event_name)) info.agentState = "working";
      else if (event.hook_event_name === "PermissionRequest" || event.hook_event_name === "Notification") info.agentState = "waiting";
      else if (["SessionStart", "Stop", "StopFailure"].includes(event.hook_event_name)) info.agentState = "idle";
    }
    this.emit("change");
  }
  list() {
    return [...this.entries.values()].map((t) => t.info);
  }
  private receive(entry: Entry, data: string) {
    const reported = entry.cwdObserver.consume(data).at(-1);
    if (reported && reported !== entry.info.cwd) {
      entry.info.cwd = reported;
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
    entry.info.agentConnected = false;
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
      id: randomUUID(),
      hostId: host.id,
      cwd,
      program,
      title: options.title?.trim() || `${host.name} ${sequence}`,
      exited: false,
      integration: "unavailable",
      agentConnected: false,
      ...(options.resumeThreadId
        ? { resumeThreadId: options.resumeThreadId }
        : {}),
    };
    try {
      if (host.kind === "ssh") {
        let connection: Client | undefined;
        try {
          connection = await passwordConnection(host, password);
        } catch (error) {
          // Interactive OpenSSH remains available for key passphrases and jump hosts.
          // A supplied/saved password must fail visibly rather than silently changing auth.
          if (password) throw error;
        }
        if (connection)
          return await this.remote(host, info, connection, options.colors, options.resumeCwd);
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
          );
          args = [
            "-NoLogo",
            "-NoExit",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ];
        } else if (program !== "shell") {
          command = program.startsWith("claude") ? "claude" : host.codexPath || "codex";
          args = program.startsWith("claude") ? claudeArguments(undefined, options.resumeThreadId, program === "claude-resume") : codexArguments(program, undefined, options.resumeThreadId);
        } else {
          command = process.env.SHELL || "/bin/bash";
          args = ["-l"];
        }
      } else {
        command = process.platform === "win32" ? "ssh.exe" : "ssh";
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
      this.emit("change");
      return info;
    } catch (error) {
      this.bridge?.revoke(info.id);
      throw error;
    } finally {
      this.opening--;
    }
  }
  private async remote(
    host: HostConfig,
    info: TerminalInfo,
    connection: Client,
    colors?: TerminalColors,
    resumeCwd?: string,
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
      const launch = managed
        ? `if command -v bash >/dev/null 2>&1; then stty -echo -icanon min 1 time 0 && printf '${marker}\\n' && exec bash --noprofile --norc +x +v +i -s; else printf '${unavailableMarker}\\n'; ${remoteTerminalCommand(host, info.cwd, info.program || "shell", info.resumeThreadId)}; fi`
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
        buffer: new TerminalScreen(),
        colors: new TerminalColorResponder(colors),
        cwdObserver: new TerminalCwdObserver(),
        process: {
          write: (data) => {
            if (awaitingMarker)
              throw new Error(
                "SSH 터미널을 준비하고 있습니다. 잠시 뒤 입력하세요.",
              );
            channel.write(data);
          },
          resize: (cols, rows) => channel.setWindow(rows, cols, 0, 0),
          kill: () => {
            channel.close();
            connection.end();
            for (const socket of sockets) socket.destroy();
          },
        },
      };
      this.entries.set(info.id, entry);
      let awaitingMarker = !!managed;
      let pending = "";
      let exitCode = 0;
      channel.setEncoding("utf8");
      channel.stderr.setEncoding("utf8");
      const receive = (data: string) => {
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
          ),
        );
        this.emit("change");
      };
      channel.on("data", receive);
      channel.stderr.on("data", receive);
      channel.on("exit", (code: number) => {
        exitCode = code ?? 0;
      });
      const finish = () => {
        for (const socket of sockets) socket.destroy();
        this.exited(entry, exitCode);
        connection.end();
      };
      channel.once("close", finish);
      connection.once("close", finish);
      connection.on("error", finish);
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
  }
  resize(id: string, cols: number, rows: number) {
    const entry = this.entries.get(id);
    if (!entry || entry.info.exited) return;
    cols = Math.min(500, Math.max(10, Math.floor(cols)));
    rows = Math.min(200, Math.max(3, Math.floor(rows)));
    if (!entry.buffer.resize(cols, rows)) return;
    entry.process.resize(cols, rows);
  }
  close(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.bridge?.revoke(id);
    if (!entry.info.exited) entry.process.kill();
    entry.buffer.dispose();
    this.entries.delete(id);
    this.emit("change");
  }
  shutdown() {
    for (const id of this.entries.keys()) this.close(id);
  }
}
