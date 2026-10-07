import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { bashInitialization } from "./terminal-shell.js";
import { shellQuote } from "./ssh.js";
import type { HostConfig } from "../shared/types.js";

const bash =
  process.platform === "win32"
    ? "C:/Program Files/Git/bin/bash.exe"
    : "/bin/bash";
const unix = (value: string) =>
  value
    .replaceAll("\\", "/")
    .replace(/^([A-Za-z]):/, (_, letter: string) => `/${letter.toLowerCase()}`);
const fixtureBridge = {
  token: "synthetic-session-token",
  url: "http://127.0.0.1:1/bridge/mcp",
  hook: {
    token: "synthetic-hook-token",
    url: "http://127.0.0.1:1/bridge/permission",
  },
};

test(
  "the complete managed SSH Bash bootstrap with both native peer adapters is valid Bash",
  { skip: !existsSync(bash) },
  () => {
    const initialization = bashInitialization(
      { codexPath: "codex" } as HostConfig,
      "~",
      "shell",
      fixtureBridge,
    );
    assert.ok(initialization.includes("HARBOR_CODEX_MANAGED_PARENT"));
    assert.ok(
      initialization.includes("--dangerously-load-development-channels"),
    );
    const checked = spawnSync(bash, ["--noprofile", "--norc", "-n"], {
      input: initialization,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
    });
    assert.equal(checked.error, undefined);
    assert.equal(checked.status, 0, checked.stderr);
  },
);

test(
  "inherited managed Bash children call the native CLIs with exact arguments and no new Harbor bootstrap",
  { skip: !existsSync(bash) },
  () => {
    const parent = resolve(".cache/terminal-shell-peer-tests");
    mkdirSync(parent, { recursive: true });
    const directory = mkdtempSync(join(parent, "run-"));
    const bin = join(directory, "bin"),
      calls = join(directory, "calls.bin"),
      unexpected = join(directory, "unexpected.log");
    mkdirSync(bin);
    writeFileSync(calls, "");
    writeFileSync(unexpected, "");
    writeFileSync(
      join(directory, ".bashrc"),
      'printf "unexpected-bashrc\\n" >> "$HARBOR_FIXTURE_UNEXPECTED"\n',
    );
    const executable = (name: string, contents: string) =>
      writeFileSync(join(bin, name), "#!/usr/bin/env bash\n" + contents, {
        mode: 0o755,
      });
    executable(
      "codex",
      'printf "%s\\0" "codex" "$@" >> "$HARBOR_FIXTURE_CALLS"\nexit 17\n',
    );
    executable(
      "claude",
      'printf "%s\\0" "claude" "$@" >> "$HARBOR_FIXTURE_CALLS"\nexit 23\n',
    );
    for (const command of ["curl", "python3"])
      executable(
        command,
        `printf "%s\\n" ${shellQuote(command)} >> "$HARBOR_FIXTURE_UNEXPECTED"\nexit 99\n`,
      );
    try {
      const initialization = bashInitialization(
        { codexPath: unix(join(bin, "codex")) } as HostConfig,
        "~",
        "shell",
        fixtureBridge,
      );
      const launch = initialization.lastIndexOf("stty echo icanon;");
      assert.ok(launch >= 0);
      const definitions = initialization.slice(0, launch);
      const codexArgs = [
        "exec",
        "-c",
        'fixture.option="value with spaces"',
        "--",
        "--harbor-peers",
        "literal $(not executed) 한국어",
      ];
      const claudeArgs = [
        "-p",
        "why use the queue? 한국어",
        "--",
        "--harbor-peers",
        'quote " stays literal',
      ];
      const script =
        definitions +
        "\n" +
        `codex ${codexArgs.map(shellQuote).join(" ")}\nprintf '%s\\n' "$?"\n` +
        `claude ${claudeArgs.map(shellQuote).join(" ")}\nprintf '%s\\n' "$?"\n`;
      const run = spawnSync(bash, ["--noprofile", "--norc"], {
        input: script,
        cwd: directory,
        env: {
          ...process.env,
          HOME: unix(directory),
          PATH: `${unix(bin)}:/usr/bin:/bin`,
          HARBOR_CODEX_MANAGED_PARENT: "1",
          HARBOR_FIXTURE_CALLS: unix(calls),
          HARBOR_FIXTURE_UNEXPECTED: unix(unexpected),
        },
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
      });
      assert.equal(run.error, undefined);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stderr, "");
      assert.equal(
        run.stdout.replaceAll("\r", ""),
        "17\n23\n",
        "No cwd notification or peer bootstrap is emitted by child invocations.",
      );
      assert.deepEqual(
        readFileSync(calls, "utf8").split("\0").filter(Boolean),
        ["codex", ...codexArgs, "claude", ...claudeArgs],
      );
      assert.equal(
        readFileSync(unexpected, "utf8"),
        "",
        "Nested calls neither initialize another MCP/channel helper nor call shell-state HTTP hooks.",
      );
    } finally {
      assert.ok(resolve(directory).startsWith(parent + sep));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
