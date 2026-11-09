import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import { Files } from "./files.js";
import { HtmlPreviews, htmlByteRange } from "./html-preview.js";
import type { HostConfig } from "../shared/types.js";

test("HTML preserves complete documents, scoped assets and expiration; rejects escape paths and symlinks", async (t) => {
  const root = resolve(".cache/html-tests");
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(join(root, "run-"));
  const docs = join(dir, "docs");
  await fs.mkdir(join(docs, "assets"), { recursive: true });
  const text = `<!doctype html><h1>한국어</h1><!--${"x".repeat(300000)}--><p>complete</p>`;
  await fs.writeFile(join(docs, "보고서.HTML"), text);
  await fs.writeFile(join(docs, "assets", "style.css"), "h1 { color: blue }");
  await fs.writeFile(join(dir, "outside.txt"), "secret");
  await fs.symlink(
    dir,
    join(docs, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const host = { id: "local", kind: "local", defaultCwd: dir } as HostConfig;
  const files = new Files(() => undefined);
  let now = 0;
  const previews = new HtmlPreviews(
    files,
    () => host,
    () => now,
  );
  const app = express();
  app.use("/html-preview", previews.router);
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  t.after(async () => {
    files.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.ok(dir.startsWith(root + sep));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const meta = await files.preview(host, "docs/보고서.HTML", dir);
  assert.equal(meta.kind, "html");
  assert.equal("text" in meta, false);
  const { url } = await previews.open(host.id, meta.path);
  const response = await fetch(origin + url);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), text);
  assert.match(
    response.headers.get("content-security-policy")!,
    /sandbox allow-scripts/,
  );
  assert.doesNotMatch(
    response.headers.get("content-security-policy")!,
    /allow-same-origin/,
  );
  const base = new URL(".", origin + url).href;
  const css = await fetch(base + "assets/style.css", {
    headers: { Origin: "null" },
  });
  assert.equal(css.headers.get("access-control-allow-origin"), "*");
  assert.match(css.headers.get("content-type")!, /text\/css/);
  assert.equal(await css.text(), "h1 { color: blue }");
  for (const relative of [
    "../outside.txt",
    "escape/outside.txt",
    "assets/../../outside.txt",
    "C:/outside.txt",
    "assets\\style.css",
    ".env",
  ])
    await assert.rejects(files.htmlResource(host, docs, relative));
  assert.equal((await fetch(base + "escape/outside.txt")).status, 404);
  assert.equal((await fetch(base + "private.pem")).status, 415);
  assert.equal(
    (await fetch(base + "assets/style.css", { method: "POST" })).status,
    405,
  );
  now = 3600001;
  assert.equal((await fetch(origin + url)).status, 410);
});

test("SSH HTML uses POSIX SFTP paths and prevents symlink escape without invoking a shell", async () => {
  const files = new Files(() => undefined);
  const host = { id: "ssh", kind: "ssh", defaultCwd: "~" } as HostConfig;
  const read: string[] = [];
  (files as any).sftp = async () => ({
    realpath(value: string, cb: Function) {
      cb(null, value === "/site/outside.css" ? "/private/secret.css" : value);
    },
    stat(_value: string, cb: Function) {
      cb(null, { size: 30, isFile: () => true, isDirectory: () => false });
    },
    createReadStream(value: string) {
      read.push(value);
      return Readable.from([Buffer.from("<h1>SSH HTML</h1>")]);
    },
  });
  assert.equal((await files.preview(host, "report.htm", "/site")).kind, "html");
  const resource = await files.htmlResource(host, "/site", "report.htm");
  assert.deepEqual(read, [], "SFTP metadata lookup must not download the file");
  let text = "";
  for await (const chunk of resource.openRead()) text += chunk.toString();
  assert.equal(text, "<h1>SSH HTML</h1>");
  await assert.rejects(files.htmlResource(host, "/site", "outside.css"));
  assert.deepEqual(read, ["/site/report.htm"]);
});

test("large HTML and JSON stream intact; issuing a URL and HEAD never read payloads, ranges remain bounded", async (t) => {
  const root = resolve(".cache/html-tests");
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(join(root, "large-"));
  const filename = join(dir, "large.html");
  const handle = await fs.open(filename, "w");
  const expected = createHash("sha256");
  const write = async (bytes: Buffer) => {
    expected.update(bytes);
    await handle.write(bytes);
  };
  await write(Buffer.from("<!doctype html><!--"));
  for (let i = 0; i < 32; i++) await write(Buffer.alloc(1024 * 1024, "x"));
  await write(Buffer.from("--><p>대용량 문서 끝</p>"));
  await handle.close();
  const size = (await fs.stat(filename)).size;
  await fs.copyFile(filename, join(dir, "large.json"));
  const host = { id: "local", kind: "local", defaultCwd: dir } as HostConfig;
  const files = new Files(() => undefined);
  const original = files.htmlResource.bind(files);
  let opened = 0;
  files.htmlResource = async (...args) => {
    const resource = await original(...args);
    return {
      ...resource,
      openRead: (range) => {
        opened++;
        return resource.openRead(range);
      },
    };
  };
  const previews = new HtmlPreviews(files, () => host);
  const app = express();
  app.use("/html-preview", previews.router);
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  t.after(async () => {
    files.shutdown();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    assert.ok(dir.startsWith(root + sep));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const { url } = await previews.open(host.id, filename);
  assert.equal(opened, 0);
  const head = await fetch(origin + url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get("content-length")), size);
  assert.equal(opened, 0);
  const partial = await fetch(origin + url, {
    headers: { Range: "bytes=0-31" },
  });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), `bytes 0-31/${size}`);
  assert.equal((await partial.arrayBuffer()).byteLength, 32);
  const tail = await fetch(origin + url, { headers: { Range: "bytes=-10" } });
  assert.equal(tail.status, 206);
  assert.equal((await tail.arrayBuffer()).byteLength, 10);
  const invalid = await fetch(origin + url, {
    headers: { Range: `bytes=${size}-` },
  });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), `bytes */${size}`);
  const response = await fetch(origin + url);
  const digest = createHash("sha256");
  let received = 0;
  const reader = response.body!.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    digest.update(value);
    received += value.byteLength;
  }
  reader.releaseLock();
  assert.equal(received, size);
  assert.equal(digest.digest("hex"), expected.digest("hex"));
  const json = await fetch(new URL("large.json", origin + url), {
    headers: { Range: "bytes=0-1023" },
  });
  assert.equal(json.status, 206);
  assert.equal((await json.arrayBuffer()).byteLength, 1024);
});

