import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agyPresenceProbe } from "./native-agy-transcript.js";

// The probe runs on Linux servers. Replay it there against a synthetic /proc.
const python = (() => {
  if (process.platform !== "linux") return undefined;
  try {
    execFileSync("python3", ["-c", "pass"], { stdio: "ignore" });
    return "python3";
  } catch {
    return undefined;
  }
})();

type Proc = { exe: string; comm: string; children?: number[]; fds?: string[] };
function probe(tree: Record<number, Proc>) {
  const root = mkdtempSync(join(tmpdir(), "harbor-agy-proc-"));
  try {
    for (const [pid, p] of Object.entries(tree)) {
      const dir = join(root, pid);
      mkdirSync(join(dir, "fd"), { recursive: true });
      mkdirSync(join(dir, "task", pid), { recursive: true });
      symlinkSync(p.exe, join(dir, "exe"));
      writeFileSync(join(dir, "comm"), p.comm + "\n");
      writeFileSync(join(dir, "task", pid, "children"), (p.children || []).join(" "));
      (p.fds || []).forEach((target, i) => symlinkSync(target, join(dir, "fd", String(i))));
    }
    const code = agyPresenceProbe.split("'/proc/'").join(JSON.stringify(root + "/"));
    assert.notEqual(code, agyPresenceProbe);
    return execFileSync(python!, ["-c", code, "100"], { encoding: "utf8" }).trim();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a self-updated agy keeps its pane session", { skip: !python }, () => {
  const id = "f0000000-0000-4000-8000-00000000000a";
  const lock = (session: string) =>
    join(homedir(), ".gemini", "antigravity-cli", "presence", session + ".lock");
  const tree = (exe: string, fds = [lock(id)]): Record<number, Proc> => ({
    100: { exe: "/usr/bin/bash", comm: "bash", children: [200] },
    200: { exe, comm: "agy", fds, children: [300] },
    300: { exe: "/usr/bin/python3", comm: "python3" },
  });
  assert.equal(probe(tree("/opt/agy/bin/agy")), id);
  assert.equal(probe(tree("/opt/agy/bin/agy (deleted)")), id);
  // agy renames its running file to agy.<ns>.old when it updates itself.
  assert.equal(probe(tree("/opt/agy/bin/agy.1795495288426541000.old")), id);
  assert.equal(probe(tree("/opt/agy/bin/agy.1795495288426541000.old (deleted)")), id);
  assert.equal(probe(tree("/opt/agy/bin/agy", [lock(id), lock(id.replace(/a$/, "b"))])), "unknown");
  assert.equal(probe({ 100: { exe: "/usr/bin/bash", comm: "bash" } }), "absent");
  assert.equal(
    probe({
      100: { exe: "/usr/bin/bash", comm: "bash", children: [200] },
      200: { exe: "/usr/bin/agyfoo", comm: "agyfoo" },
    }),
    "absent",
  );
});
