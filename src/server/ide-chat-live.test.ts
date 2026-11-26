import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import type { HostConfig, TerminalInfo } from "../shared/types.js";
import type { HistoryDetail } from "../shared/history.js";
import { IdeLiveChats } from "./ide-chat-live.js";
import {
  IdeChats,
  createIdeChatRouter,
  type IdeChatDependencies,
  type IdeChatAuthorization,
} from "./ide-chat.js";

const host: HostConfig = {
  id: "host",
  name: "Host",
  kind: "local",
  address: "",
  username: "",
  port: 22,
  identityFile: "",
  codexPath: "codex",
  defaultCwd: "~",
  mode: "isolated",
  color: "blue",
  createdAt: 0,
};
const noop = () => {};
function harness(provider: "codex" | "claude" = "codex") {
  const terminal: TerminalInfo = {
    id: "terminal",
    hostId: host.id,
    cwd: "/project",
    title: "Existing CLI",
    exited: false,
    connectionState: "connected",
    agentKind: provider,
    agentSessionId: "native-session",
    agentConnected: true,
    agentState: "working",
    peerDelivery: "automatic",
  };
  let now = 1000,
    reads = 0,
    channel = true,
    native = true;
  let cacheScope = "initial-account";
  let fail: Error | undefined;
  let beforeNative: (() => Promise<void>) | undefined;
  let readWait: Promise<void> | undefined;
  const sent: {
    provider: string;
    requestId: string;
    sessionId: string;
    text: string;
  }[] = [];
  const page: HistoryDetail = {
    thread: {
      id: "native-session",
      hostId: host.id,
      provider,
      title: "Native conversation",
      cwd: "/native-project",
      preview: "",
      updatedAt: 1,
      source: "test",
      active: true,
    },
    items: [
      { id: "q1", kind: "user", text: "Old question" },
      { id: "a1", kind: "assistant", text: "Old answer" },
    ],
    nextCursor: "older",
  };
  const readHistory = async (
    _hostId: string,
    _provider: string,
    _nativeId: string,
    cursor?: string,
  ): Promise<HistoryDetail> => {
    reads++;
    await readWait;
    if (fail) throw fail;
    return structuredClone(
      cursor
        ? {
            ...page,
            items: [{ id: "q0", kind: "user", text: "First question" }],
            nextCursor: null,
          }
        : page,
    );
  };
  const live = new IdeLiveChats({
    cacheScope: () => cacheScope,
    now: () => now,
    terminals: () => [terminal],
    terminal: (id) => (id === terminal.id ? terminal : undefined),
    readHistory,
    codex: {
      available: () => native,
      currentSession: () => terminal.agentSessionId,
      async submitUser(_id, input, guard) {
        await beforeNative?.();
        await guard?.();
        sent.push({ provider: "codex", ...input });
        return "queued";
      },
    },
    claude: {
      available: () => channel,
      async send(_id, input, guard) {
        await beforeNative?.();
        await guard();
        sent.push({ provider: "claude", ...input });
        return "queued";
      },
    },
  });
  const forbidden = () => {
    throw new Error(
      "A second native process must never be created for a live CLI",
    );
  };
  const dependencies: IdeChatDependencies = {
    runtimeId: "runtime",
    host: () => host,
    hub: new Proxy(
      { on: noop, off: noop },
      { get: (target, key) => target[key as keyof typeof target] || forbidden },
    ) as unknown as IdeChatDependencies["hub"],
    resolveCwd: forbidden,
    password: forbidden,
    claude: forbidden,
    historyList: async () => ({ data: [], nextCursor: null }),
    historyRead: readHistory,
    nativeActive: () => !terminal.exited,
    live,
  };
  const chats = new IdeChats(dependencies);
  const open = () =>
    chats.create(
      {
        hostId: host.id,
        provider,
        resumeId: page.thread.id,
        requestId: randomUUID(),
      },
      "desktop",
      noop,
    );
  return {
    terminal,
    page,
    live,
    chats,
    dependencies,
    sent,
    open,
    reads: () => reads,
    tick: () => (now += 2100),
    channel: (value: boolean) => (channel = value),
    native: (value: boolean) => (native = value),
    cacheScope: (value: string) => (cacheScope = value),
    fail: (error?: Error) => (fail = error),
    beforeNative: (callback: () => Promise<void>) => (beforeNative = callback),
    waitRead: (wait?: Promise<void>) => (readWait = wait),
  };
}

