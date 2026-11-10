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
test("SVG figures resolve from the Markdown directory and use the image endpoint", async (t) => {
  const { dir, host, files } = await setup(t);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="blue"/></svg>';
  await fs.writeFile(join(dir, "figure.svg"), svg);
  const preview = await files.preview(host, "figure.svg", dir);
  assert.equal(preview.kind, "image");
  const image = await files.image(host, preview.path);
  assert.equal(image.mime, "image/svg+xml");
  const chunks: Buffer[] = [];
  for await (const chunk of image.read()) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), svg);
  await fs.writeFile(join(dir, "not-image.svg"), "<html>not an image</html>");
  await assert.rejects(
    files.image(host, join(dir, "not-image.svg")),
    /이미지 형식/,
  );
});

test("preview resolves repository-relative links from a nested cwd without duplicating document folders", async (t) => {
  const { dir, host, files } = await setup(t);
  await fs.mkdir(join(dir, ".git"));
  const docs = join(dir, "docs"),
    research = join(docs, "research");
  await fs.mkdir(research, { recursive: true });
  await fs.writeFile(join(research, "goal.md"), "# Actual repository document");
  const result = await files.preview(host, "docs/research/goal.md", docs);
  assert.equal(result.path, join(research, "goal.md"));
  assert.equal(result.resolvedFrom, dir);
  assert.ok("text" in result);
  assert.equal(result.text, "# Actual repository document");
  await fs.mkdir(join(docs, "docs/research"), { recursive: true });
  await fs.writeFile(
    join(docs, "docs/research/goal.md"),
    "Exact cwd document wins",
  );
  const exact = await files.preview(host, "docs/research/goal.md", docs);
  assert.ok("text" in exact);
  assert.equal(exact.text, "Exact cwd document wins");
  assert.equal(
    (await files.preview(host, join(research, "goal.md"), "~")).path,
    join(research, "goal.md"),
  );
  await assert.rejects(
    files.preview(host, "./research/goal.md", dir),
    /ENOENT/,
  );
  await assert.rejects(files.preview(host, "missing.md", docs), (error) => {
    assert.match((error as Error).message, /확인한 경로/);
    assert.ok((error as Error).message.includes(join(docs, "missing.md")));
    assert.ok((error as Error).message.includes(join(dir, "missing.md")));
    return true;
  });
});

test("a worktree root is authoritative and a non-Git folder overlap can be resolved without broad file searches", async (t) => {
  const { dir, host, files } = await setup(t);
  const project = join(dir, "project"),
    docs = join(project, "docs");
  await fs.mkdir(docs, { recursive: true });
  await fs.writeFile(join(docs, "plain.md"), "A plain folder document");
  assert.equal(
    (await files.preview(host, "docs/plain.md", docs)).path,
    join(docs, "plain.md"),
  );
  await fs.writeFile(
    join(project, ".git"),
    "gitdir: /fixture/worktrees/project",
  );
  await fs.writeFile(join(project, "root.csv"), "a,b\n1,2");
  assert.equal(
    (await files.preview(host, "root.csv", docs)).path,
    join(project, "root.csv"),
  );
  await fs.mkdir(join(dir, ".git"));
  await fs.writeFile(
    join(dir, "outside.md"),
    "Must not open another repository",
  );
  await assert.rejects(
    files.preview(host, "outside.md", docs),
    /찾을 수 없습니다/,
  );
  // The overlap must not escape a nested repository root.
  await fs.mkdir(join(docs, ".git"));
  await fs.mkdir(join(docs, "docs"));
  await fs.writeFile(join(docs, "outside.md"), "Outside the nearest worktree");
  await assert.rejects(
    files.preview(host, "docs/outside.md", join(docs, "docs")),
    /찾을 수 없습니다/,
  );
});

