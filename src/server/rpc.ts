import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Client, ClientChannel } from "ssh2";
import type { Writable } from "node:stream";

export interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

export class RpcClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private sequence = 0;
  private pending = new Map<
    string | number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private stderr = "";
  private input?: Writable;
  private closeTransport?: () => void;
  alive = false;
  async start(command: string, args: string[], cwd?: string) {
    this.child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
    });
    this.alive = true;
    this.input = this.child.stdin;
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-6000);
    });
    this.child.stdin.on("error", () => {});
    this.child.on("error", (error) => this.closed(error));
    this.child.on("exit", (code, signal) =>
      this.closed(
        new Error(this.stderr.trim() || `Codex 연결 종료 (${code ?? signal})`),
      ),
    );
    return this.initialize();
  }
  async startChannel(channel: ClientChannel, connection: Client) {
    this.alive = true;
    this.input = channel;
    this.closeTransport = () => {
      channel.close();
      connection.end();
    };
    channel.setEncoding("utf8");
    channel.stderr.setEncoding("utf8");
    channel.on("data", (chunk: string) => this.consume(chunk));
    channel.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-6000);
    });
    channel.on("error", (error: Error) => this.closed(error));
    channel.on("close", () =>
      this.closed(
        new Error(this.stderr.trim() || "SSH Codex 연결이 종료되었습니다."),
      ),
    );
    connection.on("error", (error) => this.closed(error));
    connection.on("close", () =>
      this.closed(new Error("SSH 연결이 종료되었습니다.")),
    );
    return this.initialize();
  }
  private async initialize() {
    try {
      const result = await this.call(
        "initialize",
        {
          clientInfo: {
            name: "codex_harbor",
            title: "Codex Harbor",
            version: "0.1.0",
          },
          capabilities: { experimentalApi: true },
        },
        25000,
      );
      this.notify("initialized", {});
      return result;
    } catch (error) {
      this.stop();
      throw error;
    }
  }
  consume(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > 32 * 1024 * 1024) {
      this.closed(new Error("Codex 응답 크기가 제한을 초과했습니다."));
      this.stop();
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: RpcMessage;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.method)
        this.emit(
          message.id === undefined ? "notification" : "request",
          message,
        );
      else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
    }
  }
  call(method: string, params: unknown = {}, timeout = 45000): Promise<any> {
    if (!this.alive || !this.input)
      return Promise.reject(new Error("서버에 먼저 연결하세요."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `${method}: 응답 시간이 초과되었습니다. 연결 상태를 확인하세요.`,
          ),
        );
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  notify(method: string, params: unknown) {
    this.write({ method, params });
  }
  respond(id: string | number, result: unknown) {
    this.write({ id, result });
  }
  rejectRequest(id: string | number, message: string) {
    this.write({ id, error: { code: -32601, message } });
  }
  private write(value: unknown) {
    if (this.alive && this.input?.writable)
      this.input.write(JSON.stringify(value) + "\n");
  }
  private closed(error: Error) {
    if (!this.alive) return;
    this.alive = false;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.emit("closed", error);
  }
  stop() {
    const child = this.child;
    this.closed(new Error("연결을 닫았습니다."));
    child?.stdin.end();
    child?.kill();
    this.closeTransport?.();
  }
}