for (const provider of ["codex", "claude"] as const) {
  test(`existing working ${provider} opens directly as native history without restarting or a competing writer`, async () => {
    const h = harness(provider);
    const view = await h.open();
    assert.equal(view.nativeId, h.terminal.agentSessionId);
    assert.equal(view.live?.terminalId, h.terminal.id);
    assert.equal(view.status, "running");
    assert.equal(view.items[1].text, "Old answer");
    assert.equal(view.cwd, "/native-project");
    assert.equal((await h.open()).id, view.id);
    assert.equal(
      h.reads(),
      1,
      "native history is shared and cached for rapid UI polls",
    );
    assert.equal(h.sent.length, 0);
    h.chats.close();
    assert.equal(h.terminal.exited, false);
  });
}

test("live reads coalesce, refresh native saved blocks, and preserve older loaded history", async () => {
  const h = harness();
  const view = await h.open();
  await h.chats.older(view.id, view.runtimeId, noop);
  assert.equal(h.chats.snapshot(view.id).items[0].id, "q0");
  assert.equal(h.chats.snapshot(view.id).historyCursor, null);
  h.page.items.push({ id: "a2", kind: "assistant", text: "New saved answer" });
  h.tick();
  let release!: () => void;
  h.waitRead(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const first = h.chats.read(view.id, noop),
    second = h.chats.read(view.id, noop);
  release();
  const pages = await Promise.all([first, second]);
  assert.equal(h.reads(), 3);
  for (const page of pages) {
    assert.deepEqual(
      page.items.map((item) => item.id),
      ["q0", "q1", "a1", "a2"],
    );
    assert.equal(page.historyCursor, null);
  }
  h.fail(new Error("SSH temporarily unavailable"));
  h.tick();
  const cached = await h.chats.read(view.id, noop);
  assert.match(cached.error!, /SSH temporarily/);
  assert.equal(cached.items.at(-1)?.text, "New saved answer");
  await h.chats.read(view.id, noop);
  assert.equal(h.reads(), 4, "transient errors also have backoff");
  h.fail();
  h.tick();
  assert.equal((await h.chats.read(view.id, noop)).error, undefined);
});

test("oversized history notices preserve readable live messages across head refresh and older pages", async () => {
  const h = harness("claude");
  const notice =
    "An oversized record was omitted; other messages remain readable.";
  h.page.notice = notice;
  try {
    const view = await h.open();
    assert.equal(view.historyNotice, notice);
    assert.equal(view.error, undefined);
    assert.deepEqual(
      view.items.map((item) => item.text),
      ["Old question", "Old answer"],
    );
    delete h.page.notice;
    h.page.items.push({
      id: "a2",
      kind: "assistant",
      text: "New saved answer",
    });
    h.tick();
    const refreshed = await h.chats.read(view.id, noop);
    assert.equal(refreshed.historyNotice, notice);
    assert.equal(refreshed.items.at(-1)?.text, "New saved answer");
    const older = await h.chats.older(view.id, view.runtimeId, noop);
    assert.equal(older.historyNotice, notice);
    assert.equal(older.items[0].text, "First question");
    assert.equal(older.items.at(-1)?.text, "New saved answer");
    assert.equal(older.error, undefined);
    assert.equal(older.historyCursor, null);
    assert.deepEqual(h.sent, []);
  } finally {
    h.chats.close();
  }
});

test("busy native Codex queues the raw prompt once and replaces its queued display when history arrives", async () => {
  const h = harness();
  const view = await h.open();
  const input = {
    runtimeId: view.runtimeId,
    requestId: randomUUID(),
    text: "Question from IDE",
  };
  const receipt = await h.chats.send(view.id, input, "desktop", noop);
  assert.equal(receipt.status, "queued");
  assert.equal(h.sent[0].text, input.text);
  assert.equal(h.sent[0].sessionId, view.nativeId);
  assert.equal(
    (await h.chats.send(view.id, input, "desktop", noop)).duplicate,
    true,
  );
  assert.equal(h.sent.length, 1);
  assert.equal(h.chats.snapshot(view.id).items.at(-1)?.status, "queued");
  h.page.items.push({ id: "native-q2", kind: "user", text: input.text });
  h.tick();
  const current = await h.chats.read(view.id, noop);
  assert.equal(
    current.items.filter((item) => item.text === input.text).length,
    1,
  );
  assert.equal(current.items.at(-1)?.id, "native-q2");
});

test("Claude sends only through the existing automatic channel; hook-only remains readable", async () => {
  const h = harness("claude");
  h.channel(false);
  const view = await h.open();
  assert.equal(view.live?.canSend, false);
  assert.match(view.live?.reason || "", /연결된 터미널/);
  const input = {
    runtimeId: view.runtimeId,
    requestId: randomUUID(),
    text: "Question",
  };
  await assert.rejects(
    h.chats.send(view.id, input, "desktop", noop),
    /IDE 입력 채널/,
  );
  assert.equal(h.sent.length, 0);
  h.channel(true);
  assert.equal(
    (await h.chats.send(view.id, input, "desktop", noop)).status,
    "queued",
  );
  assert.equal(h.sent[0].provider, "claude");
  await assert.rejects(
    h.chats.send(
      view.id,
      { ...input, requestId: randomUUID(), text: "x".repeat(15301) },
      "desktop",
      noop,
    ),
    /15,300/,
  );
  assert.equal(h.sent.length, 1);
});

test("a native user item arriving before queue acknowledgement never leaves a duplicate queued echo", async () => {
  const h = harness();
  const view = await h.open();
  const text = "Arrives before acknowledgement";
  h.beforeNative(async () => {
    h.page.items.push({ id: "early-user", kind: "user", text });
    h.tick();
    await h.chats.read(view.id, noop);
  });
  await h.chats.send(
    view.id,
    { runtimeId: view.runtimeId, requestId: randomUUID(), text },
    "desktop",
    noop,
  );
  const matches = h.chats
    .snapshot(view.id)
    .items.filter((item) => item.text === text);
  assert.deepEqual(
    matches.map((item) => item.id),
    ["early-user"],
  );
});

test("Claude channel JSON can reconcile a multiline quoted user prompt without duplicate echo", async () => {
  const h = harness("claude");
  const view = await h.open();
  const text = 'Explain "this"\nC:\\example\\file';
  await h.chats.send(
    view.id,
    { runtimeId: view.runtimeId, requestId: randomUUID(), text },
    "desktop",
    noop,
  );
  h.page.items.push({
    id: "channel-user",
    kind: "user",
    text: `<channel source="mcp:harbor">\n${JSON.stringify({ messageId: "message", sender: { kind: "user" }, userInput: { version: 1, requestId: h.sent[0].requestId }, text })}\n</channel>`,
  });
  h.tick();
  const current = await h.chats.read(view.id, noop);
  assert.ok(current.items.some((item) => item.id === "channel-user"));
  assert.ok(
    !current.items.some((item) => item.id.startsWith("harbor-live-pending-")),
  );
});

test("normalized Claude IDE user records correlate by request ID, not an unrelated matching CLI prompt", async () => {
  const h = harness("claude");
  const view = await h.open();
  const text = "Same text";
  await h.chats.send(
    view.id,
    { runtimeId: view.runtimeId, requestId: randomUUID(), text },
    "desktop",
    noop,
  );
  h.page.items.push({ id: "another-native-user", kind: "user", text });
  h.tick();
  assert.equal(
    (await h.chats.read(view.id, noop)).items.filter(
      (item) => item.status === "queued",
    ).length,
    1,
  );
  h.page.items.push({
    id: `harbor-ide-user:${h.sent[0].requestId}`,
    kind: "user",
    text,
  });
  h.tick();
  assert.equal(
    (await h.chats.read(view.id, noop)).items.filter(
      (item) => item.status === "queued",
    ).length,
    0,
  );
});

test("runtime, lease, and native identity are rechecked just before live delivery", async () => {
  const h = harness();
  const view = await h.open();
  const input = {
    runtimeId: view.runtimeId,
    requestId: randomUUID(),
    text: "Do not send elsewhere",
  };
  await assert.rejects(
    h.chats.send(
      view.id,
      { ...input, runtimeId: "old-runtime" },
      "desktop",
      noop,
    ),
    /연결이 바뀌/,
  );
  let allowed = true;
  h.beforeNative(async () => {
    allowed = false;
  });
  await assert.rejects(
    h.chats.send(view.id, input, "desktop", () => {
      if (!allowed)
        throw Object.assign(new Error("lease revoked"), { status: 403 });
    }),
    /lease revoked/,
  );
  assert.equal(h.sent.length, 0);
  allowed = true;
  h.beforeNative(async () => {
    h.terminal.agentSessionId = "different-session";
  });
  await assert.rejects(
    h.chats.send(
      view.id,
      { ...input, requestId: randomUUID() },
      "desktop",
      noop,
    ),
    /대화가 바뀌/,
  );
  assert.equal(h.sent.length, 0);
  const current = await h.chats.read(view.id, noop);
  assert.equal(current.nativeId, "native-session");
  assert.equal(current.live?.canSend, false);
  assert.equal(current.items[1].text, "Old answer");
});

test("resume identity fallback never overrides a different observed native conversation", () => {
  const h = harness();
  h.terminal.resumeThreadId = "native-session";
  h.terminal.agentSessionId = undefined;
  assert.ok(h.live.find(host.id, "codex", "native-session"));
  h.terminal.agentSessionId = "new-session";
  assert.equal(h.live.find(host.id, "codex", "native-session"), undefined);
  h.terminal.exited = true;
  assert.equal(h.live.find(host.id, "codex", "new-session"), undefined);
});

test("a post-authorization capability change is a definite rejection and the same request may recover", async () => {
  const h = harness();
  const view = await h.open();
  const input = {
    runtimeId: view.runtimeId,
    requestId: randomUUID(),
    text: "Still bound",
  };
  let checks = 0;
  await assert.rejects(
    h.chats.send(view.id, input, "desktop", async () => {
      await Promise.resolve();
      if (++checks === 3) h.terminal.agentSessionId = "different-native";
    }),
    /대화가 바뀌/,
  );
  assert.equal(h.sent.length, 0);
  h.terminal.agentSessionId = view.nativeId;
  assert.equal(
    (await h.chats.send(view.id, input, "desktop", noop)).status,
    "queued",
  );
  assert.equal(h.sent.length, 1);
});

test("live history readers cap concurrent SSH reads and recover when slots finish", async () => {
  const h = harness();
  let release!: () => void;
  h.waitRead(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const binding = h.live.find(host.id, "codex", "native-session")!;
  const reads = Array.from({ length: 8 }, (_, index) =>
    h.live.read(binding, `page-${index}`),
  );
  await assert.rejects(h.live.read(binding, "ninth-page"), /다른 대화 기록/);
  release();
  await Promise.all(reads);
  assert.equal(h.reads(), 8);
  await h.live.read(binding, "ninth-page");
  assert.equal(h.reads(), 9);
});

test("a changed host connection scope never reuses another account's cached page", async () => {
  const h = harness();
  const binding = h.live.find(host.id, "codex", "native-session")!;
  await h.live.read(binding);
  h.page.items = [
    { id: "new-account", kind: "assistant", text: "Different account history" },
  ];
  h.cacheScope("changed-account");
  const page = await h.live.read(binding);
  assert.equal(h.reads(), 2);
  assert.equal(page.items[0].id, "new-account");
});

test("two identical queued questions cannot both match one native user item", async () => {
  const h = harness();
  const view = await h.open();
  const text = "Same question twice";
  for (let i = 0; i < 2; i++)
    await h.chats.send(
      view.id,
      { runtimeId: view.runtimeId, requestId: randomUUID(), text },
      "desktop",
      noop,
    );
  h.page.items.push({ id: "native-first", kind: "user", text });
  h.tick();
  await h.chats.read(view.id, noop);
  h.tick();
  const current = await h.chats.read(view.id, noop);
  assert.equal(current.items.filter((item) => item.text === text).length, 2);
  assert.equal(
    current.items.filter((item) => item.status === "queued").length,
    1,
  );
  h.page.items.push({ id: "native-second", kind: "user", text });
  h.tick();
  assert.equal(
    (await h.chats.read(view.id, noop)).items.filter(
      (item) => item.status === "queued",
    ).length,
    0,
  );
});

test("waiting or disconnected native sessions remain readable and require their terminal for approvals", async () => {
  const h = harness();
  h.terminal.agentState = "waiting";
  const view = await h.open();
  assert.equal(view.status, "waiting");
  assert.equal(view.live?.canSend, false);
  assert.equal(view.live?.canInterrupt, false);
  assert.deepEqual(view.approvals, []);
  await assert.rejects(
    h.chats.interrupt(view.id, view.runtimeId, noop),
    /연결된 터미널/,
  );
  await assert.rejects(
    h.chats.answer(
      view.id,
      "made-up",
      { runtimeId: view.runtimeId, approved: true },
      noop,
    ),
    /연결된 터미널/,
  );
  h.terminal.connectionState = "reconnecting";
  const offline = await h.chats.read(view.id, noop);
  assert.equal(offline.status, "offline");
  assert.equal(offline.items.length, 2);
});

test("live router requires its exact terminal lease only for mutations, not rendering or older history", async () => {
  const h = harness();
  const view = await h.open();
  const contexts: IdeChatAuthorization[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    "/chat",
    createIdeChatRouter(h.chats, {
      authorize: (_req, context) => {
        contexts.push(context);
      },
      actor: () => "remote-desktop",
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/chat/conversations/${view.id}`;
  const post = (path: string, body: unknown, terminalId?: string) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(terminalId ? { "X-Harbor-Terminal": terminalId } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await fetch(url)).status, 200);
    assert.equal(
      (await post("/history", { runtimeId: view.runtimeId })).status,
      200,
    );
    assert.ok(
      contexts.every((context) => !context.write && !context.terminalId),
    );
    const input = {
      runtimeId: view.runtimeId,
      requestId: randomUUID(),
      text: "Hello",
    };
    assert.equal((await post("/messages", input)).status, 409);
    assert.equal(
      (await post("/messages", input, "another-terminal")).status,
      409,
    );
    assert.equal(h.sent.length, 0);
    assert.equal(
      (await post("/messages", input, view.live!.terminalId)).status,
      200,
    );
    assert.ok(
      contexts.some(
        (context) =>
          context.write && context.terminalId === view.live!.terminalId,
      ),
    );
    assert.equal(h.sent.length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
