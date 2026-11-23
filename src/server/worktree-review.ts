import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { HostConfig } from "../shared/types.js";
import { shellQuote } from "./ssh.js";

const exec = promisify(execFile);
type Remote = (host: HostConfig, command: string) => Promise<string>;
function gitRunner(host: HostConfig, remote: Remote) {
  return async (dir: string, args: string[], index?: string) => {
    const argv = [
      "--no-pager",
      "--no-optional-locks",
      "--literal-pathspecs",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.interactive=never",
      "-C",
      dir,
      ...args,
    ];
    if (host.kind === "ssh")
      return remote(
        host,
        [
          "GIT_TERMINAL_PROMPT=0",
          ...(index ? ["GIT_INDEX_FILE=" + shellQuote(index)] : []),
          "git",
          ...argv.map(shellQuote),
        ].join(" "),
      );
    return (
      await exec("git", argv, {
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          ...(index ? { GIT_INDEX_FILE: index } : {}),
        },
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout;
  };
}
export async function reviewWorktree(
  host: HostConfig,
  cwd: string,
  file: string | undefined,
  remote: (host: HostConfig, command: string) => Promise<string>,
) {
  const git = gitRunner(host, remote);
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trimEnd();
  const status = await git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--no-renames",
    "--untracked-files=normal",
  ]);
  const files = status
    .split("\0")
    .filter(Boolean)
    .map((line) => ({ path: line.slice(3), status: line.slice(0, 2) }));
  if (!file) return { root, files };
  const found = files.find((f) => f.path === file);
  if (!found) throw Error("파일 상태가 바뀌었습니다. 목록을 다시 확인하세요.");
  if (found.status === "??")
    return { root, files, notice: "새 파일 · Git 비교 기준이 없습니다." };
  const args = [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
  ];
  const [staged, working] = await Promise.all([
    git(root, [...args, "--cached", "--", file]),
    git(root, [...args, "--", file]),
  ]);
  return { root, files, staged, working };
}

