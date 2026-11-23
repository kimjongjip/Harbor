import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostConfig } from "../shared/types";
import {
  performWorktree,
  reviewWorktree,
  type GitAction,
} from "./worktree-review";
import { relayChatRequest } from "./workspace-chat";

test("preview-confirm Git writes commit only staged content, restore one tracked file and push reviewed HEAD", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "harbor-git-review-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 4 }));
  const dir = join(base, "work"),
    bare = join(base, "remote.git");
  await mkdir(dir);
  const git = (args: string[], cwd = dir) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    }).trimEnd();
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "fixture@example.com"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["config", "core.autocrlf", "false"]);
  git(["init", "--bare", "-q", bare]);
  git(["remote", "add", "origin", bare]);
  const path = join(dir, "file.txt"),
    host = { id: "local", kind: "local" } as HostConfig;
  const remote = async () => {
    throw Error("unexpected SSH");
  };
  let permitted = true;
  const guard = () => {
    if (!permitted) throw Error("permission revoked");
  };
  const act = (opts: Omit<GitAction, "runtimeId">) =>
    performWorktree(
      host,
      dir,
      { ...opts, runtimeId: "fixture" },
      remote,
      guard,
    );
  const preview = async (opts: Omit<GitAction, "runtimeId">) => {
    const r = await act(opts);
    assert.ok(r.confirmation);
    return r.confirmation;
  };
  await writeFile(path, "staged\n");
  git(["add", "file.txt"]);
  await writeFile(path, "work after staging\n");
  const commit = { operation: "commit", message: "fixture commit" } as const;
  const preview1 = await preview(commit);
  await writeFile(join(dir, "additional.txt"), "more\n");
  git(["add", "additional.txt"]);
  await assert.rejects(() => act({ ...commit, confirm: preview1 }), /미리보기/);
  const preview2 = await preview(commit);
  permitted = false;
  await assert.rejects(
    () => act({ ...commit, confirm: preview2 }),
    /permission revoked/,
  );
  permitted = true;
  assert.ok((await act({ ...commit, confirm: preview2 })).ok);
  assert.equal(git(["show", "HEAD:file.txt"]), "staged");
  assert.equal(await readFile(path, "utf8"), "work after staging\n");
  const restore = { operation: "restore", file: "file.txt" } as const;
  const restoreToken = await preview(restore);
  await writeFile(path, "new edit\n");
  await assert.rejects(
    () => act({ ...restore, confirm: restoreToken }),
    /미리보기/,
  );
  assert.equal(await readFile(path, "utf8"), "new edit\n");
  await act({ ...restore, confirm: await preview(restore) });
  assert.equal(await readFile(path, "utf8"), "staged\n");
  await writeFile(join(dir, "unknown.txt"), "mine");
  await assert.rejects(
    () => act({ operation: "restore", file: "unknown.txt" }),
    /추적 파일/,
  );
  const push = { operation: "push" } as const;
  await act({ ...push, confirm: await preview(push) });
  assert.equal(
    git(["rev-parse", "refs/heads/main"], bare),
    git(["rev-parse", "HEAD"]),
  );
  assert.equal(
    (await reviewWorktree(host, dir, undefined, remote)).files.length,
    1,
  );
  const behind = await preview(push),
    other = join(base, "other");
  git(["clone", "-q", "--branch", "main", bare, other]);
  git(
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "remote-only",
    ],
    other,
  );
  git(["push", "-q", "origin", "HEAD:main"], other);
  await assert.rejects(() => act({ ...push, confirm: behind }));
  assert.equal(
    git(["rev-parse", "refs/heads/main"], bare),
    git(["rev-parse", "HEAD"], other),
  );
});

test("remote Git requests relay only the conversation path and selected file", () => {
  const id = "aaaabbbb-0000-0000-0000-000000001234",
    path = "/conversations/" + id + "/worktree";
  const view = relayChatRequest("host", {
    method: "GET",
    path,
    query: { file: "dir/name +x" },
    body: undefined,
  });
  assert.equal(view.path, path + "?file=dir%2Fname+%2Bx");
  const body = { operation: "push", runtimeId: "r" };
  assert.deepEqual(
    relayChatRequest("host", { method: "POST", path, query: {}, body }),
    { path, body },
  );
});
