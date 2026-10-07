import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import express from "express";
import { Mailbox } from "./mailbox.js";
import { AgentBridge } from "./agent-bridge.js";
import { PeerDelivery } from "./peer-delivery.js";
import type { TerminalInfo } from "../shared/types.js";

async function fixture(t: any) {
  const parent = resolve(".cache/peer-delivery-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "run-"));
  const terminals: TerminalInfo[] = [
    {
      id: "a",
      title: "Codex UI",
      hostId: "local",
      cwd: "C:/fixture/ui",
      exited: false,
      agentKind: "codex",
    },
    {
      id: "b",
      title: "Claude compiler",
      hostId: "ssh-fixture",
      cwd: "/fixture/compiler",
      exited: false,
      agentKind: "claude",
    },
    {
      id: "c",
      title: "Codex review",
      hostId: "ssh-fixture",
      cwd: "/fixture/review",
      exited: false,
      agentKind: "codex",
    },
  ];
  const resolver = {
    terminal: (id: string) => terminals.find((item) => item.id === id),
    host: (id: string) => ({
      id,
      name: id === "local" ? "Fixture PC" : "Fixture SSH",
    }),
  };
  const mailbox = new Mailbox(directory, resolver);
  const peers = new PeerDelivery(mailbox);
  const bind = (id: string, sessionId: string) =>
    peers.setRuntime(id, {
      kind: id === "b" ? "claude" : "codex",
      sessionId,
      state: "idle",
      delivery: "automatic",
    });
  bind("a", "native-a");
  bind("b", "native-b");
  bind("c", "native-c");
  t.after(async () => {
    if (resolve(directory).startsWith(parent + sep))
      await rm(directory, { recursive: true, force: true });
  });
  return { mailbox, peers, terminals, resolver, bind, directory };
}

test("a transport offer is distinct from model receipt and bound to the original native conversation", async (t) => {
  const { mailbox, peers, bind, directory, resolver } = await fixture(t);
  const question = peers.send(
    "a",
    "b",
    "Why did you choose this compiler strategy?",
    "question",
  );
  assert.equal(question.recipient.sessionId, "native-b");
  assert.equal(peers.events("b", "native-b").messages[0].id, question.id);
  assert.equal(peers.events("b", "other-thread").messages.length, 0);
  assert.throws(() => peers.ack("c", question.id, "native-c"), /받은 메시지/);
  const offered = peers.ack("b", question.id, "native-b");
  assert.ok(offered.offeredAt);
  assert.equal(offered.status, "queued");
  assert.equal(offered.consumedAt, undefined);
  assert.equal(peers.events("b", "native-b").messages.length, 0);
  assert.equal(
    new Mailbox(directory, resolver).find(question.id)?.offeredAt,
    offered.offeredAt,
  );
  bind("b", "new-native-b");
  assert.throws(() => peers.ack("b", question.id, "native-b"), /현재 네이티브/);
  assert.equal(mailbox.consume("b", { sessionId: "new-native-b" }).length, 0);
  assert.throws(
    () =>
      mailbox.replyAgent("b", question.id, "unrelated answer", "new-native-b"),
    /네이티브 대화/,
  );
  assert.equal(peers.result("a", question.id).status, "unavailable");
  bind("b", "native-b");
  const reply = mailbox.replyAgent(
    "b",
    question.id,
    "Because the existing build requires it.",
    "native-b",
  );
  assert.ok(mailbox.find(question.id)?.consumedAt);
  const result = peers.result("a", question.id);
  assert.equal(result.status, "answered");
  assert.equal(result.reply?.id, reply.id);
  assert.equal(result.reply?.text, "Because the existing build requires it.");
  assert.ok(result.reply?.consumedAt);
  assert.throws(() => peers.result("c", question.id), /보낸 질문/);
});

test("bounded waits deliver only the real correlated reply once and avoid cross-ask deadlock", async (t) => {
  const { mailbox, peers } = await fixture(t);
  const question = peers.send("a", "b", "Why use a queue?", "question");
  const waiting = peers.wait("a", question.id, 1000);
  const crossQuestion = peers.send(
    "b",
    "a",
    "Which queue do you mean?",
    "question",
  );
  const started = Date.now();
  const crossResult = await peers.wait("b", crossQuestion.id, 1000);
  assert.equal(crossResult.status, "pending");
  assert.ok(Date.now() - started < 500);
  const reply = mailbox.replyAgent(
    "b",
    question.id,
    "To preserve the user's active turn.",
    "native-b",
  );
  // While the sender tool is waiting, the native controller must not also start a reply turn.
  assert.equal(
    peers.events("a", "native-a").messages.some((item) => item.id === reply.id),
    false,
  );
  const result = await waiting;
  assert.equal(result.reply?.id, reply.id);
  assert.ok(result.reply?.consumedAt);
  assert.equal(
    peers.events("a", "native-a").messages.some((item) => item.id === reply.id),
    false,
  );
  assert.throws(
    () => mailbox.replyAgent("b", question.id, "duplicate answer", "native-b"),
    /이미 답장/,
  );
  const pending = peers.send("a", "b", "A pending question", "question");
  const abort = new AbortController();
  const cancelledWait = peers.wait("a", pending.id, 50000, abort.signal);
  abort.abort();
  assert.equal((await cancelledWait).status, "pending");
  assert.equal(mailbox.find(pending.id)?.consumedAt, undefined);
  await assert.rejects(peers.wait("a", pending.id, 50001));
});

test("unbound messages are never guessed into a new conversation; old questions do not cap new threads", async (t) => {
  const { peers, mailbox, bind } = await fixture(t);
  peers.setRuntime("b", {
    kind: "claude",
    state: "idle",
    delivery: "automatic",
  });
  const unbound = peers.send(
    "a",
    "b",
    "Sent before Claude identified its conversation.",
    "question",
  );
  bind("b", "new-thread");
  assert.equal(peers.events("b", "new-thread").messages.length, 0);
  assert.throws(
    () => peers.ack("b", unbound.id, "new-thread"),
    /네이티브 대화/,
  );
  assert.equal(
    mailbox.consume("b", { sessionId: "new-thread" })[0].id,
    unbound.id,
  );
  for (let index = 0; index < 7; index++)
    peers.send("a", "b", `old question ${index}`, "question");
  assert.throws(
    () => peers.send("a", "b", "ninth question", "question"),
    /먼저 보낸/,
  );
  bind("a", "new-native-a");
  assert.equal(
    peers.send("a", "b", "New thread can ask.", "question").sender.sessionId,
    "new-native-a",
  );
});

test("native event long polling observes exact messages and remains scoped on thread changes", async (t) => {
  const { peers } = await fixture(t);
  const waiting = peers.poll("b", "native-b", 1000);
  const message = peers.send(
    "a",
    "b",
    "Please explain this change.",
    "question",
  );
  assert.equal((await waiting).messages[0].id, message.id);
  peers.ack("b", message.id, "native-b");
  const oldThread = peers.poll("b", "native-b", 1000);
  peers.setRuntime("b", {
    kind: "claude",
    sessionId: "new-b",
    state: "idle",
    delivery: "automatic",
  });
  assert.match((await oldThread).reason!, /changed/);
  const abort = new AbortController();
  const abandoned = peers.poll("b", "new-b", 25000, abort.signal);
  abort.abort();
  assert.equal((await abandoned).messages.length, 0);
});

test("managed child hooks and first or repeat MCP handshakes cannot steal the parent native binding", async (t) => {
  const { mailbox, terminals, resolver } = await fixture(t);
  const bridge = new AgentBridge(mailbox, {
    terminals: () => terminals,
    host: resolver.host,
    acceptCodexSession: (_id, sessionId) => sessionId === "native-parent",
  });
  const issued = bridge.issue("a");
  const app = express();
  app.use("/mcp", bridge.handle);
  app.use("/annotation", bridge.annotationHandle);
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (path: string, token: string, body: unknown) =>
    (
      await fetch(base + path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      })
    ).json();
  const init = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "codex", version: "0.160.1" } },
  };
  await post("/annotation", issued.hookToken, {
    hook_event_name: "SessionStart",
    session_id: "native-parent",
  });
  const reference = bridge.annotations.capture("a", {
    text: "Parent selection",
    source: { hostName: "fixture", title: "parent" },
  });
  bridge.annotations.attach("a", [
    { number: reference.number, annotation: "Parent question" },
  ]);
  // SessionStart or the primary control connection can precede MCP startup.
  await post("/mcp", issued.token, init);
  const afterHandshake = bridge.annotations.capture("a", {
    text: "Selection before the next native prompt",
    source: { hostName: "fixture", title: "parent" },
  });
  assert.throws(
    () =>
      bridge.annotations.resolve("a", afterHandshake.reference, "native-child"),
    /대화|세션/,
  );
  await post("/mcp", issued.token, { ...init, id: 2 });
  await post("/annotation", issued.hookToken, {
    hook_event_name: "SessionStart",
    session_id: "native-child",
  });
  assert.equal(bridge.peers.runtime("a")?.sessionId, "native-parent");
  assert.deepEqual(
    await post("/annotation", issued.hookToken, {
      hook_event_name: "UserPromptSubmit",
      session_id: "native-child",
      prompt: reference.reference,
    }),
    {},
  );
  assert.throws(
    () => bridge.annotations.resolve("a", reference.reference, "native-child"),
    /대화|세션/,
  );
  assert.equal(
    bridge.annotations.resolve("a", reference.reference, "native-parent")
      ?.annotations[0].annotation,
    "Parent question",
  );
});

