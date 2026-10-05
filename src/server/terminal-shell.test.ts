import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, rm, copyFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import {
  powershellInitialization,
  bashInitialization,
  remoteTerminalCommand,
  codexArguments,
} from "./terminal-shell.js";
import type { HostConfig } from "../shared/types.js";
import { permissionHookConfig } from "./permission-hook.js";
import { shellDirectory } from "./ssh.js";

test("SSH home directory expands on the remote account without interpreting other paths", () => {
  assert.equal(shellDirectory("~"), '"$HOME"');
  assert.equal(shellDirectory("~/a b"), '"$HOME"/\'a b\'');
  assert.equal(shellDirectory("/tmp/$(bad)"), "'/tmp/$(bad)'");
  const host = { codexPath: "codex" } as HostConfig;
  assert.ok(remoteTerminalCommand(host, "~", "shell").startsWith('cd "$HOME" &&'));
  assert.ok(bashInitialization(host, "~", "shell", { token: "fixture", url: "http://localhost" }).includes('cd "$HOME" || exit;'));
});

test("SSH commands quote folders and selected programs; bridge token occurs only in private stdin initialization", () => {
  const host = { codexPath: "/home/user/a'b/codex" } as HostConfig;
  const token = randomUUID();
  const cwd = "/home/user/work;touch should-not-run";
  const command = remoteTerminalCommand(host, cwd, "resume");
  assert.ok(command.includes("--all"));
  const threadId = randomUUID();
  assert.deepEqual(codexArguments("resume", undefined, threadId).slice(0, 2), [
    "resume",
    threadId,
  ]);
  assert.ok(
    remoteTerminalCommand(host, cwd, "resume", threadId).includes(threadId),
  );
  assert.ok(command.includes("'\\''"));
  assert.ok(!command.includes(token));
  assert.throws(() => remoteTerminalCommand(host, "/home/a\nother", "shell"));
  const init = bashInitialization(host, cwd, "shell", {
    token,
    url: "http://127.0.0.1:4327/bridge/mcp",
  });
  assert.ok(init.includes("export -f codex"));
  assert.ok(init.includes(token));
  assert.ok(init.includes("exec bash --rcfile"));
  assert.ok(
    init.length < 4096,
    "initialization fits the remote terminal's canonical input line",
  );
});

