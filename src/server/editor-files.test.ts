import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import express from "express";
import iconv from "iconv-lite";
import type { SFTPWrapper } from "ssh2";
import type { HostConfig, TerminalInfo } from "../shared/types.js";
import { Files } from "./files.js";
import {
  EDITOR_MAX_BYTES,
  EditorError,
  EditorFiles,
  createEditorRouter,
  localEditorTransport,
  sshEditorTransport,
  type EditorTransport,
} from "./editor-files.js";

async function setup(t: any) {
  const parent = path.resolve(".cache/editor-tests");
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, "run-"));
  const root = path.join(directory, "project");
  await fs.mkdir(root);
  const host = {
    id: "test-local",
    kind: "local",
    defaultCwd: root,
  } as HostConfig;
  const terminal = {
    id: "test-terminal",
    hostId: host.id,
    cwd: root,
    exited: false,
    connectionState: "connected",
    agentSessionId: "native-one",
  } as TerminalInfo;
  const files = new Files(() => undefined);
  // Every test uses an isolated synthetic home, never this user's actual files.
  files.resolvePath = async (_host, filename, cwd) => {
    assert.equal(filename, "~");
    assert.equal(cwd, "~");
    return root;
  };
  const options = {
    files,
    terminal: (id: string) => (id === terminal.id ? terminal : undefined),
    host: () => host,
  };
  const service = new EditorFiles(options);
  t.after(async () => {
    files.shutdown();
    if (path.resolve(directory).startsWith(parent + path.sep))
      await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, root, host, terminal, files, options, service };
}

const errorCode = (code: string) => (error: unknown) =>
  error instanceof EditorError && error.code === code;

test("editor binds its tree to home and preserves UTF-8 BOM and exact newline bytes", async (t) => {
  const { service, root, terminal } = await setup(t);
  const original = "\ufeff# 한글\r\n\r\nconst value = 1;\r\n";
  await fs.writeFile(path.join(root, "README.md"), original);
  await fs.mkdir(path.join(root, "source"));
  const tree = await service.list(terminal.id);
  assert.equal(tree.root, await fs.realpath(root));
  assert.equal(tree.parent, null);
  assert.deepEqual(
    tree.entries.map((entry) => entry.name),
    ["source", "README.md"],
  );
  const document = await service.read(terminal.id, "README.md");
  assert.equal(document.binding, tree.binding);
  assert.equal(document.content, original.slice(1));
  assert.equal(document.encoding, "utf-8");
  assert.equal(document.bom, true);
  assert.equal(document.version.length, 64);
  const saved = await service.save(terminal.id, {
    ...document,
    expectedVersion: document.version,
    content: document.content.replace("1", "2"),
  });
  assert.notEqual(saved.version, document.version);
  assert.equal(saved.content, (await fs.readFile(saved.path, "utf8")).slice(1));
  assert.equal(
    await fs.readFile(saved.path, "utf8"),
    original.replace("1", "2"),
  );
  assert.equal(
    (await fs.readdir(root)).some((name) => name.startsWith(".harbor-edit-")),
    false,
  );
});

test("editor rejects traversal, sibling-prefix roots and symlink escapes", async (t) => {
  const { service, directory, root, terminal } = await setup(t);
  const outside = path.join(directory, "project-other");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "private.txt"), "outside");
  await fs.symlink(
    outside,
    path.join(root, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const filename of [
    "../project-other/private.txt",
    path.join(outside, "private.txt"),
    "escape/private.txt",
  ]) {
    await assert.rejects(
      service.read(terminal.id, filename),
      errorCode("EDITOR_OUTSIDE_WORKSPACE"),
    );
  }
  await assert.rejects(
    service.list(terminal.id, "escape"),
    errorCode("EDITOR_OUTSIDE_WORKSPACE"),
  );
  await assert.rejects(
    service.read(terminal.id, "bad\0name"),
    errorCode("EDITOR_INVALID_PATH"),
  );
});