test("cancelled HTML requests stop the SFTP stream without buffering the remaining file", async (t) => {
  const size = 100 * 1024 * 1024;
  let produced = 0,
    destroyed = false,
    reads = 0;
  const files = new Files(() => undefined);
  (files as any).sftp = async () => ({
    realpath(value: string, cb: Function) {
      cb(null, value);
    },
    stat(_value: string, cb: Function) {
      cb(null, { size, isFile: () => true });
    },
    createReadStream() {
      reads++;
      return new Readable({
        highWaterMark: 65536,
        read() {
          if (produced >= size) this.push(null);
          else {
            produced += 65536;
            this.push(Buffer.alloc(65536, "x"));
          }
        },
        destroy(error, callback) {
          destroyed = true;
          callback(error);
        },
      });
    },
  });
  const host = { id: "remote", kind: "ssh" } as HostConfig;
  const previews = new HtmlPreviews(files, () => host);
  const app = express();
  app.use("/html-preview", previews.router);
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    files.shutdown();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const { url } = await previews.open(host.id, "/site/index.html");
  assert.equal(reads, 0);
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as any).port}${url}`,
  );
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  for (let i = 0; i < 100 && !destroyed; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(destroyed, "closing the window releases its remote file read");
  assert.ok(
    produced < size / 2,
    "backpressure prevents eagerly reading the whole remote file",
  );
});

test("HTML byte ranges handle suffixes, EOF, empty files and invalid multi-ranges", () => {
  assert.equal(htmlByteRange(undefined, 10), undefined);
  assert.deepEqual(htmlByteRange("bytes=2-999", 10), { start: 2, end: 9 });
  assert.deepEqual(htmlByteRange("bytes=5-", 10), { start: 5, end: 9 });
  assert.deepEqual(htmlByteRange("bytes=-3", 10), { start: 7, end: 9 });
  for (const value of [
    "bytes=10-",
    "bytes=-0",
    "bytes=5-2",
    "bytes=0-1,3-4",
    "bytes=-",
    "bytes=9007199254740992-",
  ])
    assert.equal(htmlByteRange(value, 10), null);
  assert.equal(htmlByteRange("bytes=0-1", 0), null);
});
