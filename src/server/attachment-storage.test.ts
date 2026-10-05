import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { Files } from "./files.js";
import { resolveTerminalUploadTarget } from "../client/terminalClipboard.js";
import type { HostConfig } from "../shared/types.js";

test("attachments use CODEX_HOME/session directories while explorer uploads keep their explicit target", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "harbor-attachments-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(directory, "custom codex home");
  const project = path.join(directory, "project");
  await mkdir(project);
  const host = {
    id: "local",
    kind: "local",
    defaultCwd: project,
  } as HostConfig;
  const files = new Files(() => undefined);
  try {
    const id = randomUUID(),
      secondId = randomUUID();
    const folder = await files.prepareAttachments(host, id);
    assert.equal(
      folder,
      path.join(process.env.CODEX_HOME, "harbor", "attachments", id),
    );
    assert.equal(await files.prepareAttachments(host, id), folder);
    assert.notEqual(await files.prepareAttachments(host, secondId), folder);
    const first = await files.upload(
      host,
      folder,
      "capture.png",
      Readable.from(["synthetic"]),
      0o600,
    );
    assert.equal(await readFile(first.path, "utf8"), "synthetic");
    await assert.rejects(
      files.upload(
        host,
        folder,
        "capture.png",
        Readable.from(["replacement"]),
        0o600,
      ),
    );
    assert.equal(await readFile(first.path, "utf8"), "synthetic");
    assert.deepEqual(await readdir(project), []);
    const deliberate = await files.upload(
      host,
      project,
      "chosen.txt",
      Readable.from(["chosen"]),
    );
    assert.equal(deliberate.path, path.join(project, "chosen.txt"));
    await assert.rejects(files.prepareAttachments(host, "../../escape"));
    process.env.CODEX_HOME = path.join(directory, "symlink case");
    await mkdir(process.env.CODEX_HOME);
    await symlink(
      project,
      path.join(process.env.CODEX_HOME, "harbor"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      files.prepareAttachments(host, randomUUID()),
      /일반 폴더/,
    );
    assert.deepEqual(await readdir(project), ["chosen.txt"]);
  } finally {
    files.shutdown();
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    assert.ok(
      path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy HTML404 prepare falls back to hidden attachment folders through existing file APIs", async (t) => {
  const terminalId = randomUUID();
  const directories = new Set(["/home/fixture"]),
    created: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string, init?: RequestInit) => {
      const url = new URL(String(input), "http://fixture");
      if (url.pathname.endsWith("/attachments/prepare"))
        return new Response("<html>Not found</html>", { status: 404 });
      if (url.pathname.endsWith("/preview"))
        return Response.json({ kind: "directory", path: "/home/fixture" });
      if (url.pathname.endsWith("/mkdir")) {
        const body = JSON.parse(String(init?.body));
        const destination = `${body.path}/${body.name}`;
        directories.add(destination);
        created.push(destination);
        return Response.json({ path: destination });
      }
      const dir = url.searchParams.get("path")!;
      return Response.json({
        path: dir,
        entries: [...directories]
          .filter((value) => path.posix.dirname(value) === dir)
          .map((value) => ({
            name: path.posix.basename(value),
            kind: "directory",
          })),
      });
    },
  );
  const target = await resolveTerminalUploadTarget(
    { terminalId, hostId: "fixture", cwd: "/project" },
    new AbortController().signal,
  );
  assert.equal(
    target.cwd,
    `/home/fixture/.codex/harbor/attachments/${terminalId}`,
  );
  assert.equal(target.attachmentUploadUrl, undefined);
  assert.equal(created.length, 4);
  assert.ok(!created.some((value) => value.startsWith("/project")));
});

test("modern attachment routing uses the prepared host path and never falls back on authentication errors", async (t) => {
  const terminalId = randomUUID();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({
      path: `/custom/codex/harbor/attachments/${terminalId}`,
      hostId: "fixture",
    });
  });
  const target = await resolveTerminalUploadTarget(
    { terminalId, hostId: "fixture", cwd: "/project" },
    new AbortController().signal,
  );
  assert.equal(
    target.attachmentUploadUrl,
    `/api/terminals/${terminalId}/attachments`,
  );
  assert.equal(calls, 1);
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ error: "denied" }, { status: 403 });
  });
  await assert.rejects(
    resolveTerminalUploadTarget(
      { terminalId, hostId: "fixture", cwd: "/project" },
      new AbortController().signal,
    ),
    /denied/,
  );
  assert.equal(calls, 2);
});
