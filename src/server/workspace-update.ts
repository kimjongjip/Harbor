import { readFileSync, realpathSync, readdirSync, existsSync, readlinkSync } from "node:fs";
import { join, resolve, sep, basename } from "node:path";

/** A detached simulator can still belong to systemd's service cgroup after its
 * original terminal has exited. Restart the unit only when no other task remains. */
export function workspaceCanSwitch(
  link: string,
  idleRpc: readonly number[] = [],
  {
    cwd = process.cwd(),
    cgroups = "/sys/fs/cgroup",
    membership = "/proc/self/cgroup",
    pid = process.pid,
    proc = "/proc",
  } = {},
) {
  try {
    const next = realpathSync(link);
    if (
      next === realpathSync(cwd) ||
      !existsSync(join(next, ".harbor-release"))
    )
      return false;
    const groups = readFileSync(membership, "utf8").split("\n");
    const unified = groups.find(
      (s) => s.startsWith("0::/") && s.endsWith("/harbor-workspace.service"),
    );
    const line = unified ?? groups.find((s) => /^\d+:name=systemd:\//.test(s));
    if (!line || !line.endsWith("/harbor-workspace.service")) return false;
    const mount = unified ? cgroups : join(cgroups, "systemd");
    const group = resolve(mount, "." + line.split(":").slice(2).join(":"));
    if (!group.startsWith(resolve(mount) + sep)) return false;
    if (
      readdirSync(group, { withFileTypes: true }).some((d) => d.isDirectory())
    )
      return false;
    const pids = readFileSync(join(group, "cgroup.procs"), "utf8")
      .trim()
      .split(/\s+/)
      .map(Number);
    if (!pids.includes(pid)) return false;
    return pids.every((p) => {
      if (p === pid || idleRpc.includes(p)) return true;
      // npm's Codex launcher stays as the direct parent of the actual binary.
      // An arbitrary descendant (including an idle-looking research process) still vetoes.
      if (!idleRpc.length || !Number.isSafeInteger(p) || p <= 0) return false;
      const directory = join(proc, String(p));
      const status = readFileSync(join(directory, "status"), "utf8");
      const parent = Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1]);
      if (!idleRpc.includes(parent) || !pids.includes(parent)) return false;
      if (basename(readlinkSync(join(directory, "exe"))) !== "codex")
        return false;
      const args = readFileSync(join(directory, "cmdline"), "utf8")
        .split("\0")
        .slice(1)
        .join("\0");
      return (
        args === "app-server\0--listen\0stdio://\0" ||
        args === "app-server\0proxy\0"
      );
    });
  } catch {
    return false;
  }
}
