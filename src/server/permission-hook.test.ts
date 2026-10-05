import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  permissionHookConfig,
  powershellPermissionHook,
} from "./permission-hook.js";

test(
  "native permission command posts UTF-8 stdin with env-only scoped credentials and preserves standard approval on failure",
  { skip: process.platform !== "win32" },
  async (t) => {
    const token = randomBytes(32).toString("hex");
    const event = {
      hook_event_name: "PermissionRequest",
      session_id: "fixture",
      tool_name: "Bash",
      tool_input: { command: "한글 작업 경로" },
    };
    let observed: unknown;
    let failure = false;
    const response = {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "사용자가 거절했습니다." },
      },
    };
    const server = createServer((req, res) => {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      let input = "";
      req.setEncoding("utf8");
      req.on("data", (part) => (input += part));
      req.on("end", () => {
        observed = JSON.parse(input);
        res.writeHead(failure ? 503 : 200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(failure ? "Unavailable" : JSON.stringify(response));
      });
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const url = `http://127.0.0.1:${(server.address() as any).port}/bridge/permission`;
    const run = () =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (done, reject) => {
          const child = spawn(
            "powershell.exe",
            [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              Buffer.from(powershellPermissionHook, "utf16le").toString(
                "base64",
              ),
            ],
            {
              windowsHide: true,
              env: {
                ...process.env,
                HARBOR_HOOK_URL: url,
                HARBOR_HOOK_TOKEN: token,
              },
              stdio: ["pipe", "pipe", "pipe"],
            },
          );
          let stdout = "",
            stderr = "";
          child.stdout.on("data", (data) => (stdout += data));
          child.stderr.on("data", (data) => (stderr += data));
          child.on("error", reject);
          child.on("close", (code) => done({ code, stdout, stderr }));
          child.stdin.end(JSON.stringify(event));
        },
      );
    const allowed = await run();
    assert.equal(allowed.code, 0);
    assert.deepEqual(observed, event);
    assert.deepEqual(JSON.parse(allowed.stdout), response);
    assert.equal(allowed.stderr, "");
    assert.equal((allowed.stdout + allowed.stderr).includes(token), false);
    failure = true;
    const failed = await run();
    assert.equal(failed.code, 0);
    assert.deepEqual(JSON.parse(failed.stdout), {});
    assert.equal(failed.stderr, "");
    for (const platform of ["windows", "posix"] as const) {
      const config = permissionHookConfig(platform);
      assert.ok(config.startsWith("hooks.PermissionRequest="));
      assert.equal(config.includes(token), false);
      assert.equal(config.includes(url), false);
      assert.equal(config.includes("bypass-hook-trust"), false);
    }
  },
);
