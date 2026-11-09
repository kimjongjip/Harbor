import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { _electron } from "playwright";

// An isolated backend, profile and shell. No user terminal, SSH or model call.
const root = process.cwd();
const parent = path.resolve(".cache/view-recovery");
await mkdir(parent, { recursive: true });
const fixture = await mkdtemp(path.join(parent, "run-"));
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [path.join(root, "dist/server.mjs")], {
  cwd: root,
  windowsHide: true,
  env: {
    ...process.env,
    HARBOR_PORT: String(port),
    HARBOR_DATA_DIR: path.join(fixture, "state"),
    CODEX_HOME: path.join(fixture, "codex"),
    CLAUDE_CONFIG_DIR: path.join(fixture, "claude"),
    HARBOR_AUTO_CONNECT: "0",
  },
  stdio: "ignore",
});
const exited = once(child, "exit");
let desktop, terminalId, token;
const post = async (url, body = {}) => {
  const response = await fetch(base + url, {
    method: "POST",
    headers: { "X-Harbor-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  assert.ok(response.ok, `Fixture API ${url}: ${response.status}`);
  return response.json();
};
try {
  let bootstrap;
  for (let i = 0; i < 100; i++) {
    assert.equal(child.exitCode, null);
    try {
      bootstrap = await (
        await fetch(base + "/api/bootstrap", {
          signal: AbortSignal.timeout(500),
        })
      ).json();
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal(bootstrap?.capabilities.connectionMonitoring, true);
  token = bootstrap.token;
  const terminal = await post("/api/terminals", {
    hostId: "local",
    program: "shell",
  });
  terminalId = terminal.id;
  await writeFile(
    path.join(fixture, "main.cjs"),
    `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(fixture, "profile"))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1200,height:850,webPreferences:{backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadURL('about:blank');});app.on('window-all-closed',()=>app.quit());`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await _electron.launch({
    args: [path.join(fixture, "main.cjs")],
    env,
  });
  const page = await desktop.firstWindow();
  const errors = [],
    input = [],
    connections = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let silent = false;
  let globalStates = 0;
  await page.routeWebSocket("**/ws?*", (socket) => {
    const remote = socket.connectToServer();
    let terminalView = false,
      index = -1;
    socket.onMessage((bytes) => {
      const message = JSON.parse(String(bytes));
      if (
        message.type === "subscribe" &&
        message.terminals?.includes(terminalId)
      ) {
        terminalView = true;
        index = connections.length;
        connections.push({ state: message.state, messages: 0, states: 0 });
      }
      if (message.type === "terminal-input") input.push(message.data);
      remote.send(bytes);
    });
    remote.onMessage((bytes) => {
      const event = JSON.parse(String(bytes));
      if (event.type === "state" && !terminalView) globalStates++;
      if (terminalView) {
        connections[index].messages++;
        if (event.type === "state") connections[index].states++;
        // First connection remains OPEN and sends heartbeats but no replay.
        if (index === 0 && JSON.parse(String(bytes)).type === "terminal-data")
          return;
        // Second fault drops every downstream message without close/error.
        if (silent && index === 1) return;
      }
      socket.send(bytes);
    });
  });
  await page.goto(base + `/?terminal=${terminalId}`);
  await page
    .getByRole("button", { name: "화면 다시 연결", exact: true })
    .waitFor();
  await page.waitForFunction(
    () => !document.querySelector(".terminal-connecting"),
    undefined,
    { timeout: 40000 },
  );
  assert.equal(
    connections.length,
    2,
    "missing replay automatically reconnects the view",
  );
  assert.ok(connections.every((connection) => connection.state === false));
  assert.deepEqual(input, [], "reconnection does not send keyboard input");
  console.log("Missing replay recovered without restarting the terminal: PASS");
  const beforeStates = globalStates;
  const beforeTerminalStates = connections.at(-1).states;
  await post(`/api/terminals/${terminalId}/rename`, {
    title: "Recovery fixture",
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(globalStates > beforeStates, "main view receives state changes");
  assert.equal(
    connections.at(-1).states,
    beforeTerminalStates,
    "terminal views do not receive unused whole-app state updates",
  );
  silent = true;
  await page.waitForFunction(
    () => !!document.querySelector(".terminal-connecting"),
    undefined,
    { timeout: 52000 },
  );
  await page.waitForFunction(
    () => !document.querySelector(".terminal-connecting"),
    undefined,
    { timeout: 15000 },
  );
  assert.equal(
    connections.length,
    3,
    "half-open view reconnects even without a close event",
  );
  const state = await (await fetch(base + "/api/bootstrap")).json();
  assert.equal(state.state.terminals.length, 1);
  assert.equal(state.state.terminals[0].id, terminalId);
  assert.equal(state.state.terminals[0].exited, false);
  assert.deepEqual(input, []);
  const events = (
    await readFile(path.join(fixture, "state/view-connections.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.reason === "replay-timeout"));
  assert.ok(events.some((event) => event.reason === "heartbeat-timeout"));
  assert.ok(events.filter((event) => event.reason === "ready").length >= 2);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(fixture, "recovered.png") });
  console.log(
    "Half-open connection, same live process, no input injection, diagnostic codes: PASS",
  );
} finally {
  await desktop?.close();
  if (terminalId && token)
    await post(`/api/terminals/${terminalId}/close`).catch(() => {});
  if (child.exitCode === null) child.kill();
  await exited;
}
