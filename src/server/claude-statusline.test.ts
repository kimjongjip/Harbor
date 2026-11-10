import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { claudeStatuslineCommand } from "./claude-statusline.js";
import { claudeHookSettings } from "./claude-hooks.js";

test("status telemetry is session-only and independent of the native Mods/plugin API", () => {
  for (const platform of ["windows", "posix"] as const) {
    const url = "http://127.0.0.1:9999/bridge/claude";
    const settings = JSON.parse(claudeHookSettings(url, platform));
    assert.equal(settings.statusLine.type, "command");
    assert.equal(settings.statusLine.command, claudeStatuslineCommand(url, platform));
    assert.ok(settings.hooks.Stop);
    assert.equal(settings.enabledPlugins, undefined);
  }
});

test("Windows official statusLine adapter posts synthetic JSON without drawing CLI text or exposing its token", { skip: process.platform !== "win32" }, async t => {
  const event = { session_id: "fixture", context_window: { context_window_size: 1000000, current_usage: null }, cost: { total_cost_usd: 0 } };
  let received: unknown, authorization: string | undefined, route = "";
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    received = JSON.parse(body); authorization = req.headers.authorization; route = req.url || "";
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const command = claudeStatuslineCommand(`http://127.0.0.1:${(server.address() as any).port}/bridge/permission`, "windows");
  const encoded = command.split("-EncodedCommand ")[1];
  assert.ok(!Buffer.from(encoded, "base64").toString("utf16le").includes("fixture-secret-token"));
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    env: { ...process.env, HARBOR_HOOK_TOKEN: "fixture-secret-token" }, windowsHide: true,
  });
  let output = "", errors = "";
  child.stdout.on("data", value => output += value); child.stderr.on("data", value => errors += value);
  child.stdin.end(JSON.stringify(event));
  const [code] = await once(child, "exit");
  assert.equal(code, 0); assert.equal(output, ""); assert.equal(errors, "");
  assert.deepEqual(received, event); assert.equal(route, "/bridge/claude/usage"); assert.equal(authorization, "Bearer fixture-secret-token");
});
