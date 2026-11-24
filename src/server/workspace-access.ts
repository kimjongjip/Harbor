import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { RequestHandler } from "express";

const sign = (key: string, input: string) =>
  createHmac("sha256", key).update(input).digest("hex");

export function issueWorkspaceLink(
  key: string,
  host: string,
  now = Date.now(),
) {
  const nonce = randomBytes(16).toString("hex");
  const body = [now.toString(36), nonce].join(".");
  return body + "." + sign(key, "open:" + host + ":" + body);
}

export function workspaceRelayToken(
  key: string,
  actor: string,
  method: string,
  path: string,
  time: number,
) {
  const nonce = time.toString(36) + "." + randomBytes(16).toString("hex");
  return (
    nonce +
    "." +
    sign(key, JSON.stringify(["chat", actor, method, path, nonce]))
  );
}

const launchPage = `<!DOCTYPE html><html lang="ko"><meta charset="utf-8"><title>Harbor</title><p>서버 작업 공간 연결 중…</p><script>
const ticket = location.hash.slice(1);
const focus = new URLSearchParams(location.search).get("focus");
history.replaceState(null, "", location.pathname);
fetch("/_workspace/login", {method:"POST",headers:{"X-Harbor-Link":ticket}}).then(r=>{
 if(!r.ok) throw new Error(); location.replace(focus && /^[a-zA-Z0-9_-]{1,160}$/.test(focus) ? "/?focus="+encodeURIComponent(focus) : "/");
}).catch(()=>document.querySelector("p").textContent="연결 링크가 만료되었습니다. Harbor 서버 관리에서 작업 공간을 다시 여세요.");
</script></html>`;

export class WorkspaceAccess {
  private redeemed = new Map<string, number>();
  private session = randomBytes(32).toString("hex");
  constructor(private key: string) {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Invalid workspace key");
  }

  validOrigin(req: IncomingMessage) {
    const host = req.headers.host || "";
    return (
      /^harbor-[0-9a-f]{24}\.localhost:[0-9]{1,5}$/.test(host) &&
      (!req.headers.origin || req.headers.origin === "http://" + host)
    );
  }
  authorized(req: IncomingMessage) {
    const cookie =
      "harbor_workspace=" + sign(this.session, req.headers.host || "");
    return (
      this.validOrigin(req) &&
      (req.headers.cookie || "").split(/;\s*/).includes(cookie)
    );
  }
  middleware: RequestHandler = (req, res, next) => {
    if (!this.validOrigin(req)) {
      res.sendStatus(403);
      return;
    }
    if (req.path.startsWith("/_workspace/chat/")) {
      const token = req.header("X-Harbor-Relay") || "";
      const actor = req.header("X-Harbor-Actor") || "";
      const parts = /^([a-z0-9]{1,12}\.[0-9a-f]{32})\.([0-9a-f]{64})$/.exec(
        token,
      );
      const now = Date.now();
      for (const [used, until] of this.redeemed)
        if (until <= now) this.redeemed.delete(used);
      const issued = parts ? parseInt(parts[1].split(".")[0], 36) : 0;
      if (
        !/^(host|mobile|desktop)-[0-9a-f]{32}$/.test(actor) ||
        !parts ||
        issued > now + 5000 ||
        now - issued >= 60000 ||
        this.redeemed.has(token) ||
        !timingSafeEqual(
          Buffer.from(parts[2]),
          Buffer.from(
            sign(
              this.key,
              JSON.stringify([
                "chat",
                actor,
                req.method,
                req.originalUrl,
                parts[1],
              ]),
            ),
          ),
        )
      ) {
        res.sendStatus(403);
        return;
      }
      this.redeemed.set(token, issued + 60000);
      res.locals.workspaceActor = actor;
      next();
      return;
    }
    if (req.path === "/_workspace/open" && req.method === "GET") {
      res.set({
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      });
      res.type("html").send(launchPage);
      return;
    }
    if (req.path === "/_workspace/login" && req.method === "POST") {
      const value = req.header("X-Harbor-Link") || "";
      const parts = /^([a-z0-9]{1,12}\.[a-f0-9]{32})\.([a-f0-9]{64})$/.exec(
        value,
      );
      const now = Date.now();
      for (const [ticket, until] of this.redeemed)
        if (until <= now) this.redeemed.delete(ticket);
      const issued = parts ? parseInt(parts[1].split(".")[0], 36) : 0;
      const host = req.headers.host!;
      if (
        !parts ||
        issued > now ||
        now - issued >= 60_000 ||
        this.redeemed.has(value) ||
        !timingSafeEqual(
          Buffer.from(parts[2]),
          Buffer.from(sign(this.key, "open:" + host + ":" + parts[1])),
        )
      ) {
        res.sendStatus(403);
        return;
      }
      this.redeemed.set(value, issued + 60_000);
      res.cookie("harbor_workspace", sign(this.session, host), {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
      });
      res.set("Cache-Control", "no-store").sendStatus(204);
      return;
    }
    if (!this.authorized(req)) {
      res.sendStatus(403);
      return;
    }
    next();
  };
}
