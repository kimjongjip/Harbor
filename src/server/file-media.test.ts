import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import compression from "compression";
import { Files } from "./files.js";
import { sendMediaFile } from "./file-media.js";
import type { HostConfig } from "../shared/types.js";

test("large local images and PDFs stream with ranges, HEAD and cancellation", async (t) => {
  const parent = resolve(".cache/media-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "run-"));
  const host = { id: "fixture", kind: "local", defaultCwd: root } as HostConfig;
  const files = new Files(() => undefined);
  const bytes = Buffer.alloc(24 * 1024 * 1024, 65);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  await writeFile(join(root, "large.png"), bytes);
  await writeFile(
    join(root, "large.pdf"),
    Buffer.concat([Buffer.from("%PDF-1.7\n"), bytes]),
  );
  await writeFile(
    join(root, "large.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><!--' +
      "x".repeat(21 * 1024 * 1024) +
      "--></svg>",
  );
  const streams: Readable[] = [];
  const app = express();
  app.use(compression());
  app.get("/:file", async (req, res) => {
    if (req.headers["x-fixture-token"] !== "test") {
      res.status(403).end();
      return;
    }
    const file = req.params.file.endsWith(".pdf")
      ? await files.pdf(host, join(root, req.params.file))
      : await files.image(host, join(root, req.params.file));
    const read = file.read;
    await sendMediaFile(req, res, {
      ...file,
      read: (range) => {
        const stream = read(range);
        streams.push(stream);
        return stream;
      },
    });
  });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    files.shutdown();
    assert.ok(root.startsWith(parent + sep));
    await rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const name of ["large.png", "large.pdf", "large.svg"]) {
    const preview = await files.preview(host, name, root);
    assert.equal(preview.kind, name.endsWith(".pdf") ? "pdf" : "image");
    assert.equal("streaming" in preview && preview.streaming, true);
    const headers = { "X-Fixture-Token": "test" };
    assert.equal((await fetch(origin + "/" + name)).status, 403);
    const before = streams.length;
    const head = await fetch(origin + "/" + name, { method: "HEAD", headers });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get("content-length")), preview.size);
    assert.equal(streams.length, before, "HEAD does not create a body stream");
    for (const [range, start, length] of [
      ["bytes=8-23", 8, 16],
      ["bytes=-13", preview.size - 13, 13],
      [`bytes=${preview.size - 7}-`, preview.size - 7, 7],
    ] as const) {
      const response = await fetch(origin + "/" + name, {
        headers: { ...headers, Range: range },
      });
      assert.equal(response.status, 206);
      assert.equal(
        response.headers.get("content-range"),
        `bytes ${start}-${start + length - 1}/${preview.size}`,
      );
      assert.equal(response.headers.get("content-encoding"), null);
      assert.equal((await response.arrayBuffer()).byteLength, length);
    }
    for (const range of [
      "bytes=999999999-",
      "bytes=4-2",
      "bytes=-0",
      "bytes=0-1,4-5",
    ]) {
      const response = await fetch(origin + "/" + name, {
        headers: { ...headers, Range: range },
      });
      assert.equal(response.status, 416);
      assert.equal(
        response.headers.get("content-range"),
        `bytes */${preview.size}`,
      );
    }
  }
  const full = await fetch(origin + "/large.png", {
    headers: { "X-Fixture-Token": "test" },
  });
  assert.equal(full.status, 200);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  const abort = new AbortController();
  const response = await fetch(origin + "/large.svg", {
    headers: { "X-Fixture-Token": "test" },
    signal: abort.signal,
  });
  await response.body!.getReader().read();
  abort.abort();
  for (let attempt = 0; attempt < 100 && !streams.at(-1)!.destroyed; attempt++)
    await new Promise((done) => setTimeout(done, 10));
  assert.equal(
    streams.at(-1)!.destroyed,
    true,
    "Closing a preview destroys its source stream",
  );
});

test("SSH image previews only sniff a bounded header and read the requested remote range", async () => {
  const files = new Files(() => undefined);
  const host = { id: "remote-fixture", kind: "ssh" } as HostConfig;
  const ranges: unknown[] = [];
  const bytes = Buffer.alloc(64 * 1024, 65);
  Buffer.from([0xff, 0xd8, 0xff]).copy(bytes);
  (files as any).connections.set(host.id, {
    connection: { end() {} },
    sftp: {
      stat(_path: string, cb: Function) {
        cb(null, {
          size: 512 * 1024 * 1024,
          isFile: () => true,
          isDirectory: () => false,
        });
      },
      createReadStream(
        filename: string,
        range?: { start: number; end: number },
      ) {
        assert.equal(filename, "/fixture/large.jpg");
        ranges.push(range);
        assert.ok(range, "Do not eagerly download a large image");
        return Readable.from([bytes.subarray(range.start, range.end + 1)]);
      },
    },
  });
  try {
    const image = await files.image(host, "/fixture/large.jpg");
    assert.equal(image.mime, "image/jpeg");
    assert.equal(image.size, 512 * 1024 * 1024);
    assert.deepEqual(ranges, [{ start: 0, end: 64 * 1024 - 1 }]);
    const chunks: Buffer[] = [];
    for await (const chunk of image.read({ start: 10, end: 19 }))
      chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).length, 10);
    assert.deepEqual(ranges.at(-1), { start: 10, end: 19 });
  } finally {
    files.shutdown();
  }
});