test("SSH previews resolve only POSIX paths on the selected host and never hide permission failures", async (t) => {
  const { files } = await setup(t);
  const host = {
    id: "fixture-ssh",
    kind: "ssh",
    defaultCwd: "~",
  } as HostConfig;
  const seen: string[] = [],
    read: string[] = [];
  let denied = false;
  const root = "/srv/fixture/project",
    cwd = root + "/docs";
  const document = root + "/docs/research/goal.md";
  const sftp = {
    stat(value: string, callback: Function) {
      seen.push(value);
      if (denied)
        return callback(
          Object.assign(new Error("Permission denied"), { code: 3 }),
        );
      if (![root + "/.git", document].includes(value))
        return callback(Object.assign(new Error("No such file"), { code: 2 }));
      callback(null, {
        size: 20,
        isFile: () => true,
        isDirectory: () => false,
      });
    },
    createReadStream(value: string) {
      read.push(value);
      return Readable.from(["# SSH fixture"]);
    },
  };
  (files as any).connections.set(host.id, { sftp, connection: { end() {} } });
  const result = await files.preview(host, "docs/research/goal.md", cwd);
  assert.equal(result.path, document);
  assert.equal(result.resolvedFrom, root);
  assert.deepEqual(read, [document]);
  assert.ok(
    seen.every((value) => value.startsWith("/") && !value.includes("\\")),
  );
  seen.length = 0;
  denied = true;
  await assert.rejects(
    files.preview(host, "docs/research/goal.md", cwd),
    (error: any) => error.code === 3,
  );
  assert.deepEqual(seen, [cwd + "/docs/research/goal.md"]);
});

test("research artifacts canonicalize local paths, reject escape and binary data", async (t) => {
  const { dir, host, files } = await setup(t);
  const project = join(dir, "project");
  await fs.mkdir(project);
  await fs.writeFile(join(project, "evidence.txt"), "actual UTF-8 evidence");
  await fs.writeFile(join(dir, "outside.txt"), "outside");
  await fs.writeFile(join(project, "binary.txt"), Buffer.from([0, 1, 2]));
  await fs.writeFile(
    join(project, "large.txt"),
    Buffer.alloc(512 * 1024 + 1, 65),
  );
  assert.equal(
    await files.researchDirectory(host, project),
    await fs.realpath(project),
  );
  assert.equal(
    (
      await files.researchArtifact(host, project, project, "evidence.txt")
    ).bytes.toString(),
    "actual UTF-8 evidence",
  );
  await assert.rejects(
    files.researchArtifact(host, project, project, "../outside.txt"),
    /작업 폴더/,
  );
  for (const name of ["binary.txt", "large.txt"])
    await assert.rejects(
      files.researchArtifact(host, project, project, name),
      /텍스트/,
    );
});

test("SSH research paths use SFTP owner routing and reject canonical symlink escape", async (t) => {
  const { files } = await setup(t);
  const remote = {
    id: "fixture-ssh",
    kind: "ssh",
    defaultCwd: "~",
  } as HostConfig;
  const reads: string[] = [];
  const sftp = {
    realpath: (value: string, cb: Function) =>
      cb(
        null,
        value === "."
          ? "/home/fixture"
          : value === "/home/fixture/work/escape.txt"
            ? "/secret/outside.txt"
            : value,
      ),
    stat: (value: string, cb: Function) =>
      cb(null, {
        size: 8,
        isDirectory: () => !value.endsWith(".txt"),
        isFile: () => value.endsWith(".txt"),
      }),
    createReadStream: (value: string) => {
      reads.push(value);
      return Readable.from([Buffer.from("evidence")]);
    },
  };
  (files as any).connections.set(remote.id, { sftp, connection: { end() {} } });
  assert.equal(
    await files.researchDirectory(remote, "~/work"),
    "/home/fixture/work",
  );
  assert.equal(
    (
      await files.researchArtifact(
        remote,
        "/home/fixture/work",
        "/home/fixture/work",
        "result.txt",
      )
    ).bytes.toString(),
    "evidence",
  );
  await assert.rejects(
    files.researchArtifact(
      remote,
      "/home/fixture/work",
      "/home/fixture/work",
      "escape.txt",
    ),
    /작업 폴더/,
  );
  assert.deepEqual(reads, ["/home/fixture/work/result.txt"]);
});

test("PDF previews preserve resolved document paths and original binary bytes", async (t) => {
  const { dir, host, files } = await setup(t);
  await fs.mkdir(join(dir, "docs"));
  const filename = join(dir, "docs", "설계.PDF");
  const bytes = Buffer.from("%PDF-1.7\n\0binary document fixture", "utf8");
  await fs.writeFile(filename, bytes);
  const preview = await files.preview(host, "docs/설계.PDF", dir);
  assert.equal(preview.kind, "pdf");
  assert.equal(preview.path, filename);
  assert.equal(preview.size, bytes.length);
  assert.equal("text" in preview, false);
  const absolute = await files.preview(host, filename, "unrelated");
  assert.equal(absolute.path, filename);
  const download = await files.download(host, preview.path);
  const chunks = [];
  for await (const chunk of download.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), bytes);
});

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

