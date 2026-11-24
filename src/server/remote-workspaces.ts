import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  createReadStream,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Agent, get, request } from "node:http";
import {
  createServer,
  type Server,
  type Socket,
  type AddressInfo,
} from "node:net";
import { join, resolve } from "node:path";
import type { Client } from "ssh2";
import type { HostConfig } from "../shared/types.js";
import { passwordConnection } from "./ssh-connect.js";
import { issueWorkspaceLink, workspaceRelayToken } from "./workspace-access.js";
import {
  workspaceCheck,
  workspaceInstall,
  workspaceProbe,
  workspaceShell,
} from "./workspace-install.js";

function execute(
  connection: Client,
  script: string,
  file?: string,
): Promise<string> {
  return new Promise((done, fail) => {
    connection.exec(workspaceShell(script), (error, channel) => {
      if (error) {
        fail(error);
        return;
      }
      let status: number | undefined,
        out = "",
        err = "";
      const timer = setTimeout(
        () => {
          channel.close();
          fail(Error("서버 작업 시간 초과"));
        },
        file ? 900000 : 30000,
      );
      const input = file ? createReadStream(file) : undefined;
      channel.on("data", (s: Buffer) => {
        out = (out + s.toString()).slice(-8192);
      });
      channel.stderr.on("data", (s: Buffer) => {
        err = (err + s.toString()).slice(-2048);
      });
      channel.once("error", fail);
      channel.once("exit", (code: number) => {
        status = code;
      });
      channel.once("close", (code: number | undefined) => {
        input?.destroy();
        clearTimeout(timer);
        if ((status ?? code) === 0) done(out.trim());
        else fail(Error(err.trim() || "서버 연결이 종료되었습니다."));
      });
      if (input) {
        input.once("error", (e) => {
          channel.close();
          fail(e);
        });
        input.pipe(channel);
      } else channel.end();
    });
  });
}

async function makeArchive(root: string, output: string) {
  const names = [
    "dist/client",
    "dist/server.mjs",
    "dist/pty-worker.mjs",
    "dist/worker-manifest",
    "desktop/antigravity.cjs",
    "scripts/harbor-image.py",
  ];
  await new Promise<void>((done, fail) => {
    const child = spawn("tar", ["-czf", output, "-C", root, ...names], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (s) => {
      err = (err + s.toString()).slice(-1500);
    });
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0
        ? done()
        : fail(
            Error(err || "배포 파일을 준비하려면 Harbor 빌드가 필요합니다."),
          ),
    );
  });
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(output)) hash.update(chunk);
  return hash.digest("hex");
}

