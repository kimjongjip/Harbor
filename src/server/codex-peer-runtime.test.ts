import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection } from "node:net";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { CodexPeerRuntime, codexPeerPrompt } from "./codex-peer-runtime.js";

const sessionId = "synthetic-codex-session-123";
const token = "synthetic_capability_token_1234567890";
const peer = {
  id: "synthetic-message-1",
  text: "Why did you choose this design?",
  recipientSessionId: sessionId,
  sender: { title: "Architect", hostName: "Synthetic SSH", cwd: "/workspace" },
};

async function fixture(
  options: { loaded?: boolean; rejectQueue?: boolean } = {},
) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let connection: WebSocket | undefined;
  const requests: any[] = [];
  const received: { messageId: string; sessionId: string }[] = [];
  const states: string[] = [];
  server.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    connection = socket;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      requests.push(message);
      if (message.id === undefined || !message.method) return;
      let result: any = {};
      if (message.method === "thread/loaded/list")
        result = { data: options.loaded === false ? [] : [sessionId] };
      if (
        message.method === "thread/read" ||
        message.method === "thread/resume"
      )
        result = {
          thread: {
            id: message.params.threadId,
            source: "cli",
            parentThreadId: null,
            status: { type: "idle" },
          },
        };
      if (message.method === "thread/queue/add") {
        if (options.rejectQueue) {
          socket.send(
            JSON.stringify({
              id: message.id,
              error: { code: -32601, message: "unsupported queue" },
            }),
          );
          return;
        }
        result = {
          queuedSubmission: { id: "native-queue-1", ...message.params },
        };
      }
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  const runtime = new CodexPeerRuntime({
    connect: async (_id, port) => {
      const stream = createConnection({ host: "127.0.0.1", port });
      await once(stream, "connect");
      return stream;
    },
    onState: (_terminalId, state) => states.push(state),
    onDelivered: (_terminalId, messageId, id) =>
      received.push({ messageId, sessionId: id }),
  });
  await runtime.attach("fixture-terminal", { port: address.port, token });
  return {
    runtime,
    requests,
    received,
    states,
    notify(method: string, params: any) {
      assert.ok(connection);
      connection.send(JSON.stringify({ method, params }));
    },
    requestApproval() {
      assert.ok(connection);
      connection.send(
        JSON.stringify({
          id: "native-approval-1",
          method: "item/commandExecution/requestApproval",
          params: { threadId: sessionId },
        }),
      );
    },
    async close() {
      runtime.disposeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

test("peer input enters the native FIFO once and is acknowledged only when its own native item starts", async () => {
  const app = await fixture();
  try {
    app.notify("thread/status/changed", {
      threadId: sessionId,
      status: { type: "active", activeFlags: [] },
    });
    await settle();
    assert.equal(await app.runtime.deliver("fixture-terminal", peer), true);
    assert.equal(await app.runtime.deliver("fixture-terminal", peer), true);
    const queued = app.requests.filter(
      (request) => request.method === "thread/queue/add",
    );
    assert.equal(queued.length, 1);
    assert.equal(queued[0].params.threadId, sessionId);
    assert.equal(
      queued[0].params.clientUserMessageId,
      `harbor-peer-${peer.id}`,
    );
    assert.equal(
      app.received.length,
      0,
      "Native queue acceptance is not agent receipt.",
    );
    assert.equal(
      app.requests.some((request) =>
        [
          "turn/start",
          "turn/steer",
          "turn/interrupt",
          "thread/queue/start",
        ].includes(request.method),
      ),
      false,
    );
    app.notify("item/started", {
      threadId: "another-session",
      item: { type: "userMessage", clientId: `harbor-peer-${peer.id}` },
    });
    app.notify("item/started", {
      threadId: sessionId,
      item: { type: "userMessage", clientId: "ordinary-user-input" },
    });
    await settle();
    assert.equal(app.received.length, 0);
    app.notify("item/started", {
      threadId: sessionId,
      item: { type: "userMessage", clientId: `harbor-peer-${peer.id}` },
    });
    app.notify("item/completed", {
      threadId: sessionId,
      item: { type: "userMessage", clientId: `harbor-peer-${peer.id}` },
    });
    await settle();
    assert.deepEqual(app.received, [{ messageId: peer.id, sessionId }]);
    assert.ok(app.states.includes("working"));
  } finally {
    await app.close();
  }
});

test("a resumed or replaced native conversation cannot receive a message addressed to the old context", async () => {
  const app = await fixture();
  try {
    app.notify("thread/started", {
      thread: {
        id: "replacement-session-456",
        source: "cli",
        parentThreadId: null,
      },
    });
    await settle();
    assert.equal(await app.runtime.deliver("fixture-terminal", peer), false);
    assert.equal(
      app.requests.some((request) => request.method === "thread/queue/add"),
      false,
    );
    app.notify("item/started", {
      threadId: sessionId,
      item: { type: "userMessage", clientId: `harbor-peer-${peer.id}` },
    });
    await settle();
    assert.deepEqual(app.received, []);
  } finally {
    await app.close();
  }
});

test("a thread with no saved rollout waits for its native session handshake", async () => {
  const app = await fixture({ loaded: false });
  try {
    assert.equal(app.runtime.available("fixture-terminal"), false);
    assert.equal(await app.runtime.deliver("fixture-terminal", peer), false);
    app.runtime.setSession("fixture-terminal", sessionId);
    assert.equal(app.runtime.available("fixture-terminal"), true);
    assert.equal(await app.runtime.deliver("fixture-terminal", peer), true);
  } finally {
    await app.close();
  }
});

test("native execution approvals stay with the native TUI and never receive a peer-controller response", async () => {
  const app = await fixture();
  try {
    app.requestApproval();
    await settle();
    assert.equal(
      app.requests.some((message) => message.id === "native-approval-1"),
      false,
    );
  } finally {
    await app.close();
  }
});

test("an inherited subagent hook cannot replace the primary native TUI conversation", async () => {
  const app = await fixture();
  try {
    app.runtime.setSession("fixture-terminal", "synthetic-child-session-789");
    app.notify("thread/started", {
      thread: {
        id: "synthetic-child-session-789",
        source: { subAgent: "custom" },
        parentThreadId: sessionId,
      },
    });
    await settle();
    assert.equal(await app.runtime.deliver("fixture-terminal", peer), true);
    const queued = app.requests.find(
      (request) => request.method === "thread/queue/add",
    );
    assert.equal(queued.params.threadId, sessionId);
  } finally {
    await app.close();
  }
});

test("ephemeral title generation cannot replace a TUI thread whose saved origin was noninteractive exec", async () => {
  const app = await fixture();
  try {
    const resumedId = "resumed-exec-history-session";
    app.notify("thread/started", {
      thread: {
        id: resumedId,
        source: "exec",
        parentThreadId: null,
        ephemeral: false,
        threadSource: "user",
      },
    });
    app.notify("thread/started", {
      thread: {
        id: "native-auto-title-session",
        source: "vscode",
        parentThreadId: null,
        ephemeral: true,
        threadSource: "thread_title",
      },
    });
    await settle();
    assert.equal(app.runtime.currentSession("fixture-terminal"), resumedId);
    assert.equal(
      await app.runtime.deliver("fixture-terminal", {
        ...peer,
        recipientSessionId: resumedId,
      }),
      true,
    );
    const queued = app.requests.find(
      (request) => request.method === "thread/queue/add",
    );
    assert.equal(queued.params.threadId, resumedId);
  } finally {
    await app.close();
  }
});

test("closing a terminal while its SSH socket is connecting cannot resurrect an obsolete runtime", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let connected!: () => void;
  const connectionReady = new Promise<void>((resolve) => {
    connected = resolve;
  });
  let stream: ReturnType<typeof createConnection> | undefined;
  const states: string[] = [];
  const runtime = new CodexPeerRuntime({
    connect: async (_id, port) => {
      stream = createConnection({ host: "127.0.0.1", port });
      await once(stream, "connect");
      connected();
      await gate;
      return stream;
    },
    onState: (_id, state) => states.push(state),
  });
  const attaching = runtime.attach("fixture-terminal", {
    port: address.port,
    token,
  });
  await connectionReady;
  runtime.dispose("fixture-terminal");
  release();
  await assert.rejects(attaching, /superseded/);
  assert.equal(stream?.destroyed, true);
  assert.equal(runtime.available("fixture-terminal"), false);
  assert.deepEqual(states, []);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("unsupported native queuing leaves the message pending without a false receipt", async () => {
  const app = await fixture({ rejectQueue: true });
  try {
    assert.equal(await app.runtime.deliver("fixture-terminal", peer), false);
    assert.deepEqual(app.received, []);
  } finally {
    await app.close();
  }
});

test("peer replies return as task context without demanding another automatic reply", () => {
  const prompt = codexPeerPrompt({ ...peer, replyToId: "original-question" });
  assert.match(prompt, /Use the reply as context for your original task/);
  assert.match(prompt, /Do not send an automatic acknowledgement/);
  assert.doesNotMatch(prompt, /using the harbor_reply tool/);
  assert.deepEqual(JSON.parse(prompt.slice(prompt.indexOf("\n") + 1)), {
    messageId: peer.id,
    replyToId: "original-question",
    from: peer.sender,
    text: peer.text,
  });
});
