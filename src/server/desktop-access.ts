import type { IncomingMessage } from "node:http";
import type { Request, Response, RequestHandler } from "express";
import { WebSocket } from "ws";
import { z } from "zod";
import type { MobileAccess } from "./mobile-access.js";
import type { TerminalControl } from "./terminal-control.js";

/** Only the paired-device gateway can attach this identity, never an HTTP header. */
export class DesktopAccess {
  private requests = new WeakMap<IncomingMessage, string>();
  private sockets = new Map<WebSocket, string>();
  constructor(
    private access: () => MobileAccess,
    private controls: () => TerminalControl,
  ) {}
  private active(id: string) {
    const access = this.access();
    return (
      access.config.enabled &&
      access.config.devices.find(
        (d) => d.id === id && d.kind === "desktop" && d.expiresAt > Date.now(),
      )
    );
  }
  device(request: IncomingMessage) {
    const id = this.requests.get(request);
    if (!id) return undefined;
    const device = this.active(id);
    if (!device)
      throw Object.assign(
        new Error("기기 연결이 해제되었습니다. 다시 등록하세요."),
        { status: 401 },
      );
    return device;
  }
  private bind(request: IncomingMessage) {
    const device = this.access().authenticate(request.headers.cookie);
    if (!device || !this.active(device.id))
      throw Object.assign(new Error("PC용 연결 링크로 등록하세요."), {
        status: device ? 403 : 401,
      });
    this.requests.set(request, device.id);
    return device;
  }
  http(handler: RequestHandler): RequestHandler {
    return (req, res, next) => {
      try {
        const device = this.bind(req);
        Object.defineProperty(req, "protocol", {
          value: "https",
          configurable: true,
        });
        // Network setup, pairing and device administration remain on the host.
        if (/^\/api\/(mobile|diagnostics)(\/|$)/i.test(req.path)) {
          res
            .status(403)
            .json({ error: "기기 연결 설정은 호스트 PC에서 변경하세요." });
          return;
        }
        const write = res.write.bind(res),
          end = res.end.bind(res);
        // Recheck even after asynchronous file/history reads; revoke never leaks a pending result.
        const valid = () => {
          if (this.active(device.id)) return true;
          if (res.headersSent) res.destroy();
          else {
            res.statusCode = 401;
            res.removeHeader("Content-Length");
            res.removeHeader("Content-Disposition");
            res.setHeader("Content-Type", "application/json");
            end(
              JSON.stringify({
                error: "기기 연결이 해제되었습니다. 다시 등록하세요.",
              }),
            );
          }
          return false;
        };
        res.write = ((...args: Parameters<Response["write"]>) =>
          valid() && write(...args)) as Response["write"];
        res.end = ((...args: Parameters<Response["end"]>) =>
          valid() ? end(...args) : res) as Response["end"];
        handler(req, res, next);
      } catch (error) {
        next(error);
      }
    };
  }
  upgrade(request: IncomingMessage) {
    this.bind(request);
  }
  socket(request: IncomingMessage, socket: WebSocket) {
    const device = this.device(request);
    if (!device) return;
    this.sockets.set(socket, device.id);
    socket.once("close", () => this.sockets.delete(socket));
  }
  validSocket(socket: WebSocket) {
    const id = this.sockets.get(socket);
    if (!id || this.active(id)) return true;
    socket.close(4001, "Device revoked");
    return false;
  }
  revoke(id?: string) {
    for (const [socket, deviceId] of this.sockets)
      if (!id || id === deviceId) socket.close(4001, "Device disconnected");
  }
  assert(
    request: IncomingMessage,
    id: string,
    clientId?: string,
    token?: string,
  ) {
    const device = this.device(request);
    if (!device) return this.controls().local(id);
    this.controls().assert(id, device.id, clientId, token);
  }
  authorize(request: Request, id: string, write: boolean) {
    const device = this.device(request);
    if (!write) return;
    if (!device) return this.controls().local(id);
    const leases = z
      .record(z.string().uuid(), z.string().uuid())
      .parse(JSON.parse(request.get("X-Harbor-Leases") || "{}"));
    this.assert(request, id, request.get("X-Harbor-Client"), leases[id]);
  }
  canResize(
    request: IncomingMessage,
    id: string,
    clientId?: string,
    token?: string,
  ) {
    if (!this.device(request)) return this.controls().canResizeLocally(id);
    try {
      this.assert(request, id, clientId, token);
      return true;
    } catch {
      return false;
    }
  }
}
