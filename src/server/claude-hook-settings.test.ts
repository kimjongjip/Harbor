import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import {
  claudeArguments,
  claudeHookSettings,
  claudeSessionStartCommand,
} from "./claude-hooks.js";

test("SessionStart uses a supported native command while turn, lifecycle and permission events remain HTTP", () => {
  const url = "http://127.0.0.1:9999/bridge/claude";
  for (const platform of ["windows", "posix"] as const) {
    const settings = JSON.parse(claudeHookSettings(url, platform));
    const start = settings.hooks.SessionStart[0].hooks[0];
    assert.equal(start.type, "command");
    assert.equal(start.command, claudeSessionStartCommand(url, platform));
    assert.equal(start.url, undefined);
    assert.equal(start.timeout, 10);
    if (platform === "posix")
      assert.match(start.command, /^python3 -X utf8 -c /);
    for (const name of [
      "SessionEnd",
      "UserPromptSubmit",
      "Stop",
      "PermissionRequest",
      "CwdChanged",
      "PostToolUse",
    ]) {
      const hook = settings.hooks[name][0].hooks[0];
      assert.equal(hook.type, "http");
      assert.equal(hook.url, url);
      assert.equal(hook.headers.Authorization, "Bearer $HARBOR_HOOK_TOKEN");
      assert.deepEqual(hook.allowedEnvVars, ["HARBOR_HOOK_TOKEN"]);
    }
    const launch = claudeArguments(url, "synthetic-resume-id", true, platform);
    assert.deepEqual(launch.slice(-2), ["--resume", "synthetic-resume-id"]);
    assert.equal(launch[1], JSON.stringify(settings));
  }
});

test(
  "Windows SessionStart command posts the exact synthetic native event with inherited scoped credentials",
  { skip: process.platform !== "win32" },
  async (t) => {
    const fixtureToken = "fixture-hook-token-never-in-argv";
    const event = {
      hook_event_name: "SessionStart",
      session_id: "fixture-session-resume",
      source: "resume",
      cwd: "C:/fixture/한글 project",
    };
    let received: unknown;
    let authorization: string | undefined;
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      received = JSON.parse(body);
      authorization = req.headers.authorization;
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/bridge/claude`;
    const command = claudeSessionStartCommand(url, "windows");
    assert(!command.includes(fixtureToken));
    const encoded = command.split("-EncodedCommand ")[1];
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    assert(script.includes("$env:HARBOR_HOOK_TOKEN"));
    assert(!script.includes(fixtureToken));
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      {
        env: { ...process.env, HARBOR_HOOK_TOKEN: fixtureToken },
        windowsHide: true,
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.stdin.end(JSON.stringify(event));
    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.equal(stdout, "{}");
    assert.deepEqual(received, event);
    assert.equal(authorization, `Bearer ${fixtureToken}`);
  },
);
