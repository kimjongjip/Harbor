import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { workspaceApplyUpdate } from "./workspace-install.js";

test(
  "explicit workspace restart is bound to the confirmed, managed release pair",
  { skip: process.platform !== "linux" },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "harbor-apply-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const root = join(home, ".local/share/harbor-workspace");
    const release = (version: string) =>
      join(root, "releases", version + "-0123456789abcdef");
    for (const version of ["2.0.0", "2.0.7"]) {
      await mkdir(release(version), { recursive: true });
      await writeFile(join(release(version), ".harbor-release"), "fixture");
    }
    const unitDir = join(home, ".config/systemd/user");
    await mkdir(unitDir, { recursive: true });
    await writeFile(
      join(unitDir, "harbor-workspace.service"),
      "# Harbor managed workspace\n",
    );
    await symlink(release("2.0.7"), join(root, "current"));
    await symlink(release("2.0.0"), join(root, "fixture-running"));
    await mkdir(join(home, "harbor-workspace"));
    const server = createServer().listen(
      join(home, "harbor-workspace/http.sock"),
    );
    await once(server, "listening");
    t.after(() => server.close());
    const fakeSystemd = `
readlink() {
  if [[ "$*" = *"/proc/333/cwd" ]]; then command readlink -f "$root/fixture-running"
  else command readlink "$@"; fi
}
systemctl() {
  case "$*" in
    "--user is-enabled --quiet harbor-workspace.service"|"--user is-active --quiet harbor-workspace.service") return 0 ;;
    "--user show -p MainPID --value harbor-workspace.service") echo 333 ;;
    "--user show -p FragmentPath --value harbor-workspace.service") echo "$UNIT_FILE" ;;
    "--user restart harbor-workspace.service") ln -sfn "$(readlink -f "$root/current")" "$root/fixture-running"; echo applied >> "$HOME/restarts" ;;
    *) return 1 ;;
  esac
}
`;
    function apply(
      running: string,
      staged: string,
      unitFile = join(unitDir, "harbor-workspace.service"),
    ) {
      return spawnSync(
        "/bin/bash",
        ["-c", fakeSystemd + workspaceApplyUpdate(running, staged)],
        {
          env: {
            ...process.env,
            HOME: home,
            XDG_RUNTIME_DIR: home,
            UNIT_FILE: unitFile,
          },
          encoding: "utf8",
          timeout: 10000,
        },
      );
    }
    assert.notEqual(apply("2.0.2", "2.0.7").status, 0);
    assert.notEqual(apply("2.0.0", "2.0.8").status, 0);
    assert.notEqual(
      apply("2.0.0", "2.0.7", "/fixture/other.service").status,
      0,
    );
    await assert.rejects(readFile(join(home, "restarts")), { code: "ENOENT" });
    const result = apply("2.0.0", "2.0.7");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(apply("2.0.0", "2.0.7").status, 0);
    assert.equal(await readFile(join(home, "restarts"), "utf8"), "applied\n");
  },
);
