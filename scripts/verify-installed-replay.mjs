import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { homedir } from "node:os";
import WebSocket from "ws";

// Exercise the actual installed runtime and dependencies with our own empty
// state, port and shell. Never attach to the user's running Harbor process.
const root = process.cwd();
const pointer = JSON.parse(await readFile("release/current.json", "utf8"));
const install = path.resolve("release", pointer.directory, "resources/app");
assert.ok(install.startsWith(path.resolve("release") + path.sep));
const parent = path.resolve(".cache/installed-replay");
await mkdir(parent, { recursive: true });
const fixture = await mkdtemp(path.join(parent, "run-"));
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
const child = spawn(
  path.join(install, "runtime/node.exe"),
  [path.join(install, "dist/server.mjs")],
  {
    cwd: install,
    windowsHide: true,
    env: {
      ...process.env,
      NODE_ENV: "production",
      HARBOR_PORT: String(port),
      HARBOR_DATA_DIR: path.join(fixture, "state"),
      HARBOR_DEFAULT_CWD: fixture,
      CODEX_HOME: path.join(fixture, "codex"),
    },
    stdio: "ignore",
  },
);
const exited = once(child, "exit");
let socket;
let fixtureTerminalId;
let fixtureToken;
try {
  let bootstrap;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, "Installed backend stays running");
    try {
      bootstrap = await (
        await fetch(`${base}/api/bootstrap`, {
          signal: AbortSignal.timeout(1000),
        })
      ).json();
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(
    bootstrap,
    "Installed backend starts with its packaged dependencies",
  );
  assert.equal(bootstrap.capabilities.terminalReplayState, true);
  assert.equal(bootstrap.state.terminals.length, 0);
  fixtureToken = bootstrap.token;
  const post = async (url, value = {}) => {
    const response = await fetch(base + url, {
      method: "POST",
      headers: {
        "X-Harbor-Token": bootstrap.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(15000),
    });
    assert.ok(response.ok, `Fixture request succeeded (${response.status})`);
    return response.json();
  };
  const terminal = await post("/api/terminals", {
    hostId: "local",
    program: "shell",
    cwd: fixture,
  });
  fixtureTerminalId = terminal.id;
  assert.equal(terminal.cwd, homedir(), "New terminals ignore saved/requested folders and start at home");
  socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${bootstrap.token}`);
  const replay = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Installed replay timeout")),
      15000,
    );
    socket.on("error", reject);
    socket.on("open", () =>
      socket.send(
        JSON.stringify({
          type: "subscribe",
          sessions: [],
          terminals: [terminal.id],
        }),
      ),
    );
    socket.on("message", (bytes) => {
      const event = JSON.parse(bytes.toString());
      if (event.type === "terminal-data" && event.id === terminal.id) {
        clearTimeout(timer);
        resolve(event.replay);
      }
    });
  });
  assert.equal(
    replay?.snapshot,
    true,
    "Installed ConPTY is restored from a canonical screen snapshot",
  );
  socket.close();
  await post(`/api/terminals/${terminal.id}/close`);
  fixtureTerminalId = undefined;
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/installed-replay-verification.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        passed: true,
        installedDirectory: pointer.directory,
        isolatedState: true,
        canonicalReplay: true,
        modelTurns: 0,
        productionTerminalsTouched: false,
      },
      null,
      2,
    ),
  );
  console.log("Installed runtime + isolated ConPTY canonical replay: PASS");
} finally {
  socket?.terminate();
  if (fixtureTerminalId && fixtureToken) {
    await fetch(`${base}/api/terminals/${fixtureTerminalId}/close`, {
      method: "POST",
      headers: { "X-Harbor-Token": fixtureToken, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  }
  if (child.exitCode === null) child.kill();
  await exited;
  assert.ok(fixture.startsWith(parent + path.sep));
  await rm(fixture, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
