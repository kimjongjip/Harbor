import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { Files } from "./files.js";
import { shellQuote } from "./ssh.js";
import type { HostConfig } from "../shared/types.js";

export interface ApprovalTarget {
  file: string;
  action: "read" | "create" | "edit";
}
const targets = new WeakMap<object, ApprovalTarget[]>();
export const pendingTargets = (event: object) => targets.get(event);
export function attachTargets(
  event: object,
  value: ApprovalTarget[] | undefined,
) {
  if (value?.length && value.length <= 12) targets.set(event, value);
}
const file = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 4096 &&
  !/[\x00-\x1f\x7f]/.test(v);
// Allow ordinary relative patterns such as src/**/*.ts and *.{js,ts}.
// Keep negations, drive paths, escapes, extglobs and ambiguous alternation manual.
function relativeGlob(value: unknown) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    value.includes("..")
  )
    return false;
  return value.split("/").every((part) => {
    const plain = part.replace(
      /\.\{[\p{L}\p{N}_-]+(?:,[\p{L}\p{N}_-]+)+\}$/u,
      ".ext",
    );
    return (
      !!plain && !plain.startsWith(".") && /^[\p{L}\p{N}_*? .-]+$/u.test(plain)
    );
  });
}
export function claudeApprovalTargets(
  method: string,
  input: Record<string, unknown>,
): ApprovalTarget[] | undefined {
  const allowed: Record<string, string[]> = {
    Read: ["file_path", "offset", "limit", "pages"],
    Glob: ["path", "pattern"],
    Grep: [
      "path",
      "pattern",
      "glob",
      "type",
      "output_mode",
      "-B",
      "-A",
      "-C",
      "context",
      "-n",
      "-i",
      "multiline",
      "head_limit",
      "offset",
    ],
    Edit: ["file_path", "old_string", "new_string", "replace_all"],
    Write: ["file_path", "content"],
  };
  if (
    !Object.hasOwn(allowed, method) ||
    !input ||
    typeof input !== "object" ||
    Object.keys(input).some((key) => !allowed[method].includes(key))
  )
    return;
  if (method === "Read" && file(input.file_path))
    return [{ action: "read", file: input.file_path }];
  if (method === "Glob" && file(input.path) && relativeGlob(input.pattern))
    return [{ action: "read", file: input.path }];
  if (
    method === "Grep" &&
    file(input.path) &&
    typeof input.pattern === "string" &&
    input.pattern.length > 0 &&
    input.pattern.length <= 8192 &&
    (input.glob === undefined || relativeGlob(input.glob)) &&
    (input.type === undefined ||
      (typeof input.type === "string" &&
        /^[a-zA-Z0-9_+-]{1,48}$/.test(input.type)))
  )
    return [{ action: "read", file: input.path }];
  if (
    method === "Write" &&
    file(input.file_path) &&
    typeof input.content === "string" &&
    input.content.length <= 65536
  )
    return [{ action: "create", file: input.file_path }];
  if (
    method === "Edit" &&
    file(input.file_path) &&
    typeof input.old_string === "string" &&
    input.old_string.trim() &&
    typeof input.new_string === "string" &&
    input.new_string.trim() &&
    !input.replace_all &&
    input.old_string.length + input.new_string.length <= 65536
  )
    return [{ action: "edit", file: input.file_path }];
}
export function codexChanges(changes: unknown): ApprovalTarget[] | undefined {
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > 12)
    return;
  const result: ApprovalTarget[] = [];
  let total = 0;
  for (const change of changes) {
    if (
      !file(change?.path) ||
      !change.kind ||
      typeof change.kind !== "object" ||
      Object.keys(change).some(
        (key) => !["path", "kind", "diff"].includes(key),
      ) ||
      Object.keys(change.kind).some(
        (key) => !["type", "movePath", "move_path"].includes(key),
      ) ||
      typeof change.diff !== "string" ||
      change.diff.includes("\0") ||
      /^(?:old mode|new mode|new file mode 1(?:20|60)|deleted file mode|rename (?:from|to)|copy (?:from|to)|GIT binary patch|Binary files\s)/m.test(
        change.diff,
      ) ||
      change.kind.movePath ||
      change.kind.move_path ||
      change.movePath ||
      change.move_path
    )
      return;
    total += change.diff.length;
    if (total > 65536) return;
    if (change.kind.type === "add") {
      result.push({ action: "create", file: change.path });
      continue;
    }
    if (change.kind.type !== "update" || !/^\+(?!\+\+).+$/m.test(change.diff))
      return;
    result.push({ action: "edit", file: change.path });
  }
  return result;
}
export async function safeApprovalTargets(
  host: HostConfig,
  cwd: string,
  candidates: ApprovalTarget[],
  files: Files,
): Promise<boolean> {
  if (!candidates.length || candidates.length > 12) return false;
  const paths = host.kind === "ssh" ? path.posix : path;
  if (!paths.isAbsolute(cwd) || paths.parse(cwd).root === paths.resolve(cwd))
    return false;
  try {
    const sftp = host.kind === "ssh" ? await files.editorSftp(host) : undefined;
    const canonical = (f: string) =>
      sftp
        ? new Promise<string>((ok, no) =>
            sftp.realpath(f, (e, r) => (e ? no(e) : ok(r))),
          )
        : realpath(f);
    const info = (f: string) =>
      sftp
        ? new Promise<import("ssh2").Stats>((ok, no) =>
            sftp.lstat(f, (e, r) => (e ? no(e) : ok(r))),
          )
        : lstat(f);
    const root = await canonical(cwd);
    if (paths.parse(root).root === root) return false;
    for (const t of candidates) {
      if (!["read", "create", "edit"].includes(t.action)) return false;
      if (
        !file(t.file) ||
        t.file.startsWith("\\\\") ||
        t.file.split(/[\\/]/).includes("..")
      )
        return false;
      const relative = paths.relative(cwd, paths.resolve(cwd, t.file));
      if (
        paths.isAbsolute(relative) ||
        relative.split(/[\\/]/).some((p) => p.startsWith(".")) ||
        relative.includes(":") ||
        (!relative && t.action !== "read")
      )
        return false;
      const target = paths.join(root, relative);
      const parent = relative ? paths.dirname(target) : root;
      if (paths.relative(parent, await canonical(parent))) return false;
      try {
        const stat = await info(target);
        if (
          stat.isSymbolicLink() ||
          t.action === "create" ||
          paths.relative(target, await canonical(target))
        )
          return false;
        if (t.action === "read") {
          if (!stat.isDirectory() && !stat.isFile()) return false;
          continue;
        }
        if (!stat.isFile()) return false;
        if (sftp) {
          if (
            (
              await files.researchCommand(
                host,
                "stat -c %h -- " + shellQuote(target),
              )
            ).trim() !== "1"
          )
            return false;
        } else if (!("nlink" in stat) || stat.nlink !== 1) return false;
      } catch (error) {
        if (
          t.action !== "create" ||
          !["ENOENT", "2"].includes(
            String((error as NodeJS.ErrnoException).code),
          )
        )
          return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
