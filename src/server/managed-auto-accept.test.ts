import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, link, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HostConfig } from "../shared/types";
import type { Files } from "./files";
import {
  claudeApprovalTargets,
  codexChanges,
  safeApprovalTargets,
} from "./managed-auto-accept";

test("managed auto acceptance rejects shell, permissions, questions, destructive or unidentified modifications", () => {
  for (const tool of [
    "Bash",
    "WebFetch",
    "AskUserQuestion",
    "ExitPlanMode",
    "mcp__x__Read",
    "WriteOther",
  ])
    assert.equal(
      claudeApprovalTargets(tool, { file_path: "a", content: "data" }),
      undefined,
    );
  assert.equal(
    claudeApprovalTargets("Read", { file_path: "a", permissions: {} }),
    undefined,
  );
  assert.equal(
    claudeApprovalTargets("Edit", {
      file_path: "a",
      old_string: "old",
      new_string: "",
    }),
    undefined,
  );
  assert.equal(
    claudeApprovalTargets("Edit", {
      file_path: "a",
      old_string: "old",
      new_string: "new",
      replace_all: true,
    }),
    undefined,
  );
  assert.deepEqual(
    claudeApprovalTargets("Write", { file_path: "a", content: "new" }),
    [{ file: "a", action: "create" }],
  );
  for (const change of [
    { type: "delete" },
    { type: "update", movePath: "other" },
  ])
    assert.equal(
      codexChanges([{ path: "a", kind: change, diff: "+normal" }]),
      undefined,
    );
  assert.equal(
    codexChanges([{ path: "a", kind: { type: "update" }, diff: "-removed" }]),
    undefined,
  );
});
test("glob and grep patterns stay relative, explicit, and free of hidden path or platform escapes", () => {
  for (const pattern of [
    "../outside/*.ts",
    "sub/../../file",
    "C:/Windows/*",
    "/etc/*",
    "\\\\host\\share\\*",
    "dir\\..\\file",
    ".git/config",
    "a/.env",
    "{src,../other}/*",
    "*.{js,.env}",
    "**/.*",
  ]) {
    assert.equal(
      claudeApprovalTargets("Glob", { path: "/fixture", pattern }),
      undefined,
      pattern,
    );
    assert.equal(
      claudeApprovalTargets("Grep", {
        path: "/fixture",
        pattern: "find",
        glob: pattern,
      }),
      undefined,
      pattern,
    );
  }
  for (const pattern of ["*.ts", "src/**/*.tsx", "docs/*.{md,txt}"]) {
    assert.ok(claudeApprovalTargets("Glob", { path: "/fixture", pattern }));
    assert.ok(
      claudeApprovalTargets("Grep", {
        path: "/fixture",
        pattern: "search",
        glob: pattern,
      }),
    );
  }
  assert.equal(claudeApprovalTargets("Glob", { pattern: "*.ts" }), undefined);
  const add = (diff: unknown) =>
    codexChanges([{ kind: { type: "add" }, path: "note.txt", diff }]);
  assert.ok(add("content"));
  assert.equal(add(undefined), undefined);
  assert.equal(add("x".repeat(65537)), undefined);
  assert.equal(add("GIT binary patch"), undefined);
  assert.equal(
    codexChanges([
      { kind: { type: "update" }, path: "a", diff: "+more", permissions: {} },
    ]),
    undefined,
  );
});
test("workspace checks reject links, hardlinks, hidden/system paths, deleted files and overwrites", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "harbor-managed-approval-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = join(dir, "project"),
    outside = join(dir, "other");
  await mkdir(cwd);
  await mkdir(outside);
  await writeFile(join(cwd, "ok.ts"), "before");
  await writeFile(join(outside, "private.ts"), "private");
  await symlink(
    outside,
    join(cwd, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await link(join(outside, "private.ts"), join(cwd, "hard.ts"));
  const host = { id: "fixture", kind: "local" } as HostConfig,
    files = {} as Files;
  const eligible = (file: string, action: "create" | "edit" | "read") =>
    safeApprovalTargets(host, cwd, [{ action, file }], files);
  assert.ok(await eligible("ok.ts", "edit"));
  assert.ok(await eligible("new.ts", "create"));
  for (const file of [
    join(outside, "private.ts"),
    "escape/private.ts",
    "../other/private.ts",
    ".git/config",
    "hard.ts",
    "missing.ts",
  ])
    assert.equal(await eligible(file, "edit"), false, file);
  assert.equal(await eligible("ok.ts", "create"), false);
  assert.equal(await eligible("escape/new.ts", "create"), false);
});
test("remote validation uses the selected SFTP connection, including native link-count check", async () => {
  const seen: string[] = [];
  const host = { id: "ssh-fixture", kind: "ssh" } as HostConfig;
  const files = {
    editorSftp: async (h: HostConfig) => {
      seen.push(h.id);
      return {
        realpath: (p: string, cb: Function) => cb(null, p),
        lstat: (_p: string, cb: Function) =>
          cb(null, {
            isDirectory: () => false,
            isFile: () => true,
            isSymbolicLink: () => false,
          }),
      };
    },
    researchCommand: async (h: HostConfig) => {
      seen.push(h.id);
      return "2\n";
    },
  } as unknown as Files;
  assert.equal(
    await safeApprovalTargets(
      host,
      "/fixture",
      [{ action: "edit", file: "a" }],
      files,
    ),
    false,
  );
  assert.deepEqual(seen, ["ssh-fixture", "ssh-fixture"]);
});