test("editor rejects invalid UTF-8, binary data and oversized text without truncation", async (t) => {
  const { service, root, terminal } = await setup(t);
  for (const [name, bytes] of [
    ["binary.bin", Buffer.from([65, 0, 66])],
    ["invalid.txt", Buffer.from([0xc3, 0x28])],
    ["large.txt", Buffer.alloc(EDITOR_MAX_BYTES + 1, 65)],
  ] as const) {
    await fs.writeFile(path.join(root, name), bytes);
    await assert.rejects(
      service.read(terminal.id, name),
      errorCode(
        name === "large.txt"
          ? "EDITOR_TOO_LARGE"
          : name === "invalid.txt"
            ? "EDITOR_ENCODING_REQUIRED"
            : "EDITOR_BINARY",
      ),
    );
  }
  await fs.writeFile(path.join(root, "text.txt"), "initial");
  const document = await service.read(terminal.id, "text.txt");
  await assert.rejects(
    service.save(terminal.id, {
      ...document,
      expectedVersion: document.version,
      content: "\ud800",
    }),
    errorCode("EDITOR_INVALID_TEXT"),
  );
  await assert.rejects(
    service.save(terminal.id, {
      ...document,
      expectedVersion: document.version,
      content: "a".repeat(EDITOR_MAX_BYTES + 1),
    }),
    errorCode("EDITOR_TOO_LARGE"),
  );
});

test("UTF-16 BOM documents round-trip locally and preserve their original byte order", async (t) => {
  const { service, root, terminal } = await setup(t);
  for (const encoding of ["utf-16le", "utf-16be"] as const) {
    const name = `${encoding}.txt`;
    const content = "한글 메모 😀\r\nsecond line\r\n";
    const original = iconv.encode(content, encoding, { addBOM: true });
    await fs.writeFile(path.join(root, name), original);
    const initial = await service.read(terminal.id, name);
    assert.equal(initial.content, content);
    assert.equal(initial.encoding, encoding);
    assert.equal(initial.bom, true);
    const unchanged = await service.save(terminal.id, {
      ...initial,
      expectedVersion: initial.version,
    });
    assert.equal(unchanged.version, initial.version);
    assert.deepEqual(await fs.readFile(initial.path), original);
    const changed = await service.save(terminal.id, {
      ...initial,
      content: content.replace("메모", "수정"),
      expectedVersion: initial.version,
    });
    assert.equal(changed.encoding, encoding);
    assert.deepEqual(
      await fs.readFile(initial.path),
      iconv.encode(changed.content, encoding, { addBOM: true }),
    );
  }
});

test("legacy Korean files require explicit CP949 and reject characters that cannot round-trip", async (t) => {
  const { service, root, terminal } = await setup(t);
  const filename = path.join(root, "korean.txt");
  const content = "한글 문서\r\n갂";
  const original = iconv.encode(content, "cp949");
  await fs.writeFile(filename, original);
  await assert.rejects(service.read(terminal.id, filename), (error: any) => {
    assert.equal(error.code, "EDITOR_ENCODING_REQUIRED");
    assert.deepEqual(error.details.encodings, ["cp949"]);
    assert.equal(error.details.path, filename);
    assert.equal(error.details.size, original.length);
    return true;
  });
  const initial = await service.read(terminal.id, filename, "cp949");
  assert.equal(initial.encoding, "cp949");
  assert.equal(initial.content, content);
  assert.equal(initial.bom, false);
  const saved = await service.save(terminal.id, {
    ...initial,
    content: "수정한 한글\r\n갂",
    expectedVersion: initial.version,
  });
  assert.deepEqual(
    await fs.readFile(filename),
    iconv.encode(saved.content, "cp949"),
  );
  await assert.rejects(
    service.save(terminal.id, {
      ...saved,
      content: "emoji 😀",
      expectedVersion: saved.version,
    }),
    errorCode("EDITOR_UNREPRESENTABLE_TEXT"),
  );
  assert.deepEqual(
    await fs.readFile(filename),
    iconv.encode(saved.content, "cp949"),
  );
  await fs.writeFile(filename, Buffer.from([0x81]));
  await assert.rejects(
    service.read(terminal.id, filename, "cp949"),
    errorCode("EDITOR_INVALID_ENCODING_DATA"),
  );
});

