import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { createServer } from "node:http";
import express from "express";
import ssh2, { type Client, type Connection } from "ssh2";
import type { HostConfig } from "../shared/types.js";
import { TerminalNotices } from "./terminal-notices.js";
import { Terminals as DirectTerminals } from "./terminals.js";
import { AgentBridge } from "./agent-bridge.js";
import { Mailbox } from "./mailbox.js";
import { TerminalAnnotations } from "./terminal-annotations.js";
import {
  DurableRegistry,
  disconnectCategory,
  durableNames,
  durableEnvironmentScript,
  tmuxTarget,
  hostFingerprint,
  checkDurableSession,
  rebootResume,
  type DurableRecord,
} from "./durable-ssh.js";

const { Server, Client: SshClient } = ssh2;
/** Persistence tests explicitly opt into tmux. App defaults use direct SSH. */
class Terminals extends DirectTerminals {
  override create(
    ...[host, cwd, password, options]: Parameters<DirectTerminals["create"]>
  ) {
    return super.create(host, cwd, password, {
      ...options,
      sshSessionMode: "tmux",
    });
  }
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(
  check: () => boolean,
  message = "condition",
  timeout = 8000,
) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw Error(`Timed out: ${message}`);
    await pause(20);
  }
}
const host = {
  id: "fixture",
  name: "Fixture",
  kind: "ssh",
  address: "127.0.0.1",
  username: "fixture",
  port: 22,
  identityFile: "",
  codexPath: "codex",
  defaultCwd: "~",
  mode: "auto",
  color: "#000000",
  createdAt: 0,
} as HostConfig;

test("tmux exact session targets retain the colon required by window-aware commands", () => {
  assert.equal(
    tmuxTarget({ session: "h-00000000-0000-0000-0000-000000000000" }),
    "'=h-00000000-0000-0000-0000-000000000000:'",
  );
});

