import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { homedir } from "node:os";
import { Files } from "./files.js";
import type { HostConfig } from "../shared/types.js";

function remote(home = "/home/fixture") {
  const files = new Files(() => undefined);
  const requests: string[] = [];
  Object.defineProperty(files, "sftp", {
    value: async () => ({
      realpath(value: string, cb: (error: null, result: string) => void) {
        requests.push(value);
        cb(null, home);
      },
    }),
  });
  const host = { id: "fixture", kind: "ssh", defaultCwd: "~" } as HostConfig;
  return { files, host, requests };
}

test("SSH relative paths expand home cwd without using local process cwd", async () => {
  const { files, host, requests } = remote();
  assert.equal(
    await files.resolvePath(host, "docs/guide.md", "~"),
    "/home/fixture/docs/guide.md",
  );
  assert.equal(
    await files.resolvePath(host, "../guide.md", "~/project/docs"),
    "/home/fixture/project/guide.md",
  );
  assert.equal(
    await files.resolvePath(host, "./docs/한글 문서.md", ""),
    "/home/fixture/docs/한글 문서.md",
  );
  assert.equal(
    await files.resolvePath(host, "guide.md", "project"),
    "/home/fixture/project/guide.md",
  );
  assert.ok(requests.every((value) => value === "."));
});

test("SSH absolute paths and absolute cwd do not require home lookup", async () => {
  const { files, host, requests } = remote();
  assert.equal(
    await files.resolvePath(host, "/srv/docs/guide.md", "~"),
    "/srv/docs/guide.md",
  );
  assert.equal(
    await files.resolvePath(host, "../guide.md", "/srv/project/docs"),
    "/srv/project/guide.md",
  );
  assert.deepEqual(requests, []);
  assert.equal(
    await files.resolvePath(host, "~/docs/guide.md", "/srv/project"),
    "/home/fixture/docs/guide.md",
  );
  assert.equal(
    await files.resolvePath(host, "~", "/srv/project"),
    "/home/fixture",
  );
});

test("invalid remote home and control characters cannot become resolved paths", async () => {
  const { files, host } = remote("relative-home");
  await assert.rejects(files.resolvePath(host, "docs/guide.md", "~"));
  await assert.rejects(files.resolvePath(host, "bad\0.md", "/srv"));
  await assert.rejects(files.resolvePath(host, "guide.md", "/srv\nother"));
});

test("local absolute, relative and home paths use platform path semantics", async () => {
  const files = new Files(() => undefined);
  const host = { id: "local", kind: "local", defaultCwd: "~" } as HostConfig;
  const cwd = path.join(homedir(), "project", "docs");
  assert.equal(
    await files.resolvePath(host, "../guide.md", cwd),
    path.join(homedir(), "project", "guide.md"),
  );
  assert.equal(
    await files.resolvePath(host, "guide.md", "~/project"),
    path.join(homedir(), "project", "guide.md"),
  );
  assert.equal(
    await files.resolvePath(host, "~/guide.md", cwd),
    path.join(homedir(), "guide.md"),
  );
  assert.equal(
    await files.resolvePath(host, "guide.md", ""),
    path.join(homedir(), "guide.md"),
  );
  assert.equal(await files.resolvePath(host, cwd, "~"), cwd);
});
