import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { EventEmitter } from "node:events";
import { allowedHost, allowedOrigin, validToken } from "./security.js";
import {
  shellQuote,
  sshArgs,
  processCommand,
  remoteCodexCommand,
} from "./ssh.js";
import {
  normalizeItem,
  appendDelta,
  upsertItem,
  transcriptContext,
} from "./session.js";
import { Store } from "./store.js";
import { Hub } from "./hub.js";
import type { SessionView } from "../shared/types.js";

function fixture(t: any) {
  const parent = resolve(".cache/tests");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "run-"));
  const store = new Store(directory);
  const hub = new Hub(store);
  t.after(() => {
    hub.shutdown();
    if (resolve(directory).startsWith(parent + sep))
      rmSync(directory, { recursive: true, force: true });
  });
  return { store, hub };
}
function session(hub: Hub, threadId: string, hostId = "local") {
  const s: SessionView = {
    id: `${hostId}:${threadId}`,
    hostId,
    threadId,
    title: threadId,
    cwd: process.cwd(),
    model: "",
    permission: "workspace-write",
    createdAt: 1,
    updatedAt: 1,
    status: "idle",
    preview: "",
    loaded: true,
    items: [],
    approvals: [],
  };
  hub.sessions.set(s.id, s);
  return s;
}
class FakeClient extends EventEmitter {
  alive = true;
  calls: { method: string; params: any }[] = [];
  replies: any[] = [];
  sequence = 0;
  handler?: (method: string, params: any) => any;
  async call(method: string, params: any) {
    this.calls.push({ method, params });
    return this.handler
      ? this.handler(method, params)
      : { turn: { id: `turn-${++this.sequence}` } };
  }
  respond(id: any, result: any) {
    this.replies.push({ id, result });
  }
  stop() {
    this.alive = false;
  }
}
function bind(hub: Hub, hostId = "local") {
  const client = new FakeClient();
  hub.clients.set(hostId, client as any);
  hub.host(hostId).status = "connected";
  return client;
}
function notify(hub: Hub, hostId: string, method: string, params: any) {
  (hub as any).notification(hostId, { method, params });
}
async function until(check: () => boolean, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for state transition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("loopback API rejects DNS rebinding, foreign origins and missing tokens", () => {
  assert.equal(allowedHost("localhost:4317", 4317), true);
  for (const host of [
    "evil.example:4317",
    "127.0.0.1.evil.example:4317",
    "localhost:4318",
    undefined,
  ])
    assert.equal(allowedHost(host, 4317), false);
  assert.equal(allowedOrigin("http://127.0.0.1:4317", 4317), true);
  for (const origin of [
    "https://evil.example",
    "null",
    "http://localhost:4317.evil.example",
    "http://localhost:4318",
  ])
    assert.equal(allowedOrigin(origin, 4317), false);
  assert.equal(validToken("abc", "abc"), true);
  for (const token of [null, ["abc"], "ab", "abd"])
    assert.equal(validToken(token, "abc"), false);
});
test("SSH preserves aliases and quotes paths without interpreting shell input", (t) => {
  const { store } = fixture(t);
  const host = {
    ...store.data.hosts[0],
    kind: "ssh" as const,
    address: "build-server",
    username: "user",
    codexPath: "/home/user/a'b/$(whoami)/codex",
  };
  const args = sshArgs(host);
  assert.equal(args.includes("-p"), false);
  assert.ok(args.includes("StrictHostKeyChecking=yes"));
  assert.deepEqual(args.slice(-2), ["--", "build-server"]);
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.equal(
    processCommand(host, false).args.at(-1)!,
    remoteCodexCommand(host, ["app-server", "--listen", "stdio://"]),
  );
  for (const address of ["-oProxyCommand=x", "host;whoami", "a\nb"])
    assert.throws(() => sshArgs({ ...host, address }));
  assert.throws(() => shellQuote("folder\ncommand"));
  assert.deepEqual(sshArgs({ ...host, port: 2222 }).slice(-6), [
    "-p",
    "2222",
    "-l",
    "user",
    "--",
    "build-server",
  ]);
});
test("interleaved streaming updates remain in the correct session and final output replaces deltas", (t) => {
  const { hub } = fixture(t);
  const a = session(hub, "a"),
    b = session(hub, "b");
  appendDelta(a, { itemId: "same", turnId: "ta", delta: "안" });
  appendDelta(b, { itemId: "same", turnId: "tb", delta: "hello" });
  appendDelta(a, { itemId: "same", turnId: "ta", delta: "녕" });
  assert.equal(a.items[0].text, "안녕");
  assert.equal(b.items[0].text, "hello");
  upsertItem(
    a,
    normalizeItem(
      {
        id: "same",
        type: "agentMessage",
        text: "안녕하세요",
        phase: "final_answer",
      },
      "ta",
    )!,
  );
  assert.equal(a.items.length, 1);
  assert.equal(a.items[0].text, "안녕하세요");
  assert.equal(
    normalizeItem({ id: "hidden", type: "reasoning", text: "private" }),
    null,
  );
  const context = transcriptContext(a);
  assert.match(context, /작업 경로:/);
  assert.match(context, /참고용/);
  assert.match(context, /자동으로 이전된 것은 아닙니다/);
  assert.match(context, /안녕하세요/);
  assert.doesNotMatch(context, /hello|private/);
});
test("completed notifications received before turn/start response cannot leave a session running", async (t) => {
  const { hub } = fixture(t);
  const s = session(hub, "fast");
  const client = bind(hub);
  client.handler = async (method, params) => {
    assert.equal(method, "turn/start");
    notify(hub, "local", "turn/started", {
      threadId: params.threadId,
      turn: { id: "fast-turn" },
    });
    notify(hub, "local", "turn/completed", {
      threadId: params.threadId,
      turn: { id: "fast-turn", status: "completed" },
    });
    return { turn: { id: "fast-turn" } };
  };
  await hub.send(s.id, "test");
  assert.equal(s.status, "idle");
  assert.equal(s.activeTurnId, undefined);
});
test("approval replies are scoped to their host and session; pending approval survives turn response", async (t) => {
  const { hub } = fixture(t);
  const a = session(hub, "a"),
    b = session(hub, "b");
  const client = bind(hub);
  client.handler = (_method, params) => {
    (hub as any).request("local", client, {
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { threadId: params.threadId, command: "test" },
    });
    return { turn: { id: "waiting-turn" } };
  };
  await hub.send(a.id, "test");
  assert.equal(a.status, "waiting");
  assert.throws(() => hub.answer(b.id, "local:7", { approved: true }));
  assert.equal(client.replies.length, 0);
  hub.answer(a.id, "local:7", { approved: false });
  assert.deepEqual(client.replies, [
    { id: 7, result: { decision: "decline" } },
  ]);
  assert.equal(a.approvals.length, 0);
  assert.throws(() => hub.answer(a.id, "local:7", { approved: true }));
});
test("duplicate sends, busy transfers, and self-transfers cannot launch overlapping turns", async (t) => {
  const { hub } = fixture(t);
  const a = session(hub, "a"),
    b = session(hub, "b");
  const client = bind(hub);
  let release!: (value: any) => void;
  client.handler = () =>
    new Promise((r) => {
      release = r;
    });
  const first = hub.send(a.id, "one");
  await until(() => Boolean(release));
  await assert.rejects(hub.send(a.id, "two"), /보내는 중/);
  release({ turn: { id: "one" } });
  await first;
  await assert.rejects(
    hub.transfer(b.id, a.id, "context", "context"),
    /작업 중/,
  );
  await assert.rejects(
    hub.transfer(a.id, a.id, "context", "context"),
    /다른 대상/,
  );
  assert.equal(client.calls.length, 1);
});
test("three-step discussion relays actual answers across hosts and restores session permissions afterwards", async (t) => {
  const { hub, store } = fixture(t);
  const remote = hub.addHost({
    ...store.data.hosts[0],
    name: "Remote",
    kind: "ssh",
    address: "test-host",
  });
  const a = session(hub, "a"),
    b = session(hub, "b", remote.id);
  const local = bind(hub),
    other = bind(hub, remote.id);
  const order: string[] = [];
  for (const [hostId, client] of [
    ["local", local],
    [remote.id, other],
  ] as const)
    client.handler = (method, params) => {
      if (method !== "turn/start") return {};
      order.push(params.threadId);
      const id = `turn-${order.length}`;
      setTimeout(() => {
        notify(hub, hostId, "item/completed", {
          threadId: params.threadId,
          turnId: id,
          item: {
            id: `item-${id}`,
            type: "agentMessage",
            text: `verified-answer-${order.length}`,
          },
        });
        notify(hub, hostId, "turn/completed", {
          threadId: params.threadId,
          turn: { id, status: "completed" },
        });
      }, 2);
      return { turn: { id } };
    };
  const job = await hub.startDiscussion([a.id, b.id], "review");
  await assert.rejects(hub.send(a.id, "concurrent"), /토론/);
  await until(() => job.status !== "running");
  assert.equal(job.status, "completed");
  assert.deepEqual(order, ["a", "b", "a"]);
  assert.equal(job.steps.length, 3);
  assert.match(other.calls[0].params.input[0].text, /verified-answer-1/);
  assert.match(local.calls[1].params.input[0].text, /verified-answer-2/);
  for (const call of [...local.calls, ...other.calls])
    assert.deepEqual(call.params.sandboxPolicy, { type: "readOnly" });
  assert.equal(a.jobId, undefined);
  assert.equal(b.jobId, undefined);
  await hub.send(a.id, "normal");
  assert.equal(local.calls.at(-1)!.params.sandboxPolicy.type, "workspaceWrite");
  await until(() => a.status === "idle");
});
test("discussion cancellation before turn creation still interrupts the late turn and unlocks both sessions", async (t) => {
  const { hub } = fixture(t);
  const a = session(hub, "a"),
    b = session(hub, "b");
  const client = bind(hub);
  let release!: (value: any) => void;
  client.handler = (method) =>
    method === "turn/start"
      ? new Promise((r) => {
          release = r;
        })
      : {};
  const job = await hub.startDiscussion([a.id, b.id], "review");
  await until(() => Boolean(release));
  hub.cancelDiscussion(job.id);
  release({ turn: { id: "late-turn" } });
  await until(() => client.calls.some((c) => c.method === "turn/interrupt"));
  assert.equal(job.status, "cancelled");
  assert.equal(a.jobId, undefined);
  assert.equal(b.jobId, undefined);
  assert.equal(client.calls.filter((c) => c.method === "turn/start").length, 1);
});
test("persisted state survives restart without passwords, and interrupted discussions keep completed steps", (t) => {
  const { store, hub } = fixture(t);
  const s = session(hub, "persistent");
  hub.saveSession(s);
  hub.passwords.set("local", "temporary-test-secret");
  store.data.discussions.push({
    id: "job",
    topic: "topic",
    sessionIds: ["a", "b"],
    status: "running",
    steps: [{ sessionId: "a", label: "first", text: "kept answer" }],
    createdAt: 1,
  });
  store.save();
  const restored = new Store(store.directory);
  assert.equal(restored.data.sessions[0].threadId, "persistent");
  assert.equal(restored.data.discussions[0].status, "failed");
  assert.equal(restored.data.discussions[0].steps[0].text, "kept answer");
  assert.doesNotMatch(
    readFileSync(store.file, "utf8"),
    /temporary-test-secret/,
  );
  writeFileSync(store.file, "{invalid");
  assert.throws(() => new Store(store.directory));
  assert.equal(readFileSync(store.file, "utf8"), "{invalid");
});