interface Tunnel {
  agent: Agent;
  server: Server;
  host: string;
  key: string;
  pending: boolean;
  clockOffset: number;
  dispose(): void;
}
export class RemoteWorkspaces {
  private active = new Map<string, Tunnel>();
  private pending = new Map<string, Promise<Tunnel>>();
  private installed = new Set<string>();
  constructor(
    private directory: string,
    private root = resolve("."),
    private sshConnection = passwordConnection,
  ) {
    try {
      const data: unknown = JSON.parse(
        readFileSync(join(directory, "server-workspaces.json"), "utf8"),
      );
      if (!Array.isArray(data) || !data.every((k) => typeof k === "string"))
        throw Error("Invalid workspace registry");
      this.installed = new Set(data);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  private profile(host: HostConfig) {
    return createHash("sha256")
      .update(
        JSON.stringify([
          host.id,
          host.address,
          host.port,
          host.username,
          host.identityFile,
        ]),
      )
      .digest("hex");
  }
  enabled(host: HostConfig) {
    return this.installed.has(this.profile(host));
  }
  checkEdit(host: HostConfig) {
    if (this.pending.has(this.profile(host)))
      throw Error("서버 작업 공간 연결 중입니다. 완료 후 설정을 변경하세요.");
  }
  disconnect(host: HostConfig) {
    this.checkEdit(host);
    this.active.get(this.profile(host))?.dispose();
  }
  changed(before: HostConfig, after: HostConfig) {
    if (this.profile(before) !== this.profile(after)) this.forget(before);
  }
  forget(host: HostConfig) {
    const id = this.profile(host);
    if (this.pending.has(id))
      throw Error("서버 연결이 끝난 뒤 다시 시도하세요.");
    this.active.get(id)?.dispose();
    if (!this.installed.has(id)) return;
    const keys = new Set(this.installed);
    keys.delete(id);
    this.save(keys);
  }
  private save(keys: Set<string>) {
    const file = join(this.directory, "server-workspaces.json");
    writeFileSync(file + ".tmp", JSON.stringify([...keys]), { mode: 0o600 });
    renameSync(file + ".tmp", file);
    this.installed = keys;
  }
  private remember(id: string) {
    if (this.installed.has(id)) return;
    this.save(new Set([...this.installed, id]));
  }
  async chat(
    host: HostConfig,
    pass: string | undefined,
    actor: string,
    method: string,
    path: string,
    body: unknown,
    terminal: string | undefined,
    guard: () => void,
    lease?: { client?: string; token?: string; revision?: string },
  ) {
    if (!this.enabled(host))
      throw Error("이 서버에서 세션 유지를 먼저 설정하세요.");
    const t = await this.tunnel(host, pass, false);
    guard();
    const signedPath = "/_workspace/chat" + path;
    const text = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<{ status: number; value: any; unsupportedUsage?: true }>(
      (done, fail) => {
        const q = request(
          {
            hostname: "127.0.0.1",
            port: Number(t.host.split(":")[1]),
            agent: t.agent,
            method,
            path: signedPath,
            signal: AbortSignal.timeout(60000),
            headers: {
              host: t.host,
              "content-type": "application/json",
              "x-harbor-actor": actor,
              "x-harbor-relay": workspaceRelayToken(
                t.key,
                actor,
                method,
                signedPath,
                Date.now() + t.clockOffset,
              ),
              ...(terminal ? { "x-harbor-terminal": terminal } : {}),
              ...(lease?.client ? { "x-harbor-client": lease.client } : {}),
              ...(lease?.token ? { "x-harbor-control": lease.token } : {}),
              ...(lease?.revision
                ? { "x-harbor-chat-revision": lease.revision }
                : {}),
              ...(text === undefined
                ? {}
                : { "content-length": Buffer.byteLength(text) }),
            },
          },
          (r) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            r.on("data", (data: Buffer) => {
              bytes += data.length;
              if (bytes > 12 * 1024 * 1024) {
                r.destroy(Error("대화 응답이 너무 큽니다."));
                return;
              }
              chunks.push(data);
            });
            r.on("error", fail);
            r.on("end", () => {
              try {
                guard();
                const status = r.statusCode || 500,
                  payload = Buffer.concat(chunks).toString("utf8");
                if (
                  method === "GET" &&
                  /^\/conversations\/[a-f0-9-]{36}\/usage$/i.test(path) &&
                  /^text\/html\b/i.test(String(r.headers["content-type"])) &&
                  ((status === 200 &&
                    /<!doctype html>/i.test(payload) &&
                    payload.includes('id="root"') &&
                    payload.includes("/assets/")) ||
                    (status === 404 &&
                      (payload.includes("Cannot GET " + signedPath) ||
                        (/<!doctype html>/i.test(payload) &&
                          payload.includes("<title>Error</title>") &&
                          /<pre>NotFoundError: Not Found(?:<br\s*\/?>|<\/pre>)/i.test(
                            payload,
                          )))))
                ) {
                  done({
                    status: 404,
                    value: {
                      error: "서버가 대화 사용량 조회를 지원하지 않습니다.",
                    },
                    unsupportedUsage: true,
                  });
                  return;
                }
                if (method === "POST" && status === 404 && /^\/conversations\/[a-f0-9-]{36}\/settings$/i.test(path) &&
                    /^text\/html\b/i.test(String(r.headers["content-type"]))) {
                  done({status:409,value:{error:"이 서버 작업 공간은 실행 설정 변경을 아직 지원하지 않습니다. 서버 관리에서 업데이트 상태를 확인하세요."}});
                  return;
                }
                if (
                  status >= 400 &&
                  !String(r.headers["content-type"])
                    .toLowerCase()
                    .includes("json")
                ) {
                  done({
                    status,
                    value: { error: "서버 요청을 처리할 수 없습니다." },
                  });
                  return;
                }
                done({ status, value: JSON.parse(payload) });
              } catch (e) {
                fail(e);
              }
            });
          },
        );
        q.on("error", fail);
        q.end(text);
      },
    );
  }
  async open(host: HostConfig, password: string | undefined, install: boolean) {
    const t = await this.tunnel(host, password, install);
    this.remember(this.profile(host));
    return this.link(t);
  }
  private async tunnel(
    host: HostConfig,
    password: string | undefined,
    install: boolean,
  ) {
    if (host.kind !== "ssh") throw Error("SSH 서버를 선택하세요.");
    const id = this.profile(host);
    let waiting = this.pending.get(id);
    if (!waiting) {
      const old = this.active.get(id);
      if (old && !install) return old;
      waiting = this.connect(host, id, password, install);
      this.pending.set(id, waiting);
    }
    try {
      return await waiting;
    } finally {
      if (this.pending.get(id) === waiting) this.pending.delete(id);
    }
  }
  private link(t: Tunnel) {
    return {
      url: `http://${t.host}/_workspace/open#${issueWorkspaceLink(t.key, t.host, Date.now() + t.clockOffset)}`,
      updatePending: t.pending,
    };
  }
  private async connect(
    host: HostConfig,
    id: string,
    password: string | undefined,
    install: boolean,
  ): Promise<Tunnel> {
    if (install) {
      const setup = await this.sshConnection(host, password);
      try {
        await execute(setup, workspaceCheck);
        const temp = await mkdtemp(join(tmpdir(), "harbor-workspace-"));
        try {
          const file = join(temp, "worker.tar.gz");
          const hash = await makeArchive(this.root, file);
          const { version } = JSON.parse(
            await readFile(
              join(this.root, "dist/worker-manifest/package.json"),
              "utf8",
            ),
          );
          await execute(setup, workspaceInstall(hash, version), file);
        } finally {
          await rm(temp, { recursive: true, force: true });
        }
      } finally {
        setup.end();
      }
    }
    // Probe the service on a fresh SSH connection after releasing the installer.
    const ssh = await this.sshConnection(host, password);
    let server: Server | undefined;
    const sockets = new Set<Socket>();
    const agent = new Agent({ keepAlive: true, maxSockets: 12 });
    let closed = false;
    const dispose = () => {
      if (closed) return;
      closed = true;
      if (this.active.get(id)?.server === server) this.active.delete(id);
      for (const socket of sockets) socket.destroy();
      agent.destroy();
      server?.close();
      ssh.end();
    };
    ssh.on("error", dispose);
    ssh.once("close", dispose);
    try {
      const [path, key, time, pending] = (
        await execute(ssh, workspaceProbe)
      ).split(/\r?\n/);
      if (
        !/^\/[^\r\n\0]{1,245}\/harbor-workspace\/http\.sock$/.test(path) ||
        !/^[0-9a-f]{64}$/.test(key) ||
        !/^\d{10,11}$/.test(time)
      )
        throw Error("서버 작업 공간의 연결 정보를 확인할 수 없습니다.");
      const offset = Number(time) * 1000 - Date.now();
      const old = this.active.get(id);
      if (old && old.key === key) {
        old.pending = pending === "pending";
        old.clockOffset = offset;
        dispose();
        return old;
      }
      old?.dispose();
      const serverId = createHash("sha256")
        .update(id)
        .update(key)
        .digest("hex");
      server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("error", () => socket.destroy());
        ssh.openssh_forwardOutStreamLocal(path, (error, channel) => {
          if (error) {
            socket.destroy();
            return;
          }
          if (socket.destroyed) {
            channel.destroy();
            return;
          }
          channel.on("error", () => socket.destroy());
          channel.once("close", () => socket.destroy());
          socket.once("close", () => channel.destroy());
          socket.pipe(channel).pipe(socket);
        });
      });
      const listen = (port: number) =>
        new Promise<void>((done, fail) => {
          const error = (e: Error) => {
            server!.off("listening", ready);
            fail(e);
          };
          const ready = () => {
            server!.off("error", error);
            done();
          };
          server!
            .once("error", error)
            .once("listening", ready)
            .listen(port, "127.0.0.1");
        });
      const preferred = 17000 + (parseInt(serverId.slice(0, 4), 16) % 24000);
      try {
        await listen(preferred);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
        await listen(0);
      }
      if (closed) {
        server.close();
        throw Error("SSH 연결이 종료되었습니다.");
      }
      const port = (server.address() as AddressInfo).port;
      const address = "harbor-" + serverId.slice(0, 24) + ".localhost:" + port;
      // Verify SSH socket forwarding and the service before presenting a link.
      await new Promise<void>((done, fail) => {
        get(
          {
            hostname: "127.0.0.1",
            port,
            agent: false,
            path: "/_workspace/open",
            headers: { host: address },
            signal: AbortSignal.timeout(8000),
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              if (body.length < 8192) body += chunk;
            });
            res.on("error", fail);
            res.on("end", () =>
              res.statusCode === 200 && body.includes("/_workspace/login")
                ? done()
                : fail(Error("서버 작업 공간 응답을 확인하지 못했습니다.")),
            );
          },
        ).on("error", fail);
      });
      const tunnel = {
        agent,
        server,
        key,
        host: address,
        pending: pending === "pending",
        clockOffset: offset,
        dispose,
      };
      this.active.set(id, tunnel);
      return tunnel;
    } catch (e) {
      dispose();
      throw e;
    }
  }
  close() {
    for (const tunnel of this.active.values()) tunnel.dispose();
  }
}
