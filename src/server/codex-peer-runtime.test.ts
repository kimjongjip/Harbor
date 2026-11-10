import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection } from "node:net";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import {
  CodexPeerRuntime,
  codexPeerPrompt,
  codexFailureNotice,
  type CodexCompletedAnswer,
} from "./codex-peer-runtime.js";

const sessionId = "synthetic-codex-session-123";
const token = "synthetic_capability_token_1234567890";
const peer = {
  id: "synthetic-message-1",
  text: "Why did you choose this design?",
  recipientSessionId: sessionId,
  sender: { title: "Architect", hostName: "Synthetic SSH", cwd: "/workspace" },
};

async function fixture(
  options: {
    loaded?: boolean;
    rejectQueue?: boolean;
    fresh?: boolean;
    rejectResume?: boolean;
    displayFailure?: boolean;
    closeQueue?: boolean;
    active?: boolean;
  } = {},
) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let connection: WebSocket | undefined;
  const requests: any[] = [];
  const received: { messageId: string; sessionId: string }[] = [];
  const states: string[] = [];
  const answers: { terminalId: string; answer: CodexCompletedAnswer }[] = [];
  const usages: any[] = [];
  const crews: any[] = [];
  const completed: { terminalId: string; sessionId: string; turnId: string }[] =
    [];
  const failures: { terminalId: string; sessionId: string; notice: string }[] =
    [];
  let hasRollout = !options.fresh;
  server.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    connection = socket;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      requests.push(message);
      if (message.id === undefined || !message.method) return;
      let result: any = {};
      if (
        message.method === "thread/resume" &&
        (!hasRollout || options.rejectResume)
      ) {
        socket.send(
          JSON.stringify({
            id: message.id,
            error: {
              code: -32600,
              message: options.rejectResume
                ? "synthetic resume rejection"
                : `no rollout found for thread id ${sessionId}`,
            },
          }),
        );
        return;
      }
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
            cwd: "/synthetic-primary-project",
            status: { type: options.active ? "active" : "idle" },
          },
        };
      if (message.method === "thread/queue/add") {
        hasRollout = true;
        if (options.closeQueue) {
          socket.close();
          return;
        }
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
    onUsage: (terminalId, usage) => usages.push({ terminalId, usage }),
    onCrew: (terminalId, sessionId, crew) =>
      crews.push({ terminalId, sessionId, crew }),
    connect: async (_id, port) => {
      const stream = createConnection({ host: "127.0.0.1", port });
      await once(stream, "connect");
      return stream;
    },
    onState: (_terminalId, state) => states.push(state),
    onDelivered: (_terminalId, messageId, id) =>
      received.push({ messageId, sessionId: id }),
    onTurnFailed: (terminalId, sessionId, notice) =>
      failures.push({ terminalId, sessionId, notice }),
    onAnswer: (terminalId, answer) => {
      answers.push({ terminalId, answer });
      if (options.displayFailure)
        throw new Error("Synthetic display is unavailable");
    },
    onTurnCompleted: (terminalId, sessionId, turnId) =>
      completed.push({ terminalId, sessionId, turnId }),
  });
  await runtime.attach("fixture-terminal", { port: address.port, token });
  return {
    runtime,
    requests,
    received,
    states,
    failures,
    answers,
    usages,
    crews,
    completed,
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

test("native crew observes only the bound parent, sends no child requests, and resets on session change", async () => {
  const app = await fixture();
  try {
    const requests = app.requests.length;
    const item = {
      type: "subAgentActivity",
      agentThreadId: "child",
      agentPath: "/root/reviewer",
      kind: "started",
    };
    app.notify("item/started", { threadId: "unrelated", item });
    await settle();
    assert.equal(app.crews.length, 0);
    app.notify("item/started", { threadId: sessionId, item });
    await settle();
    assert.equal(app.crews.at(-1).crew.agents[0].state, "working");
    app.notify("thread/tokenUsage/updated", {
      threadId: "child",
      tokenUsage: { total: { totalTokens: 9000 }, last: { totalTokens: 1000 } },
    });
    await settle();
    assert.equal(app.crews.at(-1).crew.agents[0].tokens.total, 9000);
    assert.equal(
      app.usages.length,
      0,
      "child totals never replace primary context usage",
    );
    app.notify("item/completed", {
      threadId: sessionId,
      item: { ...item, kind: "completed" },
    });
    await settle();
    assert.equal(app.crews.at(-1).crew.agents[0].state, "completed");
    assert.equal(
      app.requests.length,
      requests,
      "display telemetry cannot read/resume a child or submit input",
    );
    app.notify("thread/started", {
      thread: { id: "new-primary", source: "cli" },
    });
    app.notify("item/completed", { threadId: sessionId, item });
    app.notify("item/started", {
      threadId: "new-primary",
      item: { ...item, agentThreadId: "new-child" },
    });
    await settle();
    assert.equal(app.crews.at(-1).sessionId, "new-primary");
    assert.deepEqual(
      app.crews.at(-1).crew.agents.map((a: any) => a.id),
      ["new-child"],
    );
    app.runtime.disposeAll();
    assert.equal(
      app.crews.at(-1).crew.source,
      "history",
      "a disconnected child no longer animates as a live state",
    );
  } finally {
    await app.close();
  }
});

test("native context events update only the bound main conversation without sending any input", async () => {
  const app = await fixture();
  try {
    app.runtime.setSession("fixture-terminal", sessionId);
    const before = app.requests.length;
    const tokenUsage = {
      last: { totalTokens: 42000 },
      total: { totalTokens: 8000000 },
      modelContextWindow: 1000000,
    };
    app.notify("thread/tokenUsage/updated", {
      threadId: "child-session",
      tokenUsage,
    });
    app.notify("thread/tokenUsage/updated", {
      threadId: sessionId,
      tokenUsage,
    });
    await settle();
    assert.equal(app.usages.length, 1);
    assert.equal(app.usages[0].usage.usedTokens, 42000);
    assert.equal(app.usages[0].usage.contextWindow, 1000000);
    assert.equal(app.requests.length, before);
  } finally {
    await app.close();
  }
});

test("IDE text enters the exact native conversation FIFO without peer instructions or peer receipts", async () => {
  const app = await fixture({ fresh: true });
  try {
    const input = {
      requestId: "ide-request-1",
      sessionId,
      text: "  사용자 질문\nSecond line  ",
    };
    let checks = 0;
    assert.equal(
      await app.runtime.submitUser("fixture-terminal", input, () => {
        checks++;
      }),
      "queued",
    );
    assert.equal(
      await app.runtime.submitUser("fixture-terminal", input),
      "queued",
    );
    const requests = app.requests.filter(
      (r) => r.method === "thread/queue/add",
    );
    assert.equal(requests.length, 1);
    assert.equal(checks, 1);
    assert.deepEqual(requests[0].params, {
      threadId: sessionId,
      input: [{ type: "text", text: input.text, text_elements: [] }],
      clientUserMessageId: "harbor-ide-ide-request-1",
    });
    app.notify("item/started", {
      threadId: sessionId,
      item: { type: "userMessage", clientId: "harbor-ide-ide-request-1" },
    });
    await settle();
    assert.deepEqual(app.received, []);
  } finally {
    await app.close();
  }
});

test("IDE native queue refuses revoked control and mismatched sessions before queue/add", async () => {
  const app = await fixture();
  try {
    const input = { requestId: "ide-request-1", sessionId, text: "Question" };
    await assert.rejects(
      app.runtime.submitUser("fixture-terminal", {
        ...input,
        sessionId: "other-session",
      }),
    );
    await assert.rejects(
      app.runtime.submitUser("fixture-terminal", input, () => {
        throw new Error("Control revoked");
      }),
    );
    assert.equal(
      app.requests.filter((r) => r.method === "thread/queue/add").length,
      0,
    );
    assert.equal(
      await app.runtime.submitUser("fixture-terminal", input),
      "queued",
    );
  } finally {
    await app.close();
  }
});

test("IDE native queue distinguishes a definite rejection from an uncertain acknowledgement", async () => {
  for (const uncertain of [false, true]) {
    const app = await fixture(
      uncertain ? { closeQueue: true } : { rejectQueue: true },
    );
    try {
      const send = app.runtime.submitUser("fixture-terminal", {
        requestId: "ide-request-1",
        sessionId,
        text: "Question",
      });
      if (uncertain) assert.equal(await send, "uncertain");
      else await assert.rejects(send);
      assert.equal(
        app.requests.filter((r) => r.method === "thread/queue/add").length,
        1,
      );
    } finally {
      await app.close();
    }
  }
});

test("IDE native queue awaits asynchronous authorization and rechecks a replacement native session", async () => {
  const app = await fixture();
  try {
    const input = { requestId: "ide-async-guard", sessionId, text: "Question" };
    await assert.rejects(
      app.runtime.submitUser("fixture-terminal", input, async () => {
        await Promise.resolve();
        throw new Error("Asynchronous authorization revoked");
      }),
      (error: any) => error.definiteRejection === true,
    );
    assert.equal(
      app.requests.filter((r) => r.method === "thread/queue/add").length,
      0,
    );
    assert.equal(
      await app.runtime.submitUser("fixture-terminal", input),
      "queued",
    );
    await assert.rejects(
      app.runtime.submitUser(
        "fixture-terminal",
        { ...input, requestId: "ide-replaced-guard" },
        async () => {
          await Promise.resolve();
          app.notify("thread/started", {
            thread: { id: "different-session", source: "cli" },
          });
          await settle();
        },
      ),
      (error: any) => error.definiteRejection === true,
    );
    assert.equal(
      app.requests.filter((r) => r.method === "thread/queue/add").length,
      1,
    );
  } finally {
    await app.close();
  }
});

test("rejected IDE queue input preserves the native working state", async () => {
  const app = await fixture({ rejectQueue: true, active: true });
  try {
    await assert.rejects(
      app.runtime.submitUser("fixture-terminal", {
        requestId: "ide-request-1",
        sessionId,
        text: "Question",
      }),
    );
    assert.equal(app.states.at(-1), "working");
  } finally {
    await app.close();
  }
});

test("completed display answers use exact authoritative text from only the native primary thread", async () => {
  const app = await fixture();
  try {
    const item = {
      type: "agentMessage",
      id: "answer-1",
      text: "  ## 한글\n\n$$\\frac{a}{b}$$\n",
      phase: "final_answer",
    };
    app.notify("item/started", { threadId: sessionId, item });
    app.notify("item/agentMessage/delta", {
      threadId: sessionId,
      itemId: item.id,
      delta: "unfinished",
    });
    app.notify("item/completed", { threadId: "sibling-thread", item });
    app.notify("thread/started", {
      thread: {
        id: "child-thread",
        parentThreadId: sessionId,
        cwd: "/unrelated",
      },
    });
    app.notify("item/completed", { threadId: "child-thread", item });
    for (const type of ["plan", "reasoning", "userMessage", "commandExecution"])
      app.notify("item/completed", {
        threadId: sessionId,
        item: { ...item, type },
      });
    for (const invalid of [
      { ...item, id: "" },
      { ...item, text: " \n" },
      { ...item, text: "가".repeat(85334) },
      { ...item, text: "x".repeat(128001) },
    ])
      app.notify("item/completed", { threadId: sessionId, item: invalid });
    await settle();
    assert.equal(app.answers.length, 0);
    app.notify("item/completed", { threadId: sessionId, item });
    app.notify("item/completed", { threadId: sessionId, item });
    await settle();
    assert.deepEqual(app.answers, [
      {
        terminalId: "fixture-terminal",
        answer: {
          id: item.id,
          text: item.text,
          sessionId,
          cwd: "/synthetic-primary-project",
          phase: "final_answer",
        },
      },
    ]);
    assert.ok(
      !app.requests.some((r) =>
        ["turn/start", "turn/steer", "thread/queue/add"].includes(r.method),
      ),
    );
    app.notify("thread/started", {
      thread: {
        id: "next-primary",
        cwd: "/next-project",
        source: "cli",
        parentThreadId: null,
      },
    });
    app.notify("item/completed", {
      threadId: sessionId,
      item: { ...item, id: "stale-thread" },
    });
    app.notify("item/completed", { threadId: "next-primary", item });
    await settle();
    assert.equal(app.answers.length, 2);
    assert.equal(app.answers[1].answer.sessionId, "next-primary");
    assert.equal(app.answers[1].answer.cwd, "/next-project");
  } finally {
    await app.close();
  }
});

test("a display callback failure cannot break later authoritative answers or native state updates", async () => {
  const app = await fixture({ displayFailure: true });
  try {
    for (const id of ["answer-A", "answer-B"])
      app.notify("item/completed", {
        threadId: sessionId,
        item: { type: "agentMessage", id, text: "unchanged native answer" },
      });
    app.notify("thread/status/changed", {
      threadId: sessionId,
      status: { type: "active" },
    });
    await settle();
    assert.equal(app.answers.length, 2);
    assert.equal(app.states.at(-1), "working");
    assert.equal(app.runtime.available("fixture-terminal"), true);
  } finally {
    await app.close();
  }
});

test("only a failed turn on the native primary thread raises research failure; retries, approvals and sibling threads do not", async () => {
  const app = await fixture();
  try {
    const error = {
      message:
        "The 'Astra' model is not supported when using Codex with a ChatGPT account. Private token: synthetic-secret",
    };
    app.requestApproval();
    app.notify("error", {
      threadId: sessionId,
      turnId: "retrying",
      willRetry: true,
      error,
    });
    app.notify("turn/completed", {
      threadId: "sibling",
      turn: { id: "wrong", status: "failed", error },
    });
    for (const status of ["completed", "interrupted"])
      app.notify("turn/completed", {
        threadId: sessionId,
        turn: { id: status, status },
      });
    await settle();
    assert.equal(app.failures.length, 0);
    assert.deepEqual(app.completed, [
      { terminalId: "fixture-terminal", sessionId, turnId: "completed" },
    ]);
    app.notify("turn/completed", {
      threadId: "sibling",
      turn: { id: "sibling-complete", status: "completed" },
    });
    app.notify("turn/completed", {
      threadId: sessionId,
      turn: { status: "completed" },
    });
    const params = {
      threadId: sessionId,
      turn: { id: "failed-primary", status: "failed", error },
    };
    app.notify("turn/completed", params);
    app.notify("turn/completed", params);
    await settle();
    assert.equal(app.failures.length, 1);
    assert.equal(app.completed.length, 1);
    assert.equal(app.failures[0].sessionId, sessionId);
    assert.match(app.failures[0].notice, /모델.*실패/);
    assert.doesNotMatch(app.failures[0].notice, /synthetic-secret/);
    assert.ok(!app.requests.some((r) => r.id === "native-approval-1"));
    assert.match(
      codexFailureNotice({
        message: "token-private",
        codexErrorInfo: "UsageLimitExceeded",
      }),
      /한도/,
    );
    assert.match(
      codexFailureNotice({ codexErrorInfo: "Unauthorized" }),
      /인증/,
    );
  } finally {
    await app.close();
  }
});

test("a freshly loaded native thread can receive its first input before a rollout exists", async () => {
  const app = await fixture({ fresh: true });
  try {
    assert.equal(await app.runtime.deliver("fixture-terminal", peer), true);
    await settle();
    assert.equal(
      app.requests.filter((r) => r.method === "thread/queue/add").length,
      1,
    );
    assert.equal(
      app.requests.filter((r) => r.method === "thread/resume").length,
      2,
    );
    assert.deepEqual(app.received, []);
    app.notify("item/started", {
      threadId: sessionId,
      item: { type: "userMessage", clientId: `harbor-peer-${peer.id}` },
    });
    await settle();
    assert.equal(app.received.length, 1);
    assert.equal(await app.runtime.deliver("fixture-terminal", peer), true);
    assert.equal(
      app.requests.filter((r) => r.method === "thread/queue/add").length,
      1,
    );
  } finally {
    await app.close();
  }
});

test("an unrelated resume rejection cannot trigger a first-turn fallback", async () => {
  const app = await fixture({ rejectResume: true });
  try {
    assert.equal(await app.runtime.deliver("fixture-terminal", peer), false);
    assert.equal(
      app.requests.some((r) => r.method === "thread/queue/add"),
      false,
    );
    assert.deepEqual(app.received, []);
  } finally {
    await app.close();
  }
});

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

test("lab peer questions carry current scope while replies stay context rather than another assignment", () => {
  const question = codexPeerPrompt({
    ...peer,
    purpose: "question",
    labId: "fixture-lab",
    questionSource: {
      assignmentId: "fixture-assignment",
      index: 0,
      revision: 3,
    },
  });
  assert.match(question, /harbor_lab_context/);
  assert.match(question, /answer using harbor_reply/);
  assert.match(question, /instead of asking the user/);
  const content = JSON.parse(question.slice(question.indexOf("\n") + 1));
  assert.equal(content.labId, "fixture-lab");
  assert.equal(content.revision, 3);
  const reply = codexPeerPrompt({
    ...peer,
    labId: "fixture-lab",
    replyToId: "fixture-question",
  });
  assert.match(reply, /Do not acknowledge automatically/);
  assert.doesNotMatch(reply, /answer using harbor_reply/);
});
