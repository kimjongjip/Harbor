import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store } from "./store.js";
import { Hub } from "./hub.js";
import { bashInitialization, remoteTerminalCommand } from "./terminal-shell.js";
import { cliApprovalArgs } from "./cli-approval.js";
import type { HostConfig } from "../shared/types.js";

const bash =
  process.platform === "win32"
    ? "C:/Program Files/Git/bin/bash.exe"
    : "/bin/bash";
const unix = (value: string) =>
  value
    .replace(/\\/g, "/")
    .replace(/^([A-Z]):/i, (_, drive: string) => `/${drive.toLowerCase()}`);

test("approval defaults persist for one host without disconnecting or changing old snapshots", async (t) => {
  const root = resolve(".cache/approval-tests");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "store-"));
  t.after(async () => {
    assert.ok(dir.startsWith(root + sep));
    await rm(dir, { recursive: true, force: true });
  });
  const store = new Store(dir),
    hub = new Hub(store);
  const host = hub.host("local"),
    snapshot = { ...host };
  const other = hub.addHost({ ...host, name: "Other fixture", kind: "ssh" });
  host.status = "connected";
  hub.setCliApprovalMode(host.id, "full-access");
  assert.equal(host.status, "connected");
  assert.equal(other.cliApprovalMode, undefined);
  assert.deepEqual(cliApprovalArgs(snapshot, "codex"), []);
  const reloaded = new Store(dir).data.hosts.find(
    (item) => item.id === host.id,
  )!;
  assert.equal(reloaded.cliApprovalMode, "full-access");
  hub.setCliApprovalMode(host.id, "native");
  assert.deepEqual(cliApprovalArgs(new Store(dir).data.hosts[0], "claude"), []);
  t.mock.method(store, "save", () => {
    throw new Error("fixture disk failure");
  });
  assert.throws(
    () => hub.setCliApprovalMode(host.id, "full-access"),
    /fixture disk failure/,
  );
  assert.equal(host.cliApprovalMode, "native");
  assert.equal(store.data.hosts[0].cliApprovalMode, "native");
});

test("remote direct launches opt in explicitly, preserve resume ids and never invoke an answer macro", () => {
  const host = {
    codexPath: "codex",
    cliApprovalMode: "full-access",
  } as HostConfig;
  const unsupportedShell = remoteTerminalCommand(host, "/fixture", "shell");
  assert.match(unsupportedShell, /exit 78/);
  assert.doesNotMatch(unsupportedShell, /exec .*SHELL/);
  for (const program of [
    "codex",
    "resume",
    "claude",
    "claude-resume",
  ] as const) {
    const command = remoteTerminalCommand(
      host,
      "/fixture",
      program,
      "history-id",
    );
    assert.ok(
      command.includes(
        program.startsWith("claude")
          ? "bypassPermissions"
          : 'approval_policy="never"',
      ),
    );
    if (program.includes("resume")) assert.ok(command.includes("history-id"));
    assert.doesNotMatch(command, /\byes\b/);
    const native = remoteTerminalCommand(
      { ...host, cliApprovalMode: "native" },
      "/fixture",
      program,
    );
    assert.doesNotMatch(
      native,
      /bypassPermissions|danger-full-access|approval_policy/,
    );
  }
});

test(
  "managed SSH Bash wrappers pass selected native options and respect literal/user arguments",
  { skip: !existsSync(bash) },
  async (t) => {
    const root = resolve(".cache/approval-tests");
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "bash-"));
    t.after(async () => {
      assert.ok(dir.startsWith(root + sep));
      await rm(dir, { recursive: true, force: true });
    });
    const bin = join(dir, "bin");
    await mkdir(bin);
    for (const name of ["codex", "claude"])
      await writeFile(
        join(bin, name),
        '#!/usr/bin/env bash\nprintf "%s\\0" "$@" > "$HARBOR_TEST_CAPTURE"\n',
        { mode: 0o700 },
      );
    for (const mode of ["native", "full-access"] as const) {
      const init = bashInitialization(
        { codexPath: "codex", cliApprovalMode: mode } as HostConfig,
        "",
        "shell",
        { token: "fixture", url: "http://127.0.0.1:1/bridge/mcp" },
      );
      // Exercise exported shell functions, without launching an interactive shell or SSH.
      const definitions = init.slice(0, init.lastIndexOf("stty echo icanon;"));
      for (const agent of ["codex", "claude"] as const) {
        const output = join(dir, "argv"),
          script = join(dir, "run.sh");
        const invocation =
          agent === "codex"
            ? 'codex resume history-id -c \'approval_policy="on-request"\' -- "literal prompt"'
            : 'claude --resume history-id -- "literal prompt"';
        await writeFile(
          script,
          `export PATH='${unix(bin)}':"$PATH"\nunset HARBOR_CODEX_MANAGED_PARENT\n${definitions}\n${invocation}\n`,
        );
        await promisify(execFile)(
          bash,
          ["--noprofile", "--norc", unix(script)],
          {
            windowsHide: true,
            timeout: 20000,
            env: { ...process.env, HARBOR_TEST_CAPTURE: unix(output) },
          },
        );
        const args = (await readFile(output, "utf8")).split("\0").slice(0, -1);
        assert.deepEqual(args.slice(-2), ["--", "literal prompt"]);
        assert.ok(args.includes("history-id"));
        const expected =
          agent === "codex" ? 'approval_policy="never"' : "bypassPermissions";
        assert.equal(args.includes(expected), mode === "full-access");
        if (agent === "codex")
          assert.ok(
            args.indexOf('approval_policy="on-request"') >
              args.indexOf(expected),
          );
      }
    }
  },
);