test("capability updates use private temporary files and never expose tokens in tmux process arguments", () => {
  const bash =
    process.platform === "win32"
      ? "C:/Program Files/Git/bin/bash.exe"
      : "/bin/bash";
  if (!existsSync(bash)) return;
  const unix = (value: string) =>
    value
      .replaceAll("\\", "/")
      .replace(
        /^([A-Za-z]):/,
        (_, letter: string) => `/${letter.toLowerCase()}`,
      );
  const root = resolve(".cache/durable-session-tests");
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "argv-"));
  const secret = "a".repeat(64),
    argv = join(directory, "argv.txt"),
    config = join(directory, "capability.txt");
  try {
    writeFileSync(
      join(directory, "tmux"),
      '#!/bin/bash\nprintf "%s\\n" "$@" >> "$HARBOR_FIXTURE_ARGS"\ncat -- "${@: -1}" > "$HARBOR_FIXTURE_CONFIG"\n',
      { mode: 0o755 },
    );
    const record: DurableRecord = {
      info: { id: "00000000-0000-0000-0000-000000000000" } as any,
      target: hostFingerprint(host),
      ...durableNames("00000000-0000-0000-0000-000000000000"),
      remotePort: 12345,
    };
    const result = spawnSync(bash, ["--noprofile", "--norc", "-s"], {
      windowsHide: true,
      encoding: "utf8",
      input: durableEnvironmentScript(record, "HARBOR_SESSION_TOKEN", secret),
      env: {
        ...process.env,
        PATH: `${unix(directory)}:/usr/bin:/bin`,
        TMPDIR: unix(directory),
        HARBOR_FIXTURE_ARGS: unix(argv),
        HARBOR_FIXTURE_CONFIG: unix(config),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const args = readFileSync(argv, "utf8");
    assert.equal(args.includes(secret), false);
    assert.match(args, /source-file/);
    assert.equal(readFileSync(config, "utf8").includes(secret), true);
    const temporary = args.trim().split("\n").at(-1)!;
    const removed = spawnSync(
      bash,
      ["-c", 'test ! -e "$1"', "fixture", temporary],
      { windowsHide: true },
    );
    assert.equal(removed.status, 0, "private capability temp file is removed");
  } finally {
    assert.ok(directory.startsWith(root));
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Real SSH2 transport; only the remote tmux command executor is simulated. */
async function sshFixture() {
  const connections = new Set<Connection>();
  const forwarding: number[] = [],
    inputs: string[] = [],
    commands: string[] = [];
  let job: ChildProcess | undefined,
    sessions = 0,
    dead = false,
    exitCode = 0,
    missing = false,
    latest: Connection | undefined;
  let bootId = "", systemState = "running", nativeAgy = "";
  let startup = "",
    token = "",
    hookToken = "",
    runtime = "";
  let allowForward = true,
    haveTmux = true;
  let signal = "",
    statusPresent = true;
  let killExecutor: ((command: string) => number) | undefined;
  let checkExecutor:
    ((command: string) => { status: number; output: string }) | undefined;
  const privateKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).privateKey.export({ type: "pkcs1", format: "pem" });
  const server = new Server({ hostKeys: [privateKey] }, (connection) => {
    latest = connection;
    connections.add(connection);
    connection.on("error", () => undefined);
    connection.on("close", () => connections.delete(connection));
    connection.on("authentication", (context) => context.accept());
    connection.on("request", (accept, reject, name, details) => {
      if (name === "tcpip-forward") {
        if (!allowForward) {
          reject?.();
          return;
        }
        const port = details.bindPort || 49151;
        forwarding.push(port);
        accept?.(port);
      } else accept?.();
    });
    connection.on("session", (accept) => {
      const session = accept();
      session.on("pty", (accept) => accept?.());
      session.on("window-change", (accept) => accept?.());
      session.on("exec", (accept, _reject, { command }) => {
        commands.push(command);
        const channel = accept();
        channel.on("error", () => undefined);
        const done = (code: number, output = "") => {
          if (output) channel.write(output);
          channel.exit(code);
          channel.end();
        };
        if (command === "sh -s") {
          let body = "";
          channel.on("data", (chunk: Buffer) => {
            body += chunk;
          });
          channel.on("end", () => {
            if (/-t\s+'=h-[a-f0-9-]+'/.test(body)) {
              channel.stderr.write(
                "no such session: ambiguous bare exact target\n",
              );
              done(1);
              return;
            }
            if (!body.includes("new-session")) {
              runtime =
                body.match(
                  /HARBOR_CODEX_RUNTIME [^A-Za-z0-9+/=]*([A-Za-z0-9+/=]+)/,
                )?.[1] || runtime;
              done(0);
              return;
            }
            startup = body;
            token =
              body.match(
                /set-environment[^\n]+HARBOR_SESSION_TOKEN [^a-f0-9]*([a-f0-9]{64})/,
              )?.[1] || "";
            hookToken =
              body.match(
                /set-environment[^\n]+HARBOR_HOOK_TOKEN [^a-f0-9]*([a-f0-9]{64})/,
              )?.[1] || "";
            sessions++;
            missing = false;
            job = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
              windowsHide: true,
              stdio: "ignore",
            });
            done(0);
          });
        } else if (/-t\s+'=h-[a-f0-9-]+'/.test(command)) done(1);
        else if (
          command.startsWith("command -v tmux") &&
          !command.includes("display-message")
        )
          done(haveTmux ? 0 : 72);
        else if (command.startsWith("python3 -c ") && command.endsWith(" 4321")) done(0,nativeAgy);
        else if (command.startsWith("cat /proc/sys/kernel/random/boot_id")) done(0, bootId);
        else if (command.startsWith("systemctl is-system-running")) done(0,systemState);
        else if (command.includes("display-message")) {
          if (checkExecutor) {
            const result = checkExecutor(command);
            done(result.status, result.output);
          } else
            done(
              missing ? 74 : 0,
              `${dead ? 1 : 0}|${statusPresent ? exitCode : ""}|${signal}\n${bootId ? "/fixture\nHARBOR_BOOT="+bootId+"\n" : ""}`,
            );
        } else if (command.includes("show-environment"))
          done(
            0,
            `HARBOR_SESSION_TOKEN=${token}\nHARBOR_HOOK_TOKEN=${hookToken}\n${runtime ? `HARBOR_CODEX_RUNTIME=${runtime}\n` : ""}`,
          );
        else if (command.includes("kill-session")) {
          if (killExecutor) {
            done(killExecutor(command));
            return;
          }
          job?.kill();
          missing = true;
          done(0);
        } else if (command.includes("attach-session")) {
          channel.write(`FIXTURE PID=${job?.pid}\r\n`);
          channel.on("data", (chunk: Buffer) => inputs.push(chunk.toString()));
        } else if (command.includes("HARBOR_READY_")) {
          const marker = command.match(/HARBOR_READY_[a-f0-9]+/)![0];
          channel.write(`${marker}\n`);
          channel.on("data", (chunk: Buffer) => inputs.push(chunk.toString()));
        } else done(0);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const connect = async () =>
    new Promise<Client>((resolve, reject) => {
      const client = new SshClient();
      client.on("error", reject);
      client.on("ready", () => resolve(client));
      client.connect({
        host: "127.0.0.1",
        port,
        username: "fixture",
        password: "synthetic-not-a-credential",
        hostVerifier: () => true,
      });
    });
  return {
    connect,
    forwarding,
    inputs,
    commands,
    set nativeAgy(id:string){nativeAgy=id;},
    set boot(value:string) {bootId=value;},
    set systemState(value:string) {systemState=value;},
    get startup() {
      return startup;
    },
    get job() {
      return job;
    },
    get sessions() {
      return sessions;
    },
    get latest() {
      return latest!;
    },
    get token() {
      return token;
    },
    get runtime() {
      return runtime;
    },
    set killExecutor(executor: ((command: string) => number) | undefined) {
      killExecutor = executor;
    },
    set checkExecutor(
      executor:
        ((command: string) => { status: number; output: string }) | undefined,
    ) {
      checkExecutor = executor;
    },
    dieUnknown(name?: string) {
      dead = true;
      statusPresent = false;
      signal = name || "";
      job?.kill();
    },
    set haveTmux(value: boolean) {
      haveTmux = value;
    },
    set allowForward(value: boolean) {
      allowForward = value;
    },
    set missing(value: boolean) {
      missing = value;
    },
    die(code: number) {
      dead = true;
      exitCode = code;
      job?.kill();
    },
    disconnect() {
      latest?.end();
    },
    async cleanup() {
      for (const connection of connections) connection.end();
      job?.kill();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test(
  "durable SSH reconnect keeps the same process, native identity, token and reverse port without replaying input",
  { timeout: 30000 },
  async () => {
    const root = resolve(".cache/durable-session-tests");
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "ssh-"));
    const fixture = await sshFixture();
    const expectedToken = "a".repeat(64),
      expectedHook = "b".repeat(64);
    const revoked: string[] = [],
      restored: string[] = [],
      peerRestored: any[] = [];
    let currentBridge!: AgentBridge;
    const app = express();
    app.use("/bridge/mcp", (req, res, next) =>
      currentBridge.handle(req, res, next),
    );
    app.use("/bridge/annotation", (req, res, next) =>
      currentBridge.annotationHandle(req, res, next),
    );
    const bridge = createServer(app);
    await new Promise<void>((resolve) =>
      bridge.listen(0, "127.0.0.1", resolve),
    );
    const bridgePort = (bridge.address() as { port: number }).port;
    const make = () => {
      const terminals = new Terminals({ directory, connect: fixture.connect });
      const mailbox = new Mailbox(directory, {
        terminal: (id) => terminals.list().find((info) => info.id === id),
        host: () => host,
      });
      currentBridge = new AgentBridge(mailbox, {
        terminals: () => terminals.list(),
        host: () => host,
        annotations: new TerminalAnnotations(directory),
      });
      terminals.configureBridge({
        port: bridgePort,
        issue: (id) => {
          const issued = {
            token: expectedToken,
            path: "/bridge/mcp",
            hookToken: expectedHook,
            hookPath: "/bridge/permission",
          };
          currentBridge.restore(id, issued);
          return issued;
        },
        restore: (id, secrets) => {
          assert.equal(secrets.token, expectedToken);
          assert.equal(secrets.hookToken, expectedHook);
          currentBridge.restore(id, secrets);
          restored.push(secrets.token);
        },
        revoke: (id) => {
          currentBridge.revoke(id);
          revoked.push(id);
        },
      });
      terminals.configureRecovery({
        hosts: () => [host],
        password: async () => undefined,
      });
      return terminals;
    };
    let terminals = make();
    try {
      const terminal = await terminals.create(host, "/ignored-start-dir");
      assert.equal(terminal.persistent, true);
      assert.equal(terminal.connectionState, "connected");
      assert.equal(terminal.cwd, "~");
      assert.match(fixture.startup, /set-option[^\n]+ mouse on/);
      const mouseRoutingUpdates = () =>
        fixture.commands.filter((command) =>
          /set-option[^\n]+ mouse on/.test(command),
        ).length;
      assert.equal(
        mouseRoutingUpdates(),
        1,
        "initial attach enables native fullscreen scrolling",
      );
      terminals.markPeerRuntime(terminal.id, {
        kind: "codex",
        state: "idle",
        sessionId: "fixture-native-thread",
        delivery: "automatic",
        endpoint: { port: 12345, token: "endpoint-capability".repeat(3) },
      });
      terminals.markAgentConnected(terminal.id, "codex");
      currentBridge.annotations.markReady(terminal.id, "fixture-native-thread");
      const annotation = currentBridge.annotations.capture(terminal.id, {
        text: "Original draft selection",
        source: {
          title: "Fixture answer",
          hostName: "Fixture",
          cwd: "/fixture",
        },
      });
      currentBridge.annotations.attach(terminal.id, [
        { number: annotation.number, annotation: "Pending user note" },
      ]);
      await until(() => !!fixture.runtime, "private endpoint saved on remote");
      const pid = fixture.job!.pid;
      terminals.write(terminal.id, "before-loss");
      await until(() => fixture.inputs.includes("before-loss"));
      const response = async (
        token = expectedToken,
        path = "/bridge/mcp",
        payload: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" },
      ) =>
        new Promise<string>((resolve, reject) =>
          fixture.latest.forwardOut(
            "127.0.0.1",
            49151,
            "127.0.0.1",
            1,
            (error, stream) => {
              if (error) {
                reject(error);
                return;
              }
              let data = "";
              stream.setEncoding("utf8");
              stream.on("data", (chunk: string) => {
                data += chunk;
              });
              stream.on("error", reject);
              stream.on("end", () => resolve(data));
              const body = JSON.stringify(payload);
              stream.write(
                `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:49151\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
              );
            },
          ),
        );
      assert.match(await response(), /harbor_sessions/);
      assert.match(await response("c".repeat(64)), /401 Unauthorized/);
      fixture.disconnect();
      await until(
        () => terminal.connectionState !== "connected",
        "transport loss state",
      );
      assert.equal(terminal.exited, false);
      assert.equal(revoked.length, 0);
      assert.equal(fixture.job?.pid, pid);
      assert.throws(
        () => terminals.write(terminal.id, "must-not-queue"),
        /자동 재전송하지/,
      );
      await until(
        () => terminal.connectionState === "connected",
        "automatic reconnect",
      );
      assert.equal(fixture.sessions, 1);
      assert.equal(fixture.job?.pid, pid);
      assert.equal(terminal.agentSessionId, "fixture-native-thread");
      assert.equal(
        mouseRoutingUpdates(),
        2,
        "reattach repairs sessions created with mouse off",
      );
      assert.deepEqual(fixture.forwarding, [49151, 49151]);
      assert.equal(
        fixture.inputs.filter((input) => input === "before-loss").length,
        1,
      );
      assert.equal(fixture.inputs.includes("must-not-queue"), false);
      assert.match(await response(), /harbor_sessions/);
      assert.equal(
        restored.length,
        0,
        "transport reconnect does not rotate credentials",
      );
      const stored = readFileSync(
        join(directory, "durable-terminals.json"),
        "utf8",
      );
      assert.equal(stored.includes(expectedToken), false);
      assert.equal(stored.includes("synthetic-not-a-credential"), false);
      assert.equal(
        readFileSync(
          join(directory, "terminal-disconnects.jsonl"),
          "utf8",
        ).includes("before-loss"),
        false,
      );
      await terminals.shutdown();
      assert.equal(fixture.job?.pid, pid);
      assert.equal(revoked.length, 0);
      terminals = make();
      await terminals.restore();
      terminals.on("peer-runtime-restored", (_id, runtime) =>
        peerRestored.push(runtime),
      );
      await until(
        () => terminals.list()[0]?.connectionState === "connected",
        "backend restart restore",
      );
      assert.equal(terminals.list()[0].id, terminal.id);
      assert.equal(terminals.list()[0].agentSessionId, "fixture-native-thread");
      assert.equal(fixture.sessions, 1);
      assert.equal(fixture.job?.pid, pid);
      assert.equal(restored.length, 1);
      assert.equal(
        peerRestored[0]?.endpoint.token,
        "endpoint-capability".repeat(3),
      );
      assert.equal(peerRestored[0]?.sessionId, "fixture-native-thread");
      assert.match(await response(), /harbor_sessions/);
      assert.throws(
        () =>
          currentBridge.restore(terminal.id, {
            token: "d".repeat(64),
            path: "/bridge/mcp",
            hookToken: expectedHook,
            hookPath: "/bridge/permission",
          }),
        /기존 세션/,
      );
      assert.equal(currentBridge.status(terminal.id).connected, true);
      const recovered = await response(expectedHook, "/bridge/annotation", {
        hook_event_name: "UserPromptSubmit",
        session_id: "fixture-native-thread",
        prompt: `${annotation.reference} explain this`,
      });
      assert.match(recovered, /Original draft selection/);
      assert.match(recovered, /Pending user note/);
      const fresh = currentBridge.annotations.capture(terminal.id, {
        text: "New selection",
        source: { title: "New answer", hostName: "Fixture" },
      });
      assert.ok(fresh.number > annotation.number);
      const foreign = await response(expectedHook, "/bridge/annotation", {
        hook_event_name: "UserPromptSubmit",
        session_id: "foreign-native-thread",
        prompt: annotation.reference,
      });
      assert.match(foreign, /"decision":"block"/);
      await terminals.close(terminal.id);
      assert.equal(terminals.list().length, 0);
      assert.deepEqual(revoked, [terminal.id]);
      assert.equal(new DurableRegistry(directory).list().length, 0);
      assert.equal(
        fixture.commands.filter((command) => command.includes("attach-session"))
          .length,
        3,
      );
      assert.equal(
        fixture.commands.some((command) =>
          command.includes("endpoint-capability"),
        ),
        false,
      );
      const bash =
        process.platform === "win32"
          ? "C:/Program Files/Git/bin/bash.exe"
          : "/bin/bash";
      if (existsSync(bash))
        assert.equal(
          spawnSync(bash, ["-n"], {
            input: fixture.startup,
            encoding: "utf8",
            windowsHide: true,
          }).status,
          0,
        );
    } finally {
      await terminals.shutdown();
      await fixture.cleanup();
      await new Promise<void>((resolve) => bridge.close(() => resolve()));
      assert.ok(directory.startsWith(root));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "normal remote shell exit is diagnosed separately and emits its real exit code",
  { timeout: 10000 },
  async () => {
    const fixture = await sshFixture();
    const revoked: string[] = [],
      exits: number[] = [];
    const terminals = new Terminals({
      connect: fixture.connect,
      monitorIntervalMs: 100,
    });
    terminals.configureBridge({
      port: 1,
      issue: () => ({ token: "a".repeat(64), path: "/bridge/mcp" }),
      revoke: (id) => revoked.push(id),
    });
    terminals.on("exit", (_id, code) => exits.push(code));
    try {
      const info = await terminals.create(host, "~");
      terminals.markClaudeEvent(info.id, {
        hook_event_name: "SessionStart",
        session_id: "claude-native-fixture",
      } as any);
      fixture.die(7);
      await until(() => info.exited, "normal shell exit");
      assert.equal(info.connectionState, "exited");
      assert.equal(info.exitCode, 7);
      assert.deepEqual(exits, [7]);
      assert.deepEqual(revoked, [info.id]);
      assert.equal(fixture.sessions, 1);
      await terminals.close(info.id);
    } finally {
      await terminals.shutdown();
      await fixture.cleanup();
    }
  },
);

test(
  "signaled and unknown remote exits are never reported as successful exit zero",
  { timeout: 10000 },
  async () => {
    for (const signal of ["TERM", undefined]) {
      const fixture = await sshFixture(),
        exits: number[] = [];
      const terminals = new Terminals({
        connect: fixture.connect,
        monitorIntervalMs: 100,
      });
      terminals.on("exit", (_id, code) => exits.push(code));
      try {
        const info = await terminals.create(host, "~");
        fixture.dieUnknown(signal);
        await until(() => info.exited, "signaled/unknown exit");
        assert.equal(info.exitCode, -1);
        assert.equal(info.exitSignal, signal);
        assert.deepEqual(exits, [-1]);
        assert.match(
          info.disconnectReason!,
          signal ? /TERM 신호/ : /종료 코드를 확인할 수 없습니다/,
        );
        await terminals.close(info.id);
      } finally {
        await terminals.shutdown();
        await fixture.cleanup();
      }
    }
  },
);

test(
  "tmux kill and has-session permission failures cannot erase a live job from the recovery list",
  { timeout: 12000 },
  async () => {
    const bash =
      process.platform === "win32"
        ? "C:/Program Files/Git/bin/bash.exe"
        : "/bin/bash";
    if (!existsSync(bash)) return;
    const unix = (value: string) =>
      value
        .replaceAll("\\", "/")
        .replace(
          /^([A-Za-z]):/,
          (_, letter: string) => `/${letter.toLowerCase()}`,
        );
    const root = resolve(".cache/durable-session-tests");
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "kill-denied-")),
      fixture = await sshFixture(),
      revoked: string[] = [];
    const terminals = new Terminals({ directory, connect: fixture.connect });
    terminals.configureBridge({
      port: 1,
      issue: () => ({ token: "a".repeat(64), path: "/bridge/mcp" }),
      revoke: (id) => revoked.push(id),
    });
    try {
      const info = await terminals.create(host, "~"),
        pid = fixture.job!.pid;
      const bin = join(directory, "bin");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "tmux"),
        '#!/bin/bash\nprintf "permission denied\\n" >&2\nexit 13\n',
        { mode: 0o755 },
      );
      const environment = {
        ...process.env,
        PATH: `${unix(bin)}:/usr/bin:/bin`,
      };
      // Demonstrate the exact previous shell failure: two denied tmux commands
      // were masked by the unconditional true in the fallback branch.
      assert.equal(
        spawnSync(
          bash,
          [
            "--noprofile",
            "--norc",
            "-c",
            "tmux kill-session || { tmux has-session && exit 1; true; }",
          ],
          { env: environment, windowsHide: true },
        ).status,
        0,
      );
      fixture.killExecutor = (command) =>
        spawnSync(bash, ["--noprofile", "--norc", "-c", command], {
          env: environment,
          windowsHide: true,
        }).status ?? 1;
      await assert.rejects(terminals.close(info.id), /목록을 보존/);
      assert.equal(terminals.list()[0]?.id, info.id);
      assert.equal(info.exited, false);
      assert.equal(new DurableRegistry(directory).list().length, 1);
      assert.equal(fixture.job!.pid, pid);
      assert.equal(fixture.job!.killed, false);
      assert.deepEqual(revoked, []);
      fixture.killExecutor = undefined;
      await terminals.close(info.id);
      assert.equal(terminals.list().length, 0);
      assert.deepEqual(revoked, [info.id]);
    } finally {
      fixture.killExecutor = undefined;
      await terminals.shutdown();
      await fixture.cleanup();
      assert.ok(directory.startsWith(root));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "remote absence and forwarding collision preserve the record and never start a replacement CLI",
  { timeout: 25000 },
  async () => {
    const root = resolve(".cache/durable-session-tests");
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "missing-"));
    const fixture = await sshFixture();
    const terminals = new Terminals({ directory, connect: fixture.connect });
    terminals.configureBridge({
      port: 1,
      issue: () => ({ token: "a".repeat(64), path: "/bridge/mcp" }),
      revoke() {},
    });
    try {
      const info = await terminals.create(host, "~");
      fixture.disconnect();
      await until(() => info.connectionState !== "connected");
      fixture.allowForward = false;
      await assert.rejects(terminals.reconnect(info.id), /TCP forwarding/);
      assert.equal(info.connectionState, "disconnected");
      assert.equal(info.exited, false);
      fixture.allowForward = true;
      fixture.missing = true;
      await assert.rejects(terminals.reconnect(info.id), /유지 세션/);
      assert.equal(info.exited, false);
      assert.equal(fixture.sessions, 1);
      assert.equal(new DurableRegistry(directory).list().length, 1);
      await terminals.close(info.id);
    } finally {
      await terminals.shutdown();
      await fixture.cleanup();
      assert.ok(directory.startsWith(root));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "explicit tmux request fails without tmux and never silently starts an ordinary shell",
  { timeout: 15000 },
  async () => {
    const fixture = await sshFixture();
    fixture.haveTmux = false;
    const terminals = new Terminals({ connect: fixture.connect });
    terminals.configureBridge({
      port: 1,
      issue: () => ({ token: "fixture", path: "/bridge/mcp" }),
      revoke() {},
    });
    try {
      await assert.rejects(terminals.create(host, "~"), /tmux.*bash/);
      assert.equal(fixture.sessions, 0);
      assert.equal(terminals.list().length, 0);
      assert.equal(
        fixture.commands.some((command) => command.includes("HARBOR_READY_")),
        false,
      );
    } finally {
      await terminals.shutdown();
      await fixture.cleanup();
    }
  },
);

test("disconnect classification logs categories rather than raw sensitive messages", () => {
  assert.equal(
    disconnectCategory(
      Object.assign(new Error("private text"), { code: "ECONNRESET" }),
    ),
    "network",
  );
  assert.equal(
    disconnectCategory(
      Object.assign(new Error("private text"), { code: "ETIMEDOUT" }),
    ),
    "timeout",
  );
  assert.equal(
    disconnectCategory({ level: "client-authentication", message: "secret" }),
    "authentication",
  );
});

test(
  "power resume records a sanitized timeline and immediately reconnects the same remote job",
  { timeout: 10000 },
  async () => {
    const root = resolve(".cache/durable-session-tests");
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "resume-")),
      fixture = await sshFixture();
    const terminals = new Terminals({ directory, connect: fixture.connect });
    terminals.configureBridge({
      port: 1,
      issue: () => ({ token: "a".repeat(64), path: "/bridge/mcp" }),
      revoke() {},
    });
    try {
      const info = await terminals.create(host, "~"),
        pid = fixture.job!.pid;
      terminals.powerEvent("suspend", 1000);
      fixture.disconnect();
      await until(() => info.connectionState !== "connected");
      terminals.powerEvent("resume", 2000);
      await until(
        () => info.connectionState === "connected",
        "resume reconnect",
      );
      assert.equal(fixture.sessions, 1);
      assert.equal(fixture.job!.pid, pid);
      const events = readFileSync(
        join(directory, "terminal-disconnects.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.ok(
        events.some(
          (event) =>
            event.category === "power-suspend" &&
            event.at === 1000 &&
            event.terminalId === "system",
        ),
      );
      assert.ok(
        events.some(
          (event) => event.category === "power-resume" && event.at === 2000,
        ),
      );
      assert.ok(events.some((event) => event.state === "reconnecting"));
      assert.ok(events.some((event) => event.state === "connected"));
      assert.ok(
        events.every((event) =>
          Object.keys(event).every((key) =>
            ["at", "terminalId", "category", "attempt", "state"].includes(key),
          ),
        ),
      );
      await terminals.close(info.id);
    } finally {
      await terminals.shutdown();
      await fixture.cleanup();
      assert.ok(directory.startsWith(root));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a corrected reconnect password remains in this terminal's memory for later recovery and close",
  { timeout: 10000 },
  async () => {
    const fixture = await sshFixture(),
      passwords: (string | undefined)[] = [];
    const terminals = new Terminals({
      connect: async (_host, password) => {
        passwords.push(password);
        if (password === "stale-saved-password")
          throw Object.assign(new Error("Authentication failed"), {
            level: "client-authentication",
          });
        return fixture.connect();
      },
    });
    terminals.configureRecovery({
      hosts: () => [host],
      password: async () => "stale-saved-password",
    });
    terminals.configureBridge({
      port: 1,
      issue: () => ({ token: "a".repeat(64), path: "/bridge/mcp" }),
      revoke() {},
    });
    try {
      const info = await terminals.create(host, "~", "first-password");
      fixture.disconnect();
      await until(() => info.connectionState !== "connected");
      await terminals.reconnect(info.id, "corrected-password");
      fixture.disconnect();
      await until(() => info.connectionState !== "connected");
      await until(
        () => info.connectionState === "connected",
        "later automatic reconnect with corrected password",
      );
      fixture.disconnect();
      await until(() => info.connectionState !== "connected");
      await terminals.close(info.id);
      assert.deepEqual(passwords, [
        "first-password",
        "corrected-password",
        "corrected-password",
        "corrected-password",
      ]);
      assert.equal(fixture.sessions, 1);
    } finally {
      await terminals.shutdown();
      await fixture.cleanup();
    }
  },
);

test(
  "failed explicit termination stays visible and changed host targets are never contacted",
  { timeout: 12000 },
  async () => {
    const root = resolve(".cache/durable-session-tests");
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "blocked-"));
    const fixture = await sshFixture();
    let blocked = false,
      connects = 0;
    const connect = async () => {
      connects++;
      if (blocked)
        throw Object.assign(
          new Error("Synthetic private authentication details"),
          { level: "client-authentication" },
        );
      return fixture.connect();
    };
    let terminals = new Terminals({ directory, connect });
    terminals.configureBridge({
      port: 1,
      issue: () => ({ token: "a".repeat(64), path: "/bridge/mcp" }),
      revoke() {},
    });
    try {
      const info = await terminals.create(host, "~");
      fixture.disconnect();
      await until(() => info.connectionState !== "connected");
      blocked = true;
      await assert.rejects(terminals.close(info.id), /목록을 보존/);
      assert.equal(terminals.list().length, 1);
      assert.equal(info.exited, false);
      assert.equal(fixture.sessions, 1);
      await terminals.shutdown();
      const before = connects;
      terminals = new Terminals({ directory, connect });
      terminals.configureRecovery({
        hosts: () => [{ ...host, address: "changed-target.invalid" }],
        password: async () => undefined,
      });
      await terminals.restore();
      assert.equal(connects, before);
      assert.equal(terminals.list().length, 1);
      assert.match(terminals.list()[0].persistenceDetail!, /변경되거나 삭제/);
      assert.equal(new DurableRegistry(directory).list().length, 1);
      assert.equal(
        readFileSync(
          join(directory, "terminal-disconnects.jsonl"),
          "utf8",
        ).includes("private authentication"),
        false,
      );
    } finally {
      await terminals.shutdown();
      await fixture.cleanup();
      assert.ok(directory.startsWith(root));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("a verified missing remote session can be closed without retaining an unusable tab", async () => {
  const root = resolve(".cache/durable-session-tests");
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "gone-")),
    fixture = await sshFixture();
  const terminals = new Terminals({ directory, connect: fixture.connect });
  try {
    const info = await terminals.create(host, "~");
    fixture.job?.kill();
    fixture.missing = true;
    fixture.killExecutor = () => 1;
    await terminals.close(info.id);
    assert.equal(terminals.list().length, 0);
    assert.equal(new DurableRegistry(directory).list().length, 0);
  } finally {
    await terminals.shutdown();
    await fixture.cleanup();
    assert.ok(directory.startsWith(root + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tmux 3.2a parenthesized missing-socket errors are distinct from permissions and can be dismissed", async () => {
  const bash =
    process.platform === "win32"
      ? "C:/Program Files/Git/bin/bash.exe"
      : "/bin/bash";
  if (!existsSync(bash)) return;
  const unix = (value: string) =>
    value
      .replaceAll("\\", "/")
      .replace(
        /^([A-Za-z]):/,
        (_, letter: string) => `/${letter.toLowerCase()}`,
      );
  const root = resolve(".cache/durable-session-tests");
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "missing-socket-")),
    bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "tmux"),
    '#!/bin/bash\nprintf "%s\\n" "$HARBOR_FIXTURE_TMUX_ERROR" >&2\nexit 1\n',
    { mode: 0o755 },
  );
  const cases = [
    [
      "error connecting to /tmp/tmux-1000/harbor-synthetic (No such file or directory)",
      "remote-missing",
    ],
    ["no server running on /tmp/tmux-1000/harbor-synthetic", "remote-missing"],
    [
      "failed to connect to server: No such file or directory",
      "remote-missing",
    ],
    [
      "error connecting to /tmp/tmux-1000/harbor-synthetic (Permission denied)",
      "management",
    ],
    [
      "error connecting to /tmp/tmux-1000/harbor-synthetic (Connection refused)",
      "management",
    ],
    [
      "permission denied reading an unrelated path: No such file or directory",
      "management",
    ],
  ];
  try {
    for (const [message, category] of cases) {
      const fixture = await sshFixture(),
        terminals = new Terminals({ connect: fixture.connect });
      try {
        const info = await terminals.create(host, "~");
        fixture.checkExecutor = (command) => {
          const result = spawnSync(
            bash,
            ["--noprofile", "--norc", "-c", command],
            {
              env: {
                ...process.env,
                PATH: `${unix(bin)}:/usr/bin:/bin`,
                HARBOR_FIXTURE_TMUX_ERROR: message,
              },
              encoding: "utf8",
              windowsHide: true,
            },
          );
          return { status: result.status ?? 1, output: result.stdout || "" };
        };
        const record = {
          info,
          target: hostFingerprint(host),
          ...durableNames(info.id),
          remotePort: 0,
        };
        await assert.rejects(
          checkDurableSession(await fixture.connect(), record),
          (error) => disconnectCategory(error) === category,
        );
        fixture.killExecutor = () => 1;
        if (category === "remote-missing") {
          await terminals.close(info.id);
          assert.equal(terminals.list().length, 0);
        } else {
          await assert.rejects(terminals.close(info.id), /목록을 보존/);
          assert.equal(terminals.list().length, 1);
          assert.equal(fixture.job?.killed, false);
        }
      } finally {
        fixture.checkExecutor = undefined;
        fixture.killExecutor = undefined;
        await terminals.shutdown();
        await fixture.cleanup();
      }
    }
  } finally {
    assert.ok(directory.startsWith(root + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "a transient failed close keeps the same job and resumes automatic reconnect",
  { timeout: 10000 },
  async () => {
    const fixture = await sshFixture(),
      terminals = new Terminals({ connect: fixture.connect });
    try {
      const info = await terminals.create(host, "~"),
        pid = fixture.job!.pid;
      fixture.killExecutor = () => 13;
      await assert.rejects(terminals.close(info.id), /목록을 보존/);
      assert.equal(info.connectionState, "disconnected");
      assert.equal(info.connectionIssue, "management");
      await until(
        () => info.connectionState === "connected",
        "reconnect after unsuccessful close",
      );
      assert.equal(info.connectionIssue, undefined);
      assert.equal(fixture.job!.pid, pid);
      assert.equal(fixture.sessions, 1);
      assert.deepEqual(fixture.inputs, []);
    } finally {
      fixture.killExecutor = undefined;
      await terminals.shutdown();
      await fixture.cleanup();
    }
  },
);

test("a tmux shell tracks the agy lock in its own pane and forgets it on exit", async () => {
  const fixture = await sshFixture(),
    app = new Terminals({ connect: fixture.connect, monitorIntervalMs: 100 });
  let command = "agy";
  fixture.checkExecutor = () => ({
    status: 0,
    output: "0||\nHARBOR_FOREGROUND=4321|" + command + "\n/fixture\n",
  });
  const id = "f0000000-0000-4000-8000-000000000001";
  fixture.nativeAgy = id;
  try {
    const t = await app.create(host, "/fixture", "fixture");
    assert.equal(t.agentKind, "antigravity");
    assert.equal(t.nativeAgySessionId, id);
    fixture.nativeAgy = "f0000000-0000-4000-8000-000000000002";
    await until(() => t.agentSessionId !== id);
    assert.equal(t.agentSessionId, "f0000000-0000-4000-8000-000000000002");
    command = "bash";
    await until(() => !t.nativeAgySessionId);
    assert.equal(t.agentKind, undefined);
    assert.deepEqual(fixture.inputs, []);
  } finally {
    await app.shutdown();
    await fixture.cleanup();
  }
});

test("reboot recovery needs a different verified boot and the provider's exact saved ID", () => {
  const first = "11111111-1234-4321-8000-123456789abc",
    second = "22222222-1234-4321-8000-123456789abc";
  const record = { bootId: first } as DurableRecord;
  for (const [provider, program] of [
    ["claude", "claude-resume"],
    ["codex", "resume"],
    ["antigravity", "antigravity-cli"],
  ] as const) {
    const info = {
      agentKind: provider,
      agentSessionId: first,
    } as DurableRecord["info"];
    assert.deepEqual(rebootResume(record, info, second), {
      program,
      id: first,
    });
    assert.equal(rebootResume(record, info, first), undefined);
    assert.equal(rebootResume(record, info, undefined), undefined);
    assert.equal(
      rebootResume({ ...record, bootId: undefined }, info, second),
      undefined,
    );
    assert.equal(
      rebootResume(record, { ...info, agentSessionId: "" }, second),
      undefined,
    );
  }
});
test("server reboot results share a single notification across tabs and SSH retries", () => {
  const notices = new TerminalNotices();
  notices.reboot("a", "Compiler", "boot", "tab1", "opening");
  const notification = notices.list()[0];
  notices.read("tab1");
  notices.reboot("a", "Compiler", "boot", "tab2", "ready");
  notices.reboot("a", "Compiler", "boot", "tab1", "ready");
  notices.reboot("a", "Compiler", "boot", "tab1", "ready");
  const [updated] = notices.list();
  assert.equal(notices.list().length, 1);
  assert.equal(updated.id, notification.id);
  assert.equal(updated.read, true);
  assert.match(updated.body, /대화 2개/);
  notices.reboot("a", "Compiler", "new-boot", "tab1", "failed");
  assert.equal(notices.list().length, 2);
});

test("a running Harbor automatically replaces its lost tmux pane after a reboot, once", async () => {
  const fixture = await sshFixture();
  const directory = mkdtempSync(join(resolve(".cache"), "boot-live-"));
  const app = new Terminals({ directory, connect: fixture.connect });
  const native = "89abcdef-1234-4321-8000-123456789abc";
  const results: string[] = [];
  app.on("host-reboot", (_host, _name, _boot, _tab, outcome) =>
    results.push(outcome),
  );
  app.configureBridge({
    port: 1,
    issue: () => ({ token: "a".repeat(64), path: "/bridge/mcp" }),
    revoke() {},
  });
  try {
    fixture.boot = "11111111-1234-4321-8000-123456789abc";
    const tab = await app.create(host, "/fixture", "fixture");
    app.markPeerRuntime(tab.id, {
      kind: "codex",
      sessionId: native,
      state: "idle",
      delivery: "automatic",
    });
    fixture.job?.kill();
    fixture.missing = true;
    fixture.boot = "22222222-1234-4321-8000-123456789abc";
    fixture.disconnect();
    await until(
      () => fixture.sessions === 2 && tab.connectionState === "connected",
      "automatic re-creation",
    );
    assert.deepEqual(
      app.list().map((t) => t.id),
      [tab.id],
    );
    const encoded = fixture.startup.match(
      /printf '%s' '([A-Za-z0-9+/=]+)'/,
    )![1];
    const script = Buffer.from(encoded, "base64").toString();
    assert.match(script, /codex resume /);
    assert.ok(script.includes(native));
    assert.ok(script.includes("/fixture"));
    assert.equal(fixture.inputs.length, 0);
    assert.deepEqual(results, ["opening"]);
    app.markPeerRuntime(tab.id, {
      kind: "codex",
      sessionId: native,
      state: "idle",
      delivery: "automatic",
    });
    assert.deepEqual(results, ["opening", "ready"]);
  } finally {
    await app.shutdown();
    await fixture.cleanup();
  }
});

test("restore a Claude tab by exact native ID after server reboot while Harbor was closed", async () => {
  const fixture = await sshFixture();
  const directory = mkdtempSync(join(resolve(".cache"), "boot-recovery-"));
  const native = "01234567-1234-4321-8000-123456789abc";
  const make = () => {
    const app = new Terminals({ directory, connect: fixture.connect });
    app.configureRecovery({
      hosts: () => [host],
      password: async () => "fixture",
    });
    return app;
  };
  let app = make();
  try {
    fixture.boot = "11111111-1234-4321-8000-123456789abc";
    const info = await app.create(host, "/fixture", "fixture");
    app.markPeerRuntime(info.id, {
      kind: "claude",
      state: "idle",
      sessionId: native,
      delivery: "automatic",
    });
    app.write(info.id, "old-experiment-command");
    await until(() => fixture.inputs.includes("old-experiment-command"));
    assert.equal(
      new DurableRegistry(directory).list()[0].bootId,
      "11111111-1234-4321-8000-123456789abc",
    );
    fixture.systemState="stopping";
    app.markAgentState(info.id,"shell");
    await until(()=>new DurableRegistry(directory).list()[0]?.shutdownConversation?.id===native,"identity retained on confirmed OS shutdown");
    fixture.systemState="running";
    await app.shutdown();
    fixture.missing = true;
    fixture.job?.kill();
    fixture.boot = "22222222-1234-4321-8000-123456789abc";
    app = make();
    await app.restore();
    await until(
      () =>
        app
          .list()
          .some((t) => t.id === info.id && t.connectionState === "connected"),
      "reboot recovery",
    );
    assert.equal(fixture.sessions, 2);
    const encoded = fixture.startup.match(
      /printf '%s' '([A-Za-z0-9+/=]+)'/,
    )![1];
    const launch = Buffer.from(encoded, "base64").toString();
    assert.match(launch, /claude.*--resume/);
    assert.ok(launch.includes(native));
    assert.ok(!launch.includes("old-experiment-command"));
    assert.equal(
      new DurableRegistry(directory).list()[0].bootId,
      "22222222-1234-4321-8000-123456789abc",
    );
    fixture.disconnect();
    await until(() => app.list()[0]?.connectionState !== "connected");
    await app.reconnect(info.id);
    assert.equal(fixture.sessions, 2);
    // A manual tmux kill on the same boot is terminal even after another reboot.
    fixture.missing = true;
    fixture.job?.kill();
    fixture.disconnect();
    await until(() => app.list()[0]?.connectionState !== "connected");
    await assert.rejects(app.reconnect(info.id), /tmux|세션/);
    assert.equal(new DurableRegistry(directory).list()[0].bootId, undefined);
    fixture.boot = "33333333-1234-4321-8000-123456789abc";
    await assert.rejects(app.reconnect(info.id), /tmux|세션/);
    assert.equal(fixture.sessions, 2);
  } finally {
    await app.shutdown();
    await fixture.cleanup();
  }
});