test("scoped HTTP MCP asks Claude by name, correlates its actual reply, and never exposes runtime tokens", async (t) => {
  const { mailbox, terminals, resolver } = await fixture(t);
  const connected: string[] = [];
  const runtimeCallbacks: any[] = [];
  const bridge = new AgentBridge(mailbox, {
    terminals: () => terminals,
    host: resolver.host,
    onConnected: (id, kind) => connected.push(`${id}:${kind}`),
    onPeerRuntime: (id, runtime) => runtimeCallbacks.push({ id, runtime }),
  });
  const a = bridge.issue("a"),
    b = bridge.issue("b"),
    c = bridge.issue("c");
  const app = express();
  app.use("/bridge/mcp", bridge.handle);
  app.use("/bridge/peers", bridge.peerHandle);
  app.use("/bridge/claude", bridge.claudeHandle);
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (path: string, token: string, body: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  let sequence = 0;
  const rpc = async (token: string, method: string, params: unknown = {}) =>
    (
      await post("/bridge/mcp", token, {
        jsonrpc: "2.0",
        id: ++sequence,
        method,
        params,
      })
    ).json() as Promise<any>;
  const call = async (token: string, name: string, args: unknown = {}) => {
    const response = await rpc(token, "tools/call", { name, arguments: args });
    return {
      error: response.result.isError,
      data: response.result.isError
        ? response.result.content[0].text
        : JSON.parse(response.result.content[0].text),
    };
  };
  const endpointToken = "f".repeat(64);
  const runtimeResponse = await post("/bridge/peers/runtime", a.token, {
    kind: "codex",
    sessionId: "native-a",
    state: "idle",
    delivery: "automatic",
    endpoint: { port: 4500, token: endpointToken },
  });
  assert.equal(runtimeResponse.status, 200);
  assert.equal(
    JSON.stringify(await runtimeResponse.json()).includes(endpointToken),
    false,
  );
  assert.equal(runtimeCallbacks[0].runtime.endpoint.token, endpointToken);
  await post("/bridge/claude", b.hookToken, {
    hook_event_name: "SessionStart",
    session_id: "native-b",
  });
  await post("/bridge/peers/runtime", b.token, {
    kind: "claude",
    state: "idle",
    delivery: "automatic",
  });
  await rpc(b.token, "initialize", {
    protocolVersion: "2025-06-18",
    clientInfo: { name: "harbor-claude-adapter", version: "1.0.0" },
  });
  assert.deepEqual(connected, ["b:claude"]);
  const discovery = (await call(a.token, "harbor_sessions")).data;
  assert.equal(discovery.sessions[1].kind, "claude");
  assert.equal(discovery.sessions[1].runtime.sessionId, "native-b");
  const question = (
    await call(a.token, "harbor_ask", {
      to: "Claude compiler",
      question: "Why select this representation?",
      waitMs: 0,
    })
  ).data.request;
  assert.equal(question.status, "pending");
  const getEvents = (
    token: string,
    query = "sessionId=native-b&waitMs=0",
    headers = {},
  ) =>
    fetch(base + "/bridge/peers/events?" + query, {
      headers: { Authorization: `Bearer ${token}`, ...headers },
    });
  assert.equal((await getEvents(a.token)).status, 200);
  const events = (await (await getEvents(b.token)).json()) as any;
  assert.equal(events.sessionId, "native-b");
  assert.equal(events.messages[0].id, question.requestId);
  assert.equal(
    (
      await post("/bridge/peers/ack", c.token, {
        messageId: question.requestId,
        sessionId: "native-b",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await post("/bridge/peers/ack", b.token, {
        messageId: question.requestId,
        sessionId: "native-b",
      })
    ).status,
    200,
  );
  assert.equal(mailbox.find(question.requestId)?.consumedAt, undefined);
  const reply = await call(b.token, "harbor_reply", {
    messageId: question.requestId,
    text: "It follows our existing compiler data layout.",
  });
  assert.equal(reply.error, false);
  const answer = (
    await call(a.token, "harbor_ask_result", {
      requestId: question.requestId,
      waitMs: 0,
    })
  ).data.request;
  assert.equal(answer.status, "answered");
  assert.equal(answer.reply.sender.sessionId, "native-b");
  assert.equal(
    answer.reply.text,
    "It follows our existing compiler data layout.",
  );
  assert.ok(answer.reply.consumedAt);
  await post("/bridge/peers/runtime", a.token, {
    kind: "codex",
    sessionId: "new-native-a",
    state: "idle",
    delivery: "automatic",
  });
  assert.equal(
    (
      await call(a.token, "harbor_ask_result", {
        requestId: question.requestId,
        waitMs: 0,
      })
    ).error,
    true,
  );
  assert.equal(
    (
      await call(c.token, "harbor_ask_result", {
        requestId: question.requestId,
        waitMs: 0,
      })
    ).error,
    true,
  );
  assert.equal(JSON.stringify(mailbox.list()).includes(endpointToken), false);
  assert.equal(
    (await getEvents(b.token, undefined, { Origin: "https://fixture.invalid" }))
      .status,
    403,
  );
  assert.equal((await getEvents("0".repeat(64))).status, 401);
  await post("/bridge/claude", b.hookToken, {
    hook_event_name: "SessionEnd",
    session_id: "native-b",
  });
  await post("/bridge/peers/runtime", b.token, {
    kind: "claude",
    state: "idle",
    delivery: "automatic",
  });
  assert.equal(bridge.peers.runtime("b")?.state, "offline");
  await post("/bridge/claude", b.hookToken, {
    hook_event_name: "SessionStart",
    session_id: "new-native-b",
  });
  await post("/bridge/claude", b.hookToken, {
    hook_event_name: "UserPromptSubmit",
    session_id: "new-native-b",
    prompt: "Continue working.",
  });
  await post("/bridge/peers/runtime", b.token, {
    kind: "claude",
    state: "idle",
    delivery: "automatic",
  });
  assert.equal(bridge.peers.runtime("b")?.state, "working");
  await post("/bridge/claude", b.hookToken, {
    hook_event_name: "SessionEnd",
    session_id: "native-b",
  });
  assert.equal(bridge.peers.runtime("b")?.sessionId, "new-native-b");
  assert.equal(bridge.peers.runtime("b")?.state, "working");
  const posixRuntime = await post("/bridge/peers/runtime", a.token, {
    kind: "codex",
    sessionId: "new-native-a",
    state: "idle",
    delivery: "automatic",
    endpoint: { port: 4500, token: "Ab_cD-12".repeat(6) },
  });
  assert.equal(posixRuntime.status, 200);
  for (const endpoint of [
    { port: 0, token: endpointToken },
    { port: 70000, token: endpointToken },
    { port: 4500, token: "unsafe token" },
  ])
    assert.equal(
      (
        await post("/bridge/peers/runtime", a.token, {
          kind: "codex",
          state: "idle",
          delivery: "automatic",
          endpoint,
        })
      ).status,
      400,
    );
});
