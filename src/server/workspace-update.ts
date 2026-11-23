import { readFileSync, realpathSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** A detached simulator can still belong to systemd's service cgroup after its
 * original terminal has exited. Restart the unit only when no other task remains. */
export function workspaceCanSwitch(
  link: string,
  cwd = process.cwd(),
  cgroups = "/sys/fs/cgroup",
  membership = "/proc/self/cgroup",
  pid = process.pid,
) {
  try {
    const next = realpathSync(link);
    if (
      next === realpathSync(cwd) ||
      !existsSync(join(next, ".harbor-release"))
    )
      return false;
    const line = readFileSync(membership, "utf8")
      .split("\n")
      .find((s) => s.startsWith("0::/"));
    if (!line || !line.endsWith("/harbor-workspace.service")) return false;
    const group = resolve(cgroups, "." + line.slice(3));
    if (!group.startsWith(resolve(cgroups) + sep)) return false;
    if (
      readdirSync(group, { withFileTypes: true }).some((d) => d.isDirectory())
    )
      return false;
    const pids = readFileSync(join(group, "cgroup.procs"), "utf8")
      .trim()
      .split(/\s+/);
    return pids.length === 1 && pids[0] === String(pid);
  } catch {
    return false;
  }
}
