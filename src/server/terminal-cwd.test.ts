import { test } from "node:test";
import assert from "node:assert/strict";
import { TerminalCwdObserver } from "./terminal-cwd.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { resolve, join, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { bashInitialization } from "./terminal-shell.js";
import type { HostConfig } from "../shared/types.js";

test(
  "managed remote research launch preserves Bash quoting, assigned cwd, resume identity and low effort",
  {
    skip: !existsSync(
      process.platform === "win32"
        ? "C:/Program Files/Git/bin/bash.exe"
        : "/bin/bash",
    ),
  },
  () => {
    const parent = resolve(".cache/research-bash-tests");
    mkdirSync(parent, { recursive: true });
    const dir = mkdtempSync(join(parent, "run-"));
    const unix = (p: string) =>
      p
        .replaceAll("\\", "/")
        .replace(
          /^([A-Za-z]):/,
          (_, letter: string) => `/${letter.toLowerCase()}`,
        );
    const work = join(dir, "work with 'quote'");
    mkdirSync(work);
    mkdirSync(join(dir, "bin"));
    const fake =
      '#!/bin/bash\nprintf \'\\nFIXTURE_CWD:%s\\n\' "$PWD"; for arg in "$@"; do printf \'FIXTURE_ARG:%s\\n\' "$arg"; done; printf \'FIXTURE_CHANNEL:%s\\n\' "$HARBOR_CLAUDE_CHANNEL_ENABLED"\n';
    writeFileSync(join(dir, "bin", "claude"), fake, { mode: 0o755 });
    writeFileSync(join(dir, "bin", "codex"), fake, { mode: 0o755 });
    writeFileSync(
      join(dir, "bin", "python3"),
    '#!/bin/sh\nshift 4\nfixture_executable=$1\nshift 3\nexec "$fixture_executable" "$@"\n',
      { mode: 0o755 },
    );
    writeFileSync(
      join(dir, ".bashrc"),
      `export PATH=\"${unix(join(dir, "bin"))}:$PATH\"\n`,
    );
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: unix(dir) };
    delete env.HARBOR_CODEX_MANAGED_PARENT;
    try {
      for (const program of ["claude-resume", "resume"] as const) {
        const initialization = bashInitialization(
          { codexPath: unix(join(dir, "bin", "codex")) } as HostConfig,
          "~",
          program,
          {
            token: "fixture",
            url: "http://127.0.0.1:1/bridge",
            hook: { token: "fixture-hook", url: "http://127.0.0.1:1/hooks" },
          },
          "fixture-native-id",
          undefined,
          { cwd: unix(work), effort: "low" },
        );
        const scriptFile = join(dir, "initialize.sh");
        writeFileSync(scriptFile, initialization);
        const result = spawnSync(
          bash,
          ["--noprofile", "--norc", unix(scriptFile)],
          {
            env,
            input: "exit\n",
            encoding: "utf8",
            timeout: 15000,
            windowsHide: true,
          },
        );
        assert.equal(result.status, 0, result.stderr || String(result.error));
        assert.match(
          result.stdout,
          /FIXTURE_ARG:fixture-native-id/,
          result.stderr,
        );
        if (program === "claude-resume") {
          assert.ok(result.stdout.includes(`FIXTURE_CWD:${unix(work)}`));
          assert.match(
            result.stdout,
            /FIXTURE_ARG:--effort\r?\nFIXTURE_ARG:low/,
          );
          assert.match(result.stdout, /FIXTURE_CHANNEL:1/);
          assert.match(result.stdout, /FIXTURE_ARG:server:harbor/);
          assert.ok(!result.stdout.includes("FIXTURE_ARG:--harbor-peers"));
        } else {
          assert.ok(result.stdout.includes(`FIXTURE_ARG:${unix(work)}`));
          assert.match(
            result.stdout,
            /FIXTURE_ARG:model_reasoning_effort="low"/,
          );
        }
      }
    } finally {
      assert.ok(resolve(dir).startsWith(parent + sep));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("directory metadata is observed across arbitrary chunks without treating prose as commands", () => {
  const observer = new TerminalCwdObserver();
  const paths: string[] = [];
  for (const char of "cd /wrong\r\n\x1b]1337;CurrentDir=/home/a b\x07\x1b]7;file://remote/home/%ED%95%9C%EA%B8%80\x1b\\")
    paths.push(...observer.consume(char));
  assert.deepEqual(paths, ["/home/a b", "/home/한글"]);
  assert.deepEqual(
    observer.consume("\x1b]1337;CurrentDir=C:\\Users\\fixture b\x07"),
    ["C:\\Users\\fixture b"],
  );
  assert.deepEqual(
    observer.consume("\x1b]7;file:///C:/Users/fixture%20b\x07"),
    ["C:/Users/fixture b"],
  );
});

test("invalid relative/control-containing or oversized metadata cannot replace cwd", () => {
  const observer = new TerminalCwdObserver();
  for (const value of [
    "relative",
    "~/work",
    "/tmp/a\nother",
    "/" + "x".repeat(9000),
  ]) {
    assert.deepEqual(observer.consume(`\x1b]1337;CurrentDir=${value}\x07`), []);
  }
  observer.consume("\x1b]" + "x".repeat(9000) + "\x07");
  assert.deepEqual(observer.consume("\x1b]1337;CurrentDir=/recovered\x07"), [
    "/recovered",
  ]);
});

test("DCS and APC payloads cannot masquerade as directory metadata", () => {
  for (const opener of ["\x1bP", "\x1b_"]) {
    const observer = new TerminalCwdObserver();
    const paths: string[] = [];
    for (const char of `${opener}\x1b]1337;CurrentDir=/fake\x07\x1b\\\x1b]1337;CurrentDir=/real\x07`)
      paths.push(...observer.consume(char));
    assert.deepEqual(paths, ["/real"]);
  }
});

const bash =
  process.platform === "win32"
    ? "C:/Program Files/Git/bin/bash.exe"
    : "/bin/bash";
test(
  "managed Bash reports prompt cd and Codex -C while preserving existing prompt hooks",
  { skip: !existsSync(bash) },
  () => {
    const parent = resolve(".cache/terminal-cwd-tests");
    mkdirSync(parent, { recursive: true });
    const directory = mkdtempSync(join(parent, "run-"));
    const unix = (value: string) =>
      value
        .replaceAll("\\", "/")
        .replace(
          /^([A-Za-z]):/,
          (_, letter: string) => `/${letter.toLowerCase()}`,
        );
    const home = unix(directory);
    mkdirSync(join(directory, "project"));
    mkdirSync(join(directory, "other"));
    writeFileSync(
      join(directory, ".bashrc"),
      "PROMPT_COMMAND='printf original-prompt-hook'\n",
    );
    try {
      const initialization = bashInitialization(
        { codexPath: "/usr/bin/true" } as HostConfig,
        "~",
        "shell",
        { token: "fixture", url: "http://127.0.0.1:1" },
      );
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
      // This fixture creates a new managed parent, even if the test runner itself
      // was launched inside an existing Harbor-managed Codex conversation.
      delete env.HARBOR_CODEX_MANAGED_PARENT;
      const child = spawnSync(
        bash,
        ["--noprofile", "--norc", "-c", initialization],
        {
          env,
          input: "cd project\ncodex -C ../other\nexit\n",
          encoding: "utf8",
          timeout: 15000,
          windowsHide: true,
        },
      );
      assert.equal(child.status, 0, child.stderr);
      const paths = new TerminalCwdObserver().consume(child.stdout);
      assert.ok(paths.includes(home), JSON.stringify(paths));
      assert.ok(paths.includes(`${home}/project`), JSON.stringify(paths));
      assert.ok(paths.includes(`${home}/other`), JSON.stringify(paths));
      assert.ok(child.stdout.includes("original-prompt-hook"));
      assert.equal(
        paths.at(-1),
        `${home}/project`,
        "shell restores cwd after Codex exits",
      );
    } finally {
      if (resolve(directory).startsWith(parent + sep))
        rmSync(directory, { recursive: true, force: true });
    }
  },
);