test(
  "PowerShell wrapper forwards real native arguments and keeps bridge token in environment only",
  { skip: process.platform !== "win32" },
  async (t) => {
    const parent = resolve(".cache/terminal-shell-tests");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, "run-"));
    t.after(async () => {
      if (resolve(directory).startsWith(parent + sep))
        await rm(directory, { recursive: true, force: true });
    });
    const executable = join(directory, "codex.exe");
    const output = join(directory, "args.json");
    // A tiny native fixture verifies PowerShell's argv quoting at the process boundary.
    const source = `using System; using System.IO; using System.Web.Script.Serialization; public class Capture { public static void Main(string[] args) { File.WriteAllText(Environment.GetEnvironmentVariable("HARBOR_TEST_CAPTURE"), new JavaScriptSerializer().Serialize(new { settings=(args.Length > 1 && args[0] == "--settings" ? File.ReadAllText(args[1]) : null), args=args, token=Environment.GetEnvironmentVariable("HARBOR_SESSION_TOKEN") })); } }`;
    const compile = `Add-Type -TypeDefinition '${source.replaceAll("'", "''")}' -ReferencedAssemblies System.Web.Extensions -OutputAssembly '${executable.replaceAll("'", "''")}' -OutputType ConsoleApplication`;
    const run = (script: string, extraEnv: NodeJS.ProcessEnv = {}) =>
      new Promise<string>((done, reject) => {
        const child = spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ],
          {
            windowsHide: true,
            env: { ...process.env, ...extraEnv },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let errors = "";
        let stdout = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (errors += chunk));
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0
            ? done(stdout)
            : reject(
                new Error(`Native fixture failed: ${errors.slice(0, 500)}`),
              ),
        );
      });
    await run(compile);
    await copyFile(executable, join(directory, "claude.exe"));
    const claudeInit = powershellInitialization({} as HostConfig, "shell", "http://127.0.0.1:1/bridge/mcp", undefined, true);
    await run(`${claudeInit}; claude --resume fixture-session`, {
      HARBOR_TEST_CAPTURE: output,
      HARBOR_SESSION_TOKEN: "mcp-secret-must-not-reach-claude",
      PATH: `${directory};${process.env.PATH}`,
    });
    const claudeCaptured = JSON.parse(await readFile(output, "utf8"));
    assert.equal(claudeCaptured.token, null);
    const claudeSettings = JSON.parse(claudeCaptured.settings);
    assert.equal(claudeSettings.hooks.SessionStart[0].hooks[0].url, "http://127.0.0.1:1/bridge/claude");
    assert.deepEqual(claudeCaptured.args.slice(-2), ["--resume", "fixture-session"]);
    const token = randomUUID();
    const initialization = powershellInitialization(
      { codexPath: executable } as HostConfig,
      "shell",
      "http://127.0.0.1:1/bridge/mcp",
      undefined,
      true,
    );
    assert.equal(initialization.includes(token), false);
    const cwdOutput = await run(`${initialization}; Set-Location -LiteralPath '${directory.replaceAll("'", "''")}'; prompt; codex -C '${parent.replaceAll("'", "''")}'`, {
      HARBOR_TEST_CAPTURE: output,
    });
    assert.ok(cwdOutput.includes(`\x1b]1337;CurrentDir=${directory}\x07`), "prompt reports the directory after cd");
    assert.ok(cwdOutput.includes(`\x1b]1337;CurrentDir=${parent}\x07`), "Codex -C reports its effective directory");
    await run(`${initialization}; codex resume --last`, {
      HARBOR_SESSION_TOKEN: token,
      HARBOR_TEST_CAPTURE: output,
    });
    const captured = JSON.parse(await readFile(output, "utf8"));
    assert.equal(captured.token, token);
    assert.ok(
      captured.args.includes(
        'mcp_servers.harbor.url="http://127.0.0.1:1/bridge/mcp"',
      ),
    );
    assert.ok(
      captured.args.includes(
        'mcp_servers.harbor.bearer_token_env_var="HARBOR_SESSION_TOKEN"',
      ),
    );
    assert.deepEqual(captured.args.slice(-2), ["resume", "--last"]);
    assert.equal(
      captured.args.find((arg: string) =>
        arg.startsWith("hooks.PermissionRequest="),
      ),
      permissionHookConfig("windows"),
    );
    assert.equal(
      captured.args.includes("--dangerously-bypass-hook-trust"),
      false,
    );
    assert.equal(
      captured.args.some((value: string) => value.includes(token)),
      false,
    );
    await rm(output);
    const fromPath = powershellInitialization(
      { codexPath: "codex" } as HostConfig,
      "shell",
    );
    await run(`${fromPath}; codex --version`, {
      HARBOR_TEST_CAPTURE: output,
      PATH: `${directory};${process.env.PATH}`,
    });
    const defaultCaptured = JSON.parse(await readFile(output, "utf8"));
    assert.equal(
      defaultCaptured.args.at(-1),
      "--version",
      "default codex resolves the application without recursing into its wrapper",
    );
    await rm(output);
    await run(
      `${initialization}; codex -C 'C:\\user folder' exec -c 'model_reasoning_effort="low"' '--config=example="value"' '--' '-c' 'literal-prompt'`,
      {
        HARBOR_SESSION_TOKEN: token,
        HARBOR_TEST_CAPTURE: output,
      },
    );
    const configured = JSON.parse(await readFile(output, "utf8"))
      .args as string[];
    assert.ok(
      configured.indexOf('model_reasoning_effort="low"') <
        configured.indexOf("exec"),
    );
    assert.ok(
      configured.indexOf('example="value"') < configured.indexOf("exec"),
    );
    assert.deepEqual(configured.slice(-4), [
      "exec",
      "--",
      "-c",
      "literal-prompt",
    ]);
    assert.deepEqual(
      configured.slice(configured.indexOf("-C"), configured.indexOf("-C") + 2),
      ["-C", "C:\\user folder"],
    );
    for (const threadId of [undefined, randomUUID()]) {
      await rm(output);
      await run(
        powershellInitialization(
          { codexPath: executable } as HostConfig,
          "resume",
          undefined,
          threadId,
        ),
        { HARBOR_TEST_CAPTURE: output },
      );
      const resumed = JSON.parse(await readFile(output, "utf8"));
      assert.deepEqual(resumed.args.slice(-2), ["resume", threadId || "--all"]);
    }
  },
);