test("folder upload prepares nested and empty directories and writes original bytes without flattening", async (t) => {
  const { dir, host, files } = await setup(t);
  const plan = await files.prepareUpload(host, dir, {
    directories: ["project/empty", "project", "project/src"],
    files: [
      { relativePath: "project/README.md", size: 5 },
      { relativePath: "project/src/main.py", size: 6 },
    ],
  });
  assert.equal(plan.directoryCount, 3);
  assert.ok((await fs.stat(join(dir, "project/empty"))).isDirectory());
  for (const file of plan.files)
    await files.upload(
      host,
      file.directory,
      file.name,
      Readable.from([file.name === "README.md" ? "hello" : "print()"]),
    );
  assert.equal(
    await fs.readFile(join(dir, "project/README.md"), "utf8"),
    "hello",
  );
  assert.equal(
    await fs.readFile(join(dir, "project/src/main.py"), "utf8"),
    "print()",
  );
  await assert.rejects(fs.stat(join(dir, "main.py")), { code: "ENOENT" });
  await assert.rejects(
    files.prepareUpload(host, dir, {
      directories: ["new-folder", "project"],
      files: [],
    }),
    /같은 이름/,
  );
  await assert.rejects(fs.stat(join(dir, "new-folder")), { code: "ENOENT" });
  assert.equal(
    await fs.readFile(join(dir, "project/README.md"), "utf8"),
    "hello",
  );
});

test("folder upload validates the complete manifest before creating anything", async (t) => {
  const { dir, host, files } = await setup(t);
  for (const value of [
    { directories: ["new"], files: [{ relativePath: "../outside", size: 1 }] },
    {
      directories: ["new"],
      files: [{ relativePath: "new/huge", size: 512 * 1024 * 1024 + 1 }],
    },
    { directories: ["new", "new/../outside"], files: [] },
  ])
    await assert.rejects(files.prepareUpload(host, dir, value));
  assert.deepEqual(await fs.readdir(dir), []);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    files.prepareUpload(
      host,
      dir,
      { directories: ["new"], files: [] },
      controller.signal,
    ),
  );
  assert.deepEqual(await fs.readdir(dir), []);
});

test("SFTP folder upload stays on the chosen server and rolls back only its new empty directories when cancelled", async (t) => {
  const { files } = await setup(t);
  const host = {
    id: "fixture-folder-ssh",
    kind: "ssh",
    defaultCwd: "~",
  } as HostConfig;
  const controller = new AbortController(),
    created: string[] = [],
    removed: string[] = [];
  const sftp = {
    realpath: (_: string, cb: Function) => cb(null, "/srv/fixture/target"),
    stat: (_: string, cb: Function) => cb(null, { isDirectory: () => true }),
    lstat: (_: string, cb: Function) =>
      cb(Object.assign(new Error("missing"), { code: 2 })),
    mkdir: (name: string, _: any, cb: Function) => {
      created.push(name);
      controller.abort();
      cb(null);
    },
    rmdir: (name: string, cb: Function) => {
      removed.push(name);
      cb(null);
    },
  };
  (files as any).connections.set(host.id, { sftp, connection: { end() {} } });
  await assert.rejects(
    files.prepareUpload(
      host,
      "/srv/fixture/target",
      { directories: ["project", "project/empty"], files: [] },
      controller.signal,
    ),
  );
  assert.deepEqual(created, ["/srv/fixture/target/project"]);
  assert.deepEqual(removed, created);
  created.length = 0;
  removed.length = 0;
  sftp.mkdir = (name: string, _: any, cb: Function) => {
    created.push(name);
    cb(null);
  };
  const plan = await files.prepareUpload(host, "/srv/fixture/target", {
    directories: ["project", "project/src"],
    files: [{ relativePath: "project/src/파일.txt", size: 1 }],
  });
  assert.deepEqual(plan.files, [
    {
      relativePath: "project/src/파일.txt",
      directory: "/srv/fixture/target/project/src",
      name: "파일.txt",
    },
  ]);
  assert.deepEqual(removed, []);
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
