import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import ssh2, { type Client, type Connection, type ServerChannel } from "ssh2";
import { Terminals } from "./terminals.js";
import { safeSshErrorDetails, DurableRegistry } from "./durable-ssh.js";
import type { HostConfig } from "../shared/types.js";

const host: HostConfig = {
  id: "direct-ssh-fixture",
  name: "Direct SSH fixture",
  kind: "ssh",
  address: "fixture.invalid",
  username: "fixture",
  port: 22,
  identityFile: "",
  codexPath: "codex",
  defaultCwd: "/unused",
  mode: "auto",
  color: "#123456",
  createdAt: 0,
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await pause(30);
  }
  throw Error("SSH fixture condition timed out");
}
async function fixture() {
  const privateKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).privateKey.export({ type: "pkcs1", format: "pem" });
  const peers = new Set<Connection>();
  const commands: string[] = [],
    inputs: string[] = [];
  let latest: Connection, shell: ServerChannel, client: Client;
  let forwardAllowed = true;
  const server = new ssh2.Server({ hostKeys: [privateKey] }, (peer) => {
    latest = peer;
    peers.add(peer);
    peer.on("error", () => undefined);
    peer.on("close", () => peers.delete(peer));
    peer.on("authentication", (context) => context.accept());
    peer.on("request", (accept, reject, name) => {
      if (name === "tcpip-forward") {
        if (forwardAllowed) accept?.(49151);
        else reject?.();
      } else accept?.();
    });
    peer.on("session", (accept) => {
      const session = accept();
      session.on("pty", (accept) => accept?.());
      session.on("window-change", (accept) => accept?.());
      session.on("exec", (accept, _reject, { command }) => {
        commands.push(command);
        shell = accept();
        shell.on("error", () => undefined);
        shell.on("data", (data: Buffer) => {
          inputs.push(data.toString());
          shell.write("INPUT_RECEIVED\r\n");
        });
        const marker = command.match(/HARBOR_READY_[a-f0-9]+/);
        shell.write(marker ? marker[0] + "\n" : "DIRECT_SSH_READY\r\n");
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const connect = async () =>
    new Promise<Client>((resolve, reject) => {
      client = new ssh2.Client();
      client.on("error", reject);
      client.once("ready", () => resolve(client));
      client.connect({
        host: "127.0.0.1",
        port,
        username: "fixture",
        password: "synthetic-fixture",
        hostVerifier: () => true,
      });
    });
  return {
    connect,
    commands,
    inputs,
    get client() {
      return client;
    },
    set forwardAllowed(value: boolean) {
      forwardAllowed = value;
    },
    exit(code: number) {
      shell.exit(code);
      shell.end();
    },
    drop() {
      latest.end();
    },
    async cleanup() {
      for (const peer of peers) peer.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("new SSH terminals use direct SSH without checking or launching tmux and preserve real exit status", async () => {
  const ssh = await fixture(),
    terminals = new Terminals({ connect: ssh.connect });
  let exits = 0;
  terminals.on("exit", () => exits++);
  try {
    const info = await terminals.create(host, "/ignored-project");
    assert.equal(info.cwd, "~");
    assert.equal(info.persistent, false);
    await until(() => terminals.buffer(info.id).includes("DIRECT_SSH_READY"));
    terminals.write(info.id, "synthetic input");
    await until(() => ssh.inputs.length > 0);
    assert.equal(ssh.commands.length, 1);
    assert.equal(
      ssh.commands.some((command) =>
        /tmux|new-session|attach-session/.test(command),
      ),
      false,
    );
    ssh.exit(7);
    await until(() => info.exited === true);
    assert.equal(info.exitCode, 7);
    assert.equal(info.connectionIssue, "remote-exit");
    await pause(70);
    assert.equal(exits, 1);
    await terminals.close(info.id);
    assert.equal(terminals.list().length, 0);
  } finally {
    await terminals.shutdown();
    await ssh.cleanup();
  }
});

test("tmux is SSH-only and a failed managed connection never falls back to an ordinary terminal", async () => {
  let attempts = 0;
  const terminals = new Terminals({
    connect: async () => {
      attempts++;
      throw new Error("synthetic connection failure");
    },
  });
  try {
    await assert.rejects(
      terminals.create({ ...host, kind: "local" }, "~", undefined, {
        sshSessionMode: "tmux",
      }),
      /SSH 서버에서만/,
    );
    assert.equal(attempts, 0);
    await assert.rejects(
      terminals.create(host, "~", undefined, { sshSessionMode: "tmux" }),
      /synthetic connection failure/,
    );
    assert.equal(attempts, 1);
    assert.equal(terminals.list().length, 0);
  } finally {
    await terminals.shutdown();
  }
});

test("SSH disconnect without remote exit is unknown status, emits once and remains immediately closable", async () => {
  const ssh = await fixture(),
    terminals = new Terminals({ connect: ssh.connect });
  let exits = 0;
  terminals.on("exit", () => exits++);
  try {
    const info = await terminals.create(host, "~");
    ssh.drop();
    await until(() => info.exited === true);
    assert.equal(info.exitCode, -1);
    assert.equal(info.connectionIssue, "transport");
    assert.match(info.disconnectReason!, /종료 여부는 확인되지/);
    await pause(100);
    assert.equal(exits, 1);
    assert.equal(
      ssh.commands.length,
      1,
      "never starts a replacement shell automatically",
    );
    await terminals.close(info.id);
    assert.equal(terminals.list().length, 0);
  } finally {
    await terminals.shutdown();
    await ssh.cleanup();
  }
});

test("direct SSH preserves Harbor hooks without tmux and still rejects unintegrated research", async () => {
  const ssh = await fixture(),
    terminals = new Terminals({ connect: ssh.connect });
  terminals.configureBridge({
    port: 1,
    issue: () => ({ token: "synthetic-token", path: "/bridge/mcp" }),
    revoke() {},
  });
  try {
    const info = await terminals.create(host, "~");
    await until(() => info.integration === "ready");
    assert.equal(info.persistent, false);
    assert.ok(ssh.inputs.join("").includes("synthetic-token"));
    assert.equal(
      ssh.commands.some((command) => command.includes("tmux")),
      false,
    );
    await terminals.close(info.id);
    ssh.forwardAllowed = false;
    await assert.rejects(
      terminals.create(host, "~", undefined, {
        program: "codex",
        researchLaunch: { cwd: "/synthetic/project", effort: "low" },
      }),
      /TCP forwarding/,
    );
    assert.equal(ssh.commands.length, 1, "no unmanaged research launch");
  } finally {
    await terminals.shutdown();
    await ssh.cleanup();
  }
});

test("SSH error diagnostics retain safe reason codes without messages, addresses or credentials", async () => {
  const root = resolve(".cache/direct-ssh-tests");
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "diagnostics-"));
  const ssh = await fixture(),
    terminals = new Terminals({ directory, connect: ssh.connect });
  try {
    const info = await terminals.create(host, "~");
    const privateMessage = "private-server-address password=do-not-log";
    ssh.client.emit(
      "error",
      Object.assign(new Error(privateMessage), {
        code: "ECONNRESET",
        level: "client-socket",
      }),
    );
    await until(() => info.exited === true);
    assert.equal(info.connectionIssue, "network");
    assert.equal(info.exitCode, -1);
    const journal = readFileSync(
      join(directory, "terminal-disconnects.jsonl"),
      "utf8",
    );
    const events = journal
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(
      events.some(
        (event) =>
          event.source === "ssh-error" &&
          event.code === "ECONNRESET" &&
          event.level === "client-socket",
      ),
    );
    assert.equal(journal.includes(privateMessage), false);
    assert.equal(journal.includes(host.address), false);
    assert.deepEqual(new DurableRegistry(directory).list(), []);
    assert.deepEqual(
      safeSshErrorDetails({
        code: privateMessage,
        level: privateMessage,
        message: privateMessage,
      }),
      {},
    );
    await terminals.close(info.id);
    assert.equal(terminals.list().length, 0);
  } finally {
    await terminals.shutdown();
    await ssh.cleanup();
    assert.ok(directory.startsWith(root + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
