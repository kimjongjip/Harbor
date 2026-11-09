import { randomBytes } from "node:crypto";
import path from "node:path";
import { Router } from "express";
import { pipeline } from "node:stream/promises";
import type { HostConfig } from "../shared/types.js";
import type { Files } from "./files.js";

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

export function htmlByteRange(header: string | undefined, size: number) {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || !size) return null;
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if (
    [first, last].some(
      (value) => value !== undefined && !Number.isSafeInteger(value),
    )
  )
    return null;
  const start = first ?? Math.max(0, size - last!);
  const end =
    first === undefined || last === undefined
      ? size - 1
      : Math.min(last, size - 1);
  return start >= size || start > end ? null : { start, end };
}

/** A read-only, expiring directory capability. Never give a document the app token. */
export class HtmlPreviews {
  readonly router = Router();
  private grants = new Map<
    string,
    { hostId: string; root: string; expires: number }
  >();
  constructor(
    private files: Files,
    private host: (id: string) => HostConfig,
    private now = Date.now,
  ) {
    this.router.use(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.sendStatus(405);
        return;
      }
      try {
        const [, id, ...segments] = req.path.split("/");
        const grant = this.grants.get(id);
        if (!grant || grant.expires <= this.now()) {
          this.grants.delete(id);
          res
            .status(410)
            .type("text")
            .send(
              "미리보기 연결이 만료되었습니다. 창 위의 새로고침을 눌러 주세요.",
            );
          return;
        }
        const relative = segments.map(decodeURIComponent).join("/");
        const mime = types[path.posix.extname(relative).toLowerCase()];
        if (!mime) {
          res.sendStatus(415);
          return;
        }
        const file = await this.files.htmlResource(
          this.host(grant.hostId),
          grant.root,
          relative,
        );
        if (res.destroyed) return;
        // Opaque-origin sandbox: scripts work, but cannot read parent/storage or use Harbor APIs.
        const scope = `${req.protocol}://${req.get("host")}/html-preview/${id}/`;
        res.setHeader(
          "Content-Security-Policy",
          [
            "default-src 'none'",
            "sandbox allow-scripts",
            "frame-ancestors 'self'",
            `script-src 'unsafe-inline' 'unsafe-eval' ${scope} https:`,
            `style-src 'unsafe-inline' ${scope} https:`,
            `img-src ${scope} https: data: blob:`,
            `font-src ${scope} https: data:`,
            `connect-src ${scope} https:`,
            `base-uri ${scope}`,
            "form-action 'none'",
          ].join("; "),
        );
        res.setHeader("X-Frame-Options", "SAMEORIGIN");
        // Only scoped resources support CORS, for ES modules and fetch in the opaque frame.
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Expose-Headers", "Content-Range");
        res.setHeader("Accept-Ranges", "bytes");
        const range =
          req.method === "GET"
            ? htmlByteRange(req.get("Range"), file.size)
            : undefined;
        if (range === null) {
          res.setHeader("Content-Range", `bytes */${file.size}`);
          res.status(416).end();
          return;
        }
        if (range) {
          res.status(206);
          res.setHeader(
            "Content-Range",
            `bytes ${range.start}-${range.end}/${file.size}`,
          );
        }
        res
          .type(mime)
          .setHeader(
            "Content-Length",
            range ? range.end - range.start + 1 : file.size,
          );
        if (req.method === "HEAD" || !file.size) {
          res.end();
          return;
        }
        // pipeline applies backpressure and destroys the file/SFTP read stream
        // when the window closes or its request is cancelled.
        await pipeline(file.openRead(range), res);
      } catch {
        if (res.headersSent || res.destroyed) return;
        res.removeHeader("Content-Length");
        res.removeHeader("Content-Range");
        res
          .status(404)
          .type("text")
          .send("HTML 문서 폴더 안에서 파일을 찾을 수 없습니다.");
      }
    });
  }
  async open(hostId: string, filename: string) {
    if (!/\.html?$/i.test(filename)) throw new Error("HTML 파일을 선택하세요.");
    const host = this.host(hostId);
    const paths = host.kind === "ssh" ? path.posix : path;
    const name = paths.basename(filename);
    const resource = await this.files.htmlResource(
      host,
      paths.dirname(filename),
      name,
    );
    for (const [id, grant] of this.grants)
      if (grant.expires <= this.now()) this.grants.delete(id);
    while (this.grants.size >= 64)
      this.grants.delete(this.grants.keys().next().value!);
    const id = randomBytes(24).toString("hex");
    this.grants.set(id, {
      hostId,
      root: resource.root,
      expires: this.now() + 60 * 60 * 1000,
    });
    return { url: `/html-preview/${id}/${encodeURIComponent(name)}` };
  }
}