test("non-text errors include preview choices and never decode containers as CP949", async (t) => {
  const { service, root, terminal } = await setup(t);
  for (const [name, bytes, preview] of [
    ["image.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), "image"],
    ["document.pdf", Buffer.from("%PDF-1.7\nplain ASCII header"), "pdf"],
    ["large.pdf", Buffer.alloc(EDITOR_MAX_BYTES + 1, 65), "pdf"],
    ["large.png", Buffer.alloc(EDITOR_MAX_BYTES + 1, 65), "image"],
    ["large.svg", Buffer.alloc(EDITOR_MAX_BYTES + 1, 65), "image"],
    ["binary.dat", Buffer.from([0x61, 0, 0x62]), "download"],
    ["large.html", Buffer.alloc(EDITOR_MAX_BYTES + 1, 65), "html"],
  ] as const) {
    const filename = path.join(root, name);
    await fs.writeFile(filename, bytes);
    await assert.rejects(
      service.read(terminal.id, filename, "cp949"),
      (error: any) => {
        assert.equal(
          error.code,
          name === "large.html" ? "EDITOR_TOO_LARGE" : "EDITOR_BINARY",
        );
        assert.equal(error.details.preview, preview);
        assert.equal(error.details.encodings, undefined);
        return true;
      },
    );
    assert.deepEqual(await fs.readFile(filename), bytes);
  }
});

test("conflicts include current contents and simultaneous saves cannot lose an edit", async (t) => {
  const { service, root, terminal } = await setup(t);
  await fs.writeFile(path.join(root, "main.ts"), "initial");
  const initial = await service.read(terminal.id, "main.ts");
  const results = await Promise.allSettled(
    ["left", "right"].map((content) =>
      service.save(terminal.id, {
        ...initial,
        content,
        expectedVersion: initial.version,
      }),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const failed = results.find(
    (result) => result.status === "rejected",
  ) as PromiseRejectedResult;
  const winner = results.find(
    (result) => result.status === "fulfilled",
  ) as PromiseFulfilledResult<{ content: string }>;
  assert.equal(failed.reason.code, "EDITOR_CONFLICT");
  assert.equal(failed.reason.current.content, winner.value.content);
  assert.equal(await fs.readFile(initial.path, "utf8"), winner.value.content);
  await fs.writeFile(initial.path, "external writer");
  await assert.rejects(
    service.save(terminal.id, {
      ...initial,
      content: "overwrite",
      expectedVersion: initial.version,
    }),
    (error: any) => {
      assert.equal(error.code, "EDITOR_CONFLICT");
      assert.equal(error.current.content, "external writer");
      return true;
    },
  );
});

test("native session, restart and offline changes invalidate saving while cwd stays context", async (t) => {
  const { service, root, terminal, options } = await setup(t);
  await fs.writeFile(path.join(root, "main.ts"), "initial");
  const initial = await service.read(terminal.id, "main.ts");
  const save = () =>
    service.save(terminal.id, {
      ...initial,
      content: "overwrite",
      expectedVersion: initial.version,
    });
  terminal.agentSessionId = "native-two";
  await assert.rejects(save(), errorCode("EDITOR_SESSION_CHANGED"));
  terminal.agentSessionId = "native-one";
  terminal.cwd = path.dirname(root);
  const afterCd = await service.read(terminal.id, "main.ts");
  assert.equal(afterCd.root, initial.root);
  assert.equal(afterCd.binding, initial.binding);
  assert.equal(afterCd.cwd, terminal.cwd);
  await service.save(terminal.id, {
    ...initial,
    expectedVersion: initial.version,
  });
  terminal.cwd = root;
  terminal.connectionState = "reconnecting";
  await assert.rejects(save(), errorCode("EDITOR_SESSION_OFFLINE"));
  terminal.connectionState = "connected";
  await assert.rejects(
    new EditorFiles(options).save(terminal.id, {
      ...initial,
      content: "overwrite",
      expectedVersion: initial.version,
    }),
    errorCode("EDITOR_SESSION_CHANGED"),
  );
  assert.equal(await fs.readFile(initial.path, "utf8"), "initial");
});

test("writes recheck native identity and disk version immediately before atomic replacement", async (t) => {
  const { root, terminal, options } = await setup(t);
  await fs.writeFile(path.join(root, "main.ts"), "initial");
  const io = localEditorTransport();
  let change = async () => {
    terminal.agentSessionId = "changed-in-flight";
  };
  const transport: EditorTransport = {
    ...io,
    replace: (filename, bytes, mode, check) =>
      io.replace(filename, bytes, mode, async () => {
        await change();
        await check();
      }),
  };
  const service = new EditorFiles({
    ...options,
    transport: async () => transport,
  });
  const initial = await service.read(terminal.id, "main.ts");
  await assert.rejects(
    service.save(terminal.id, {
      ...initial,
      content: "overwrite",
      expectedVersion: initial.version,
    }),
    errorCode("EDITOR_SESSION_CHANGED"),
  );
  terminal.agentSessionId = "native-one";
  change = async () => {
    await fs.writeFile(initial.path, "changed-on-disk");
  };
  await assert.rejects(
    service.save(terminal.id, {
      ...initial,
      content: "overwrite",
      expectedVersion: initial.version,
    }),
    errorCode("EDITOR_CONFLICT"),
  );
  assert.equal(await fs.readFile(initial.path, "utf8"), "changed-on-disk");
  assert.deepEqual(await fs.readdir(root), ["main.ts"]);
});

test("a symlinked home cannot be redirected after opening a document", async (t) => {
  const { directory, root, terminal, service, files } = await setup(t);
  await fs.writeFile(path.join(root, "main.ts"), "initial");
  const rootLink = path.join(directory, "selected");
  const other = path.join(directory, "other");
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, "main.ts"), "other");
  await fs.symlink(
    root,
    rootLink,
    process.platform === "win32" ? "junction" : "dir",
  );
  files.resolvePath = async () => rootLink;
  const initial = await service.read(terminal.id, "main.ts");
  await fs.unlink(rootLink);
  await fs.symlink(
    other,
    rootLink,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    service.save(terminal.id, {
      ...initial,
      content: "overwrite",
      expectedVersion: initial.version,
    }),
    errorCode("EDITOR_SESSION_CHANGED"),
  );
  assert.equal(await fs.readFile(path.join(other, "main.ts"), "utf8"), "other");
});

test("a revoked write lease cancels a prepared save without changing the file", async (t) => {
  const { service, root, terminal } = await setup(t);
  await fs.writeFile(path.join(root, "main.ts"), "initial");
  const initial = await service.read(terminal.id, "main.ts");
  let checks = 0;
  await assert.rejects(
    service.save(
      terminal.id,
      { ...initial, content: "overwrite", expectedVersion: initial.version },
      () => {
        if (++checks > 1)
          throw new EditorError(403, "CONTROL_REQUIRED", "lease lost");
      },
    ),
    errorCode("CONTROL_REQUIRED"),
  );
  assert.equal(checks, 2);
  assert.equal(await fs.readFile(initial.path, "utf8"), "initial");
  assert.deepEqual(await fs.readdir(root), ["main.ts"]);
});

function fakeSftp() {
  const contents = new Map<string, Buffer>([
    ["/home/account/main.ts", Buffer.from("initial")],
    ["/outside/private", Buffer.from("outside")],
  ]);
  const handles = new Map<string, string>();
  let supportsAtomic = true;
  let renames = 0;
  const stat = (filename: string) => ({
    size: contents.get(filename)?.length || 0,
    mode: 0o100640,
    isFile: () => contents.has(filename),
    isDirectory: () =>
      ["/home/account", "/home/account/project", "/outside"].includes(filename),
    isSymbolicLink: () => false,
  });
  const fake = {
    realpath(filename: string, cb: any) {
      cb(null, filename.replace("/home/account/escape", "/outside"));
    },
    stat(filename: string, cb: any) {
      cb(null, stat(filename));
    },
    readdir(_filename: string, cb: any) {
      cb(null, [{ filename: "main.ts", attrs: stat("/home/account/main.ts") }]);
    },
    createReadStream(filename: string) {
      return Readable.from([contents.get(filename)!]);
    },
    open(filename: string, flags: string, mode: number, cb: any) {
      assert.equal(flags, "wx");
      assert.equal(mode, 0o640);
      if (contents.has(filename)) return cb(new Error("already exists"));
      contents.set(filename, Buffer.alloc(0));
      handles.set(filename, filename);
      cb(null, Buffer.from(filename));
    },
    write(
      handle: Buffer,
      bytes: Buffer,
      offset: number,
      length: number,
      _position: number,
      cb: any,
    ) {
      const filename = handles.get(handle.toString())!;
      contents.set(
        filename,
        Buffer.concat([
          contents.get(filename)!,
          bytes.subarray(offset, offset + length),
        ]),
      );
      cb(null);
    },
    fchmod(_handle: Buffer, mode: number, cb: any) {
      assert.equal(mode, 0o640);
      cb(null);
    },
    close(_handle: Buffer, cb: any) {
      cb(null);
    },
    ext_openssh_rename(source: string, destination: string, cb: any) {
      if (!supportsAtomic)
        return cb(
          Object.assign(new Error("Operation unsupported"), { code: 8 }),
        );
      renames++;
      contents.set(destination, contents.get(source)!);
      contents.delete(source);
      cb(null);
    },
    unlink(filename: string, cb: any) {
      assert.match(filename, /\.harbor-edit-/);
      contents.delete(filename);
      cb(null);
    },
  };
  return {
    sftp: fake as unknown as SFTPWrapper,
    contents,
    setAtomic: (value: boolean) => {
      supportsAtomic = value;
    },
    renames: () => renames,
  };
}

test("synthetic SSH starts at account home independent of terminal cwd and saves atomically", async () => {
  const fake = fakeSftp();
  const terminal = {
    id: "ssh-terminal",
    hostId: "ssh-fixture",
    cwd: "/home/account/project",
    exited: false,
    connectionState: "connected",
  } as TerminalInfo;
  const host = {
    id: terminal.hostId,
    kind: "ssh",
    defaultCwd: "/configured-project",
  } as HostConfig;
  const files = new Files(() => undefined);
  files.resolvePath = async (requestedHost, filename, cwd) => {
    assert.equal(requestedHost.id, host.id);
    assert.equal(filename, "~");
    assert.equal(cwd, "~");
    return "/home/account";
  };
  let prepared = "";
  const service = new EditorFiles({
    files,
    host: () => host,
    terminal: () => terminal,
    prepareHost: async (id) => {
      prepared = id;
    },
    transport: async () => sshEditorTransport(fake.sftp),
  });
  const initial = await service.read(terminal.id, "main.ts");
  assert.equal(prepared, host.id);
  assert.equal(initial.root, "/home/account");
  assert.equal(initial.cwd, "/home/account/project");
  const tree = await service.list(terminal.id);
  assert.equal(tree.path, "/home/account");
  assert.equal(tree.parent, null);
  await assert.rejects(
    service.read(terminal.id, "escape/private"),
    errorCode("EDITOR_OUTSIDE_WORKSPACE"),
  );
  const saved = await service.save(terminal.id, {
    ...initial,
    content: "x".repeat(80000),
    expectedVersion: initial.version,
  });
  assert.equal(fake.renames(), 1);
  assert.equal(fake.contents.get(initial.path)?.toString(), saved.content);
  for (const encoding of ["utf-16le", "utf-16be", "cp949"] as const) {
    const filename = `/home/account/${encoding}.txt`;
    const original = iconv.encode("한글\r\n", encoding, {
      addBOM: encoding !== "cp949",
    });
    fake.contents.set(filename, original);
    const document = await service.read(
      terminal.id,
      filename,
      encoding === "cp949" ? encoding : undefined,
    );
    const same = await service.save(terminal.id, {
      ...document,
      expectedVersion: document.version,
    });
    assert.equal(same.version, document.version);
    assert.deepEqual(fake.contents.get(filename), original);
    await service.save(terminal.id, {
      ...same,
      content: "변경\r\n",
      expectedVersion: same.version,
    });
    assert.deepEqual(
      fake.contents.get(filename),
      iconv.encode("변경\r\n", encoding, { addBOM: encoding !== "cp949" }),
    );
  }
  fake.setAtomic(false);
  await assert.rejects(
    service.save(terminal.id, {
      ...saved,
      content: "unsupported",
      expectedVersion: saved.version,
    }),
    errorCode("EDITOR_ATOMIC_SAVE_UNAVAILABLE"),
  );
  assert.equal(fake.contents.get(initial.path)?.toString(), saved.content);
  assert.equal(
    [...fake.contents.keys()].some((name) => name.includes(".harbor-edit-")),
    false,
  );
});

test("editor routes enforce per-request authorization and expose conflict data without arbitrary hosts", async (t) => {
  const { root, terminal, service } = await setup(t);
  await fs.writeFile(path.join(root, "main.ts"), "initial");
  const app = express();
  let writeAllowed = false;
  app.use(
    "/editor",
    createEditorRouter(service, {
      authorize: (_request, id, write) => {
        assert.equal(id, terminal.id);
        if (write && !writeAllowed)
          throw new EditorError(403, "CONTROL_REQUIRED", "control required");
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const endpoint = `http://127.0.0.1:${address.port}/editor/${terminal.id}/file`;
  const response = await fetch(`${endpoint}?path=main.ts`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const initial = await response.json();
  const save = (extra = {}) =>
    fetch(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: initial.path,
        binding: initial.binding,
        expectedVersion: initial.version,
        content: "new",
        ...extra,
      }),
    });
  assert.equal((await save()).status, 403);
  writeAllowed = true;
  assert.equal((await save({ hostId: "other" })).status, 400);
  assert.equal(
    (await fetch(`${endpoint}?path=main.ts&hostId=other`)).status,
    400,
  );
  await fs.writeFile(initial.path, "external");
  const conflict = await save();
  assert.equal(conflict.status, 409);
  const body = await conflict.json();
  assert.equal(body.current.content, "external");
  assert.equal(body.code, "EDITOR_CONFLICT");
  await fs.writeFile(
    path.join(root, "legacy.txt"),
    iconv.encode("한글", "cp949"),
  );
  const undecoded = await fetch(`${endpoint}?path=legacy.txt`);
  assert.equal(undecoded.status, 415);
  assert.deepEqual((await undecoded.json()).details.encodings, ["cp949"]);
  assert.equal(
    (await fetch(`${endpoint}?path=legacy.txt&encoding=guessed`)).status,
    400,
  );
  assert.equal(
    (await fetch(`${endpoint}?path=legacy.txt&encoding=cp949&encoding=utf-8`))
      .status,
    400,
  );
  const reopened = await fetch(`${endpoint}?path=legacy.txt&encoding=cp949`);
  assert.equal(reopened.status, 200);
  const legacy = await reopened.json();
  assert.equal(legacy.encoding, "cp949");
  assert.equal(legacy.bom, false);
  const encodedSave = await save({
    path: legacy.path,
    expectedVersion: legacy.version,
    binding: legacy.binding,
    encoding: legacy.encoding,
    content: "수정",
  });
  assert.equal(encodedSave.status, 200);
  assert.deepEqual(
    await fs.readFile(legacy.path),
    iconv.encode("수정", "cp949"),
  );
});
