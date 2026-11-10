import type { Request, Response } from "express";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface MediaFile {
  name: string;
  size: number;
  mime: string;
  read: (range?: { start: number; end: number }) => Readable;
}

function byteRange(header: string | undefined, size: number) {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || !size) return null;
  const first = Number(match[1]),
    last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return null;
  const start = match[1] ? first : Math.max(0, size - last);
  const end = match[1] && match[2] ? Math.min(last, size - 1) : size - 1;
  return start >= size || end < start ? null : { start, end };
}

/** Auth is checked by the caller. Stream local/SFTP files with bounded memory. */
export async function sendMediaFile(
  req: Request,
  res: Response,
  file: MediaFile,
) {
  if (res.destroyed) return;
  // With no validator, an If-Range request falls back to the complete document.
  const range = byteRange(
    req.headers["if-range"] ? undefined : req.headers.range,
    file.size,
  );
  res.setHeader("Content-Type", file.mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, no-store, no-transform");
  res.setHeader(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
  );
  if (file.mime === "application/pdf") {
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
  } else
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
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
  res.setHeader(
    "Content-Length",
    range ? range.end - range.start + 1 : file.size,
  );
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  await pipeline(file.read(range), res).catch((error) => {
    if (!res.headersSent && !res.destroyed) throw error;
  });
}