export const worktreeAction = z
  .object({
    operation: z.enum(["commit", "push", "restore"]),
    file: z.string().min(1).max(4096).optional(),
    message: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .regex(/^[^\u0000-\u001f\u007f]+$/)
      .optional(),
    runtimeId: z.string().min(1).max(180),
    confirm: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict()
  .refine(
    (i) =>
      (i.operation === "commit") === !!i.message &&
      (i.operation === "restore") === !!i.file,
    "작업에 필요한 파일·커밋 메시지를 확인하세요.",
  );
export type GitAction = z.infer<typeof worktreeAction>;
const changes = [
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
];
const stale = () =>
  Object.assign(
    Error("미리보기 이후 파일·브랜치 상태가 달라졌습니다. 다시 확인하세요."),
    { status: 409 },
  );
const pending = new Set<string>();
export async function performWorktree(
  host: HostConfig,
  cwd: string,
  action: GitAction,
  remote: Remote,
  guard: () => void | Promise<void>,
) {
  action = worktreeAction.parse(action);
  const git = gitRunner(host, remote);
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trimEnd();
  const lock = JSON.stringify([host.id, root]);
  if (pending.has(lock))
    throw Object.assign(Error("이 저장소의 Git 작업이 진행 중입니다."), {
      status: 409,
    });
  if (action.confirm) pending.add(lock);
  try {
    const branch = (
      await git(root, ["symbolic-ref", "--short", "HEAD"])
    ).trimEnd();
    const branchRef = "refs/heads/" + branch;
    const head = (
      await git(root, ["for-each-ref", "--format=%(objectname)", branchRef])
    ).trim();
    const state = [
      host.id,
      root,
      branch,
      head,
      action.operation,
      action.message || "",
      action.file || "",
    ];
    const run = (args: string[]) => git(root, args);
    let detail = "",
      target = "";
    let execute: () => Promise<void>;
    if (action.operation === "commit") {
      const message = action.message!;
      const tree = (await run(["write-tree"])).trim();
      detail = await run([...changes, "--cached"]);
      if (!detail) throw Error("스테이징한 변경이 없습니다.");
      state.push(tree, detail);
      target = branch;
      execute = async () => {
        // Pin the exact reviewed tree in a private index while normal Git commit
        // runs hooks, identity, signing and reflog handling. Other staging is retained.
        const dir =
          host.kind === "local"
            ? await mkdtemp(join(tmpdir(), "harbor-git-index-"))
            : (
                await remote(
                  host,
                  "umask 077 && mktemp -d /tmp/harbor-git-index-XXXXXXXXXX",
                )
              ).trim();
        if (
          host.kind === "ssh" &&
          !/^\/tmp\/harbor-git-index-[A-Za-z0-9]+$/.test(dir)
        )
          throw Error("커밋 임시 폴더 생성 실패");
        const index =
          dir +
          (host.kind === "local" && process.platform === "win32" ? "\\" : "/") +
          "index";
        try {
          await git(root, ["read-tree", tree], index);
          if (
            (await run(["write-tree"])).trim() !== tree ||
            (await run(["symbolic-ref", "--short", "HEAD"])).trimEnd() !==
              branch ||
            (
              await run(["for-each-ref", "--format=%(objectname)", branchRef])
            ).trim() !== head
          )
            throw stale();
          await guard();
          await git(root, ["commit", "-m", message], index);
        } finally {
          if (host.kind === "local")
            await rm(dir, { recursive: true, force: true }).catch(() => {});
          else
            await remote(
              host,
              "rm -f " +
                shellQuote(index) +
                " " +
                shellQuote(index + ".lock") +
                "; rmdir " +
                shellQuote(dir),
            ).catch(() => {});
        }
      };
    } else if (action.operation === "push") {
      if (!head) throw Error("푸시할 커밋이 없습니다.");
      const tracking = (
        await run([
          "for-each-ref",
          "--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)",
          branchRef,
        ])
      )
        .trimEnd()
        .split("\0");
      const remoteName = tracking[0] || "origin",
        ref = tracking[1] || branchRef;
      if (
        !/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(remoteName) ||
        remoteName === "." ||
        !ref.startsWith("refs/heads/")
      )
        throw Error("푸시할 원격 브랜치를 확인하세요.");
      const urls = (
        await run(["remote", "get-url", "--push", "--all", remoteName])
      )
        .trimEnd()
        .split(/\r?\n/);
      if (urls.length !== 1)
        throw Error("푸시 주소가 한 개인 원격 저장소를 선택하세요.");
      target = remoteName + "/" + ref.slice("refs/heads/".length);
      detail = await run([
        "log",
        "--format=%h %s",
        "-20",
        tracking[2] ? tracking[2] + ".." + head : head,
      ]);
      if (!detail) detail = "현재 커밋 " + head;
      state.push(remoteName, ref, urls[0], detail);
      execute = async () => {
        await guard();
        await run([
          "-c",
          "push.followTags=false",
          "-c",
          "remote." + remoteName + ".mirror=false",
          "push",
          "--no-recurse-submodules",
          "--porcelain",
          remoteName,
          head + ":" + ref,
        ]);
      };
    } else {
      const file = action.file!;
      const rows = (await run(["ls-files", "--stage", "-z", "--", file]))
        .split("\0")
        .filter(Boolean);
      if (
        rows.length !== 1 ||
        !/^100(644|755) [a-f0-9]+ 0\t/.test(rows[0]) ||
        rows[0].slice(rows[0].indexOf("\t") + 1) !== file
      )
        throw Error("일반 추적 파일 하나만 복원할 수 있습니다.");
      const tree = (await run(["write-tree"])).trim();
      detail = await run([...changes, "--", file]);
      if (!detail) throw Error("복원할 작업 폴더 변경이 없습니다.");
      const status = (
        await run([
          "status",
          "--porcelain=v1",
          "-z",
          "--no-renames",
          "--",
          file,
        ])
      ).slice(0, 2);
      if (status[1] !== "M" && status[1] !== "D")
        throw Error("수정되었거나 삭제된 일반 파일만 복원할 수 있습니다.");
      const bytes =
        status[1] === "D"
          ? "deleted"
          : (await run(["hash-object", "--no-filters", "--", file])).trim();
      // --binary is part of the fingerprint, even if the human-readable diff
      // for two different binary modifications has identical text.
      const binary = await run([...changes, "--binary", "--", file]);
      state.push(tree, rows[0], status, bytes, binary);
      target = file;
      execute = async () => {
        await guard();
        await run(["restore", "--source=" + tree, "--worktree", "--", file]);
      };
    }
    const confirmation = createHash("sha256")
      .update(JSON.stringify(state))
      .digest("hex");
    if (!action.confirm)
      return {
        root,
        branch,
        target,
        detail: detail.slice(0, 100000),
        truncated: detail.length > 100000,
        confirmation,
      };
    if (confirmation !== action.confirm) throw stale();
    await execute();
    return { ok: true };
  } catch (error) {
    if (error instanceof Error) {
      error.message = error.message
        .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1")
        .slice(0, 4000);
    }
    throw error;
  } finally {
    if (action.confirm) pending.delete(lock);
  }
}
