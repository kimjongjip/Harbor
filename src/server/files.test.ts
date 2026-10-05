import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { Readable } from "node:stream";
import { Files, safeFilename, validateFilePath } from "./files.js";
import { validateImages } from "./images.js";
import { normalizeItem, transcriptContext } from "./session.js";
import type { HostConfig, SessionView } from "../shared/types.js";

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfgAAAABJRU5ErkJggg==";
async function setup(t: any) {
  const parent = resolve(".cache/file-tests");
  await fs.mkdir(parent, { recursive: true });
  const dir = await fs.mkdtemp(join(parent, "run-"));
  const host = { id: "local", kind: "local", defaultCwd: dir } as HostConfig;
  const files = new Files(() => undefined);
  t.after(async () => {
    files.shutdown();
    if (resolve(dir).startsWith(parent + sep))
      await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, host, files };
}
test("file listing, UTF-8 names, binary upload/download and exclusive collision protection", async (t) => {
  const { dir, host, files } = await setup(t);
  const bytes = Buffer.from([0, 255, 13, 10, 128, 49]);
  await files.mkdir(host, dir, "자료");
  const result = await files.upload(
    host,
    dir,
    "실험 이미지.bin",
    Readable.from([bytes]),
  );
  assert.equal(result.size, bytes.length);
  const list = await files.list(host, dir);
  assert.equal(list.entries.find((e) => e.name === "자료")?.kind, "directory");
  assert.equal(
    list.entries.find((e) => e.name === "실험 이미지.bin")?.size,
    bytes.length,
  );
  const downloaded = await files.download(host, result.path);
  const chunks = [];
  for await (const chunk of downloaded.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  await assert.rejects(
    files.upload(host, dir, "실험 이미지.bin", Readable.from(["replacement"])),
    /덮어쓰지/,
  );
  assert.deepEqual(await fs.readFile(result.path), bytes);
  await assert.rejects(files.download(host, join(dir, "자료")), /파일을 선택/);
});
test("failed upload removes only the file this request created", async (t) => {
  const { dir, host, files } = await setup(t);
  await fs.writeFile(join(dir, "existing.txt"), "keep");
  const source = new Readable({
    read() {
      this.push(Buffer.from("partial"));
      this.destroy(new Error("cancelled upload"));
    },
  });
  await assert.rejects(
    files.upload(host, dir, "partial.bin", source),
    /cancelled/,
  );
  await assert.rejects(fs.stat(join(dir, "partial.bin")), { code: "ENOENT" });
  assert.equal(await fs.readFile(join(dir, "existing.txt"), "utf8"), "keep");
});
test("file upload rejects traversal and Windows alternate data streams", async (t) => {
  const { dir, host, files } = await setup(t);
  for (const value of ["..", ".", "../file", "a/b", "a\\b", "a\0b", "a\nb"])
    assert.throws(() => safeFilename(value));
  assert.throws(() => validateFilePath({ kind: "ssh" }, "relative/path"));
  if (process.platform === "win32")
    await assert.rejects(
      files.upload(host, dir, "file:secret", Readable.from(["x"])),
      /Windows/,
    );
});
test("image inputs validate content, size and count; context relay does not include image bytes", () => {
  assert.deepEqual(validateImages([png]), [png]);
  assert.throws(() => validateImages(["data:image/svg+xml;base64,PHN2Zz4="]));
  assert.throws(() => validateImages(["data:image/png;base64,aGVsbG8="]));
  assert.throws(() => validateImages(Array(5).fill(png)));
  const huge =
    "data:image/png;base64," +
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(5 * 1024 * 1024),
    ]).toString("base64");
  assert.throws(() => validateImages([huge]), /5MB/);
  const item = normalizeItem({
    id: "image",
    type: "userMessage",
    content: [
      { type: "image", url: png },
      { type: "text", text: "look" },
    ],
  });
  assert.equal(item?.imageCount, 1);
  assert.equal(item?.text, "look");
  assert.ok(!JSON.stringify(item).includes("base64"));
  const context = transcriptContext({
    title: "image",
    hostId: "local",
    cwd: "/tmp",
    threadId: "id",
    items: [item],
  } as SessionView);
  assert.match(context, /이미지 자체는 이 맥락에 포함되지 않음/);
});
