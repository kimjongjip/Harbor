import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  createReadStream,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
import type { HostConfig, WorkspaceUpdateStatus } from "../shared/types.js";
import { passwordConnection } from "./ssh-connect.js";
import { issueWorkspaceLink, workspaceRelayToken } from "./workspace-access.js";
import {
  workspaceCheck,
  workspaceApplyUpdate,
  workspaceInstall,
  workspaceProbe,
  workspaceShell,
  workspaceVersions,
} from "./workspace-install.js";

function execute(
  connection: Client,
  script: string,
  file?: string,
  timeout = file ? 900000 : 30000,
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
        timeout,
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
const versionPattern = /^\d{1,8}\.\d{1,8}\.\d{1,8}$/;
function olderVersion(left: string, right: string) {
  const a = left.split(".").map(Number),
    b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}
export class RemoteWorkspaces {
  private active = new Map<string, Tunnel>();
  private pending = new Map<string, Promise<Tunnel>>();
  private installed = new Set<string>();
  readonly version: string;
  private readonly updates = new Map<string, WorkspaceUpdateStatus>();
  private readonly checkedAt = new Map<string, number>();
  private readonly syncs = new Map<string, Promise<void>>();
  private readonly uploads = new Map<string, Promise<void>>();
  private readonly transitions = new Map<string, Promise<void>>();
  private readonly syncConnections = new Set<Client>();
  private readonly disconnected = new Set<string>();
  private closed = false;
  constructor(
    private directory: string,
    private root = resolve("."),
    private sshConnection = passwordConnection,
  ) {
    let version = "";
    try {
      const manifest = JSON.parse(
        readFileSync(join(root, "dist/worker-manifest/package.json"), "utf8"),
      );
      if (versionPattern.test(manifest.version)) version = manifest.version;
    } catch {
      /* An unbuilt source checkout can still connect to an existing service. */
    }
    this.version = version;
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
  profile(host: HostConfig) {
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
  status(host: HostConfig): WorkspaceUpdateStatus {
    return (
      this.updates.get(this.profile(host)) ?? {
        targetVersion: this.version,
        ...(this.version
          ? { phase: "checking" }
          : { phase: "error", detail: "PC의 서버 배포 파일을 확인하세요." }),
      }
    );
  }
  /** Only remembered SSH accounts participate. Queries and uploads run outside the chat tunnel. */
  synchronize(
    host: HostConfig,
    password: () => Promise<string | undefined>,
    reconnect = false,
  ): Promise<void> {
    const id = this.profile(host);
    if (
      this.closed ||
      !this.version ||
      host.kind !== "ssh" ||
      !this.installed.has(id)
    )
      return Promise.resolve();
    if (reconnect) this.disconnected.delete(id);
    if (this.disconnected.has(id)) return Promise.resolve();
    const current = this.syncs.get(id);
    if (current) {
      if (!reconnect) return current;
      // A verified reconnection can supply credentials while an earlier attempt is still failing.
      return current.then(() => {
        if (this.updates.get(id)?.phase !== "error") return;
        this.checkedAt.delete(id);
        return this.synchronize(host, password);
      });
    }
    const phase = this.updates.get(id)?.phase;
    const interval =
      phase === "pending" || phase === "checking"
        ? 15000
        : phase === "error"
          ? 300000
          : 600000;
    if (!reconnect && Date.now() - (this.checkedAt.get(id) || 0) < interval)
      return Promise.resolve();
    if (phase === "error")
      this.updates.set(id, { targetVersion: this.version, phase: "checking" });
    const task = this.checkVersion(host, id, password)
      .catch(() => {
        if (!this.closed && this.installed.has(id))
          this.updates.set(id, {
            ...this.updates.get(id),
            targetVersion: this.version,
            phase: "error",
            detail:
              "서버 버전을 확인하거나 설치하지 못했습니다. SSH 연결과 서버 관리에서 설치 상태를 확인하세요.",
          });
      })
      .finally(() => {
        if (this.installed.has(id)) this.checkedAt.set(id, Date.now());
        this.syncs.delete(id);
      });
    this.syncs.set(id, task);
    return task;
  }
  private async checkVersion(
    host: HostConfig,
    id: string,
    password: () => Promise<string | undefined>,
  ) {
    const pass = await password();
    if (this.closed || !this.installed.has(id)) return;
    const ssh = await this.sshConnection(host, pass);
    this.syncConnections.add(ssh);
    const versions = async () => {
      const [stagedVersion, runningVersion, activation] = (
        await execute(ssh, workspaceVersions)
      ).split(/\r?\n/);
      if (
        !versionPattern.test(stagedVersion) ||
        (runningVersion && !versionPattern.test(runningVersion)) ||
        !["stopped", "current", "pending"].includes(activation)
      )
        throw Error("서버 버전을 확인할 수 없습니다.");
      const phase: WorkspaceUpdateStatus["phase"] =
        activation === "stopped"
          ? "checking"
          : activation === "pending"
            ? "pending"
            : "current";
      return {
        targetVersion: this.version,
        stagedVersion,
        runningVersion: runningVersion || undefined,
        phase,
      };
    };
    try {
      if (this.closed || !this.installed.has(id)) return;
      let state = await versions();
      if (olderVersion(state.stagedVersion, this.version)) {
        this.updates.set(id, { ...state, phase: "installing" });
        await this.install(host, id, pass, true);
        state = await versions();
        if (olderVersion(state.stagedVersion, this.version))
          throw Error("서버 설치 확인 실패");
      }
      if (!state.runningVersion) {
        // The account already explicitly enabled this managed unit; start is a no-op if active.
        await execute(ssh, "systemctl --user start harbor-workspace.service");
        state = await versions();
      }
      this.updates.set(id, state);
      const t = this.active.get(id);
      if (t) t.pending = state.phase === "pending";
    } finally {
      this.syncConnections.delete(ssh);
      ssh.end();
    }
  }
  checkEdit(host: HostConfig) {
    const id = this.profile(host);
    if (this.pending.has(id) || this.uploads.has(id) || this.syncs.has(id) || this.transitions.has(id))
      throw Error("서버 작업 공간 연결 중입니다. 완료 후 설정을 변경하세요.");
  }
  /** An explicit host-PC update may ask an idle adapter to finish. Generic reconnects only stage. */
  convergeForUpdate(host: HostConfig, password: () => Promise<string | undefined>) {
    const id = this.profile(host);
    const existing = this.transitions.get(id);
    if (existing) return existing;
    const task = this.requestTransition(host, password).finally(() => this.transitions.delete(id));
    this.transitions.set(id, task);
    return task;
  }
  private async requestTransition(host: HostConfig, password: () => Promise<string | undefined>) {
    if (!this.enabled(host) || this.closed) return;
    await this.synchronize(host, password, true);
    const status = this.status(host);
    if (status.phase !== "pending" || !status.runningVersion || status.stagedVersion !== this.version) return;
    if (olderVersion(status.runningVersion, "2.0.8")) {
      this.updates.set(this.profile(host), {...status, detail:"이전 서버가 열린 세션을 유지하고 있습니다. 지금 전환하려면 업데이트 창에서 서버 재시작을 선택하세요."});
      return;
    }
    const guard = () => {
      if (this.closed || !this.enabled(host)) throw Error("서버 연결 설정이 변경되었습니다.");
    };
    const result = await this.chat(host, await password(), "host-" + this.profile(host).slice(0,32),
      "POST", "/workspace-transition", {version:this.version}, undefined, guard);
    if (result.status === 409 || result.status === 503) { await this.synchronize(host, password, true); return; }
    if (result.status !== 200 || result.value?.accepted !== true) throw Error("서버의 세션 전환 상태를 확인하세요.");
  }
  disconnect(host: HostConfig) {
    this.checkEdit(host);
    const id = this.profile(host);
    this.disconnected.add(id);
    this.active.get(id)?.dispose();
  }
  changed(before: HostConfig, after: HostConfig) {
    if (this.profile(before) !== this.profile(after)) this.forget(before);
  }
  forget(host: HostConfig) {
    const id = this.profile(host);
    this.checkEdit(host);
    this.active.get(id)?.dispose();
    this.updates.delete(id);
    this.checkedAt.delete(id);
    this.disconnected.delete(id);
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
                if (
                  method === "POST" &&
                  status === 404 &&
                  /^\/conversations\/[a-f0-9-]{36}\/settings$/i.test(path) &&
                  /^text\/html\b/i.test(String(r.headers["content-type"]))
                ) {
                  done({
                    status: 409,
                    value: {
                      error:
                        "이 서버 작업 공간은 실행 설정 변경을 아직 지원하지 않습니다. 서버 관리에서 업데이트 상태를 확인하세요.",
                    },
                  });
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
  async applyConfirmedUpdate(
    host: HostConfig,
    password: string | undefined,
    running: string,
    staged: string,
  ) {
    if (!this.enabled(host) || host.kind !== "ssh")
      throw Error("연결된 서버 작업 공간을 선택하세요.");
    const connection = await this.sshConnection(host, password);
    try {
      if (!this.enabled(host)) throw Error("서버 연결 설정이 바뀌었습니다.");
      await execute(
        connection,
        workspaceApplyUpdate(running, staged),
        undefined,
        150000,
      );
    } finally {
      connection.end();
    }
    await this.synchronize(host, async () => password, true);
  }
  async open(host: HostConfig, password: string | undefined, install: boolean) {
    if (host.kind !== "ssh") throw Error("SSH 서버를 선택하세요.");
    const id = this.profile(host);
    if (install) await this.install(host, id, password, false);
    const t = await this.tunnel(host, password, install);
    this.remember(id);
    void this.synchronize(host, async () => password, true);
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
      waiting = this.connect(host, id, password);
      this.pending.set(id, waiting);
    }
    try {
      const tunnel = await waiting;
      void this.synchronize(host, async () => password, true);
      return tunnel;
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
  private install(
    host: HostConfig,
    id: string,
    password: string | undefined,
    upgradeOnly: boolean,
  ) {
    const previous = this.uploads.get(id);
    if (previous) return previous;
    const task = this.upload(host, password, upgradeOnly).finally(() =>
      this.uploads.delete(id),
    );
    this.uploads.set(id, task);
    return task;
  }
  private async upload(
    host: HostConfig,
    password: string | undefined,
    upgradeOnly: boolean,
  ) {
    if (!this.version) throw Error("PC의 서버 배포 파일을 확인하세요.");
    const setup = await this.sshConnection(host, password);
    this.syncConnections.add(setup);
    try {
      if (this.closed) throw Error("Harbor 연결이 종료되었습니다.");
      await execute(setup, workspaceCheck);
      const temp = await mkdtemp(join(tmpdir(), "harbor-workspace-"));
      try {
        const file = join(temp, "worker.tar.gz");
        const hash = await makeArchive(this.root, file);
        if (this.closed) throw Error("Harbor 연결이 종료되었습니다.");
        await execute(
          setup,
          workspaceInstall(hash, this.version, upgradeOnly),
          file,
        );
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    } finally {
      this.syncConnections.delete(setup);
      setup.end();
    }
  }
  private async connect(
    host: HostConfig,
    id: string,
    password: string | undefined,
  ): Promise<Tunnel> {
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
    this.closed = true;
    for (const ssh of this.syncConnections) ssh.end();
    for (const tunnel of this.active.values()) tunnel.dispose();
  }
}
