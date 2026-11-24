import {
  readFileSync,
  realpathSync,
  readdirSync,
  existsSync,
  readlinkSync,
} from "node:fs";
import { join, resolve, sep, basename, dirname } from "node:path";

export function selectedWorkspaceRelease(
  link: string,
  version: string,
  cwd = process.cwd(),
) {
  try {
    if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
    const target = realpathSync(link);
    const digest = readFileSync(join(target, ".harbor-release"), "utf8").trim();
    return (
      /^[a-f0-9]{64}$/.test(digest) &&
      dirname(target) === dirname(realpathSync(cwd)) &&
      basename(target) === version + "-" + digest.slice(0, 16) &&
      target !== realpathSync(cwd)
    );
  } catch {
    return false;
  }
}

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
    acpHosts = [] as readonly number[],
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
    const allowed = new Set([pid, ...idleRpc]);
    // These are the PTY workers retained by the Terminal registry for idle managed ACP chats.
    // A shell, tool process or unrelated descendant anywhere in the cgroup blocks the handoff.
    if (acpHosts.length) {
      const wrapper = join(realpathSync(cwd), "desktop", "antigravity.cjs");
      const processes = pids
        .filter((p) => !allowed.has(p))
        .map((p) => {
          const dir = join(proc, String(p));
          const parent = Number(
            /^PPid:\s+(\d+)$/m.exec(
              readFileSync(join(dir, "status"), "utf8"),
            )?.[1],
          );
          return {
            pid: p,
            parent,
            exe: readlinkSync(join(dir, "exe")),
            argv: readFileSync(join(dir, "cmdline"), "utf8")
              .split("\0")
              .slice(0, -1),
          };
        });
      for (const pty of acpHosts) {
        const owner = processes.find((p) => p.pid === pty && p.parent === pid);
        const adapter = processes.find(
          (p) =>
            p.parent === pty && p.argv[1] === wrapper && p.exe === owner?.exe,
        );
        if (!adapter || !owner || !adapter.argv[2]) return false;
        const nativeExe = realpathSync(adapter.argv[2]);
        const agent = processes.find(
          (p) =>
            p.parent === adapter.pid &&
            p.exe === nativeExe &&
            p.argv.length === 3 &&
            p.argv[1] === "acp" &&
            p.argv[2] === "--stdio",
        );
        if (!agent) return false;
        for (const p of [owner, adapter, agent]) allowed.add(p.pid);
        for (const mcp of processes.filter(
          (p) =>
            p.parent === agent.pid &&
            p.exe === adapter.exe &&
            p.argv.length === 3 &&
            p.argv[1] === wrapper &&
            p.argv[2] === "--mcp",
        ))
          allowed.add(mcp.pid);
      }
    }
    return pids.every((p) => {
      if (allowed.has(p)) return true;
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
