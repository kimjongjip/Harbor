import { createServer, type AddressInfo, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import type { Client, ClientChannel } from "ssh2";
import type { HostConfig } from "../shared/types.js";
import { passwordConnection } from "./ssh-connect.js";

type PortView = {
  id: string;
  hostId: string;
  remotePort: number;
  localPort: number;
};
type Entry = {
  hostId: string;
  remotePort: number;
  key: string;
  view?: PortView;
  dispose(): void;
};
const binding = (h: HostConfig) =>
  JSON.stringify([h.id, h.kind, h.address, h.port, h.username, h.identityFile]);
export class LoopbackPorts {
  private entries = new Map<string, Entry>();
  constructor(
    private getHost: (id: string) => HostConfig,
    private connect = passwordConnection,
    private idleMs = 15 * 60 * 1000,
  ) {}
  private valid(id: string, entry: Entry) {
    if (this.entries.get(id) !== entry) return false;
    try {
      return entry.key === binding(this.getHost(entry.hostId));
    } catch {
      return false;
    }
  }
  list(hostId: string) {
    const result: PortView[] = [];
    for (const [id, entry] of this.entries) {
      if (!this.valid(id, entry)) {
        entry.dispose();
        continue;
      }
      if (entry.hostId === hostId && entry.view) result.push(entry.view);
    }
    return result;
  }
  closeHost(hostId: string) {
    for (const e of this.entries.values()) if (e.hostId === hostId) e.dispose();
  }
  closeAll() {
    for (const entry of this.entries.values()) entry.dispose();
  }
  close(hostId: string, id: string) {
    const e = this.entries.get(id);
    if (e?.hostId === hostId) e.dispose();
  }
  async open(hostId: string, remotePort: number, password?: string) {
    const host = this.getHost(hostId);
    if (
      host.kind !== "ssh" ||
      !Number.isInteger(remotePort) ||
      remotePort < 1 ||
      remotePort > 65535
    )
      throw Error("SSH 서버와 포트를 확인하세요.");
    for (const existing of this.list(hostId))
      if (existing.remotePort === remotePort) return existing;
    if (
      [...this.entries.values()].some(
        (e) => e.hostId === hostId && e.remotePort === remotePort,
      )
    )
      throw Error("포트를 연결하는 중입니다.");
    if (this.entries.size >= 16)
      throw Error("사용하지 않는 포트 연결을 닫으세요.");
    const id = randomUUID(),
      sockets = new Set<Socket>();
    let ssh: Client | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    const server = createServer((socket) => {
      if (!ssh || !this.valid(id, entry) || sockets.size >= 32) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
      timer?.refresh();
      ssh.forwardOut(
        "127.0.0.1",
        socket.remotePort || 0,
        "127.0.0.1",
        remotePort,
        (e, channel) => {
          if (e || socket.destroyed || !this.valid(id, entry)) {
            channel?.destroy();
            socket.destroy();
            return;
          }
          channel.on("error", () => socket.destroy());
          channel.on("close", () => socket.destroy());
          socket.once("close", () => channel.destroy());
          socket.on("data", () => timer?.refresh());
          channel.on("data", () => timer?.refresh());
          socket.pipe(channel).pipe(socket);
        },
      );
    });
    const entry: Entry = {
      hostId,
      remotePort,
      key: binding(host),
      dispose: () => {
        this.entries.delete(id);
        clearTimeout(timer);
        server.close();
        for (const socket of sockets) socket.destroy();
        ssh?.end();
      },
    };
    this.entries.set(id, entry);
    try {
      ssh = await this.connect(host, password);
      ssh.on("error", entry.dispose);
      ssh.once("close", entry.dispose);
      if (!this.valid(id, entry)) throw Error("서버 설정이 변경됐습니다.");
      await new Promise<void>((ok, fail) => {
        const ended = () => finish(Error("SSH 연결이 끊겼습니다."));
        const deadline = setTimeout(
          () => finish(Error("원격 포트 응답 시간이 초과됐습니다.")),
          10000,
        );
        function finish(error?: Error) {
          clearTimeout(deadline);
          ssh?.off("close", ended);
          if (error) fail(error);
          else ok();
        }
        ssh!.once("close", ended);
        ssh!.forwardOut(
          "127.0.0.1",
          0,
          "127.0.0.1",
          remotePort,
          (error, channel: ClientChannel) => {
            if (error) {
              finish(Error("서버의 해당 포트나 SSH 포워딩 설정을 확인하세요."));
              return;
            }
            channel.on("error", () => {});
            channel.end();
            finish();
          },
        );
      });
      if (!this.valid(id, entry)) throw Error("서버 연결이 변경됐습니다.");
      await new Promise<void>((ok, fail) => {
        server.once("error", fail);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", fail);
          ok();
        });
      });
      if (!this.valid(id, entry)) throw Error("서버 연결이 변경됐습니다.");
      server.on("error", entry.dispose);
      timer = setTimeout(entry.dispose, this.idleMs);
      timer.unref();
      entry.view = {
        id,
        hostId,
        remotePort,
        localPort: (server.address() as AddressInfo).port,
      };
      return entry.view;
    } catch (error) {
      entry.dispose();
      throw error;
    }
  }
}
export function loopbackPortRouter(
  ports: LoopbackPorts,
  hostOnly: (req: Request) => boolean,
  password: (id: string, supplied?: string) => Promise<string | undefined>,
) {
  const router = Router({ mergeParams: true });
  router.use((req, res, next) => {
    if (!hostOnly(req)) {
      res.status(403).json({ error: "호스트 PC에서만 포트를 열 수 있습니다." });
      return;
    }
    next();
  });
  router.get("/", (req: Request, res) =>
    res.json(ports.list(String(req.params.hostId))),
  );
  router.post("/", async (req:Request, res) => {
    const data = z
      .object({
        remotePort: z.number().int().min(1).max(65535),
        password: z.string().max(2048).optional(),
      })
      .strict()
      .parse(req.body);
    const id = String(req.params.hostId);
    res.json(
      await ports.open(id, data.remotePort, await password(id, data.password)),
    );
  });
  router.delete("/:id", (req:Request, res) => {
    ports.close(
      String(req.params.hostId),
      z.string().uuid().parse(req.params.id),
    );
    res.json({ ok: true });
  });
  return router;
}
