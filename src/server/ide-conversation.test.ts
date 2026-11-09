import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  IdeConversations,
  ideTerminalReady,
  type IdeConversationOperations,
} from "./ide-conversation.js";
import type { TerminalInfo } from "../shared/types.js";
import type { HistoryDetail } from "../shared/history.js";
import { mobileFixture } from "../test/mobile-fixture.js";

const detail = (id = "native-session"): HistoryDetail => ({
  thread: {
    id,
    hostId: "host",
    title: "Synthetic",
    cwd: "/fixture",
    preview: "",
    updatedAt: 1,
    source: "cli",
    active: true,
  },
  items: [
    { id: "user", kind: "user", text: "Question" },
    {
      id: "tool",
      kind: "command",
      text: "synthetic command",
      detail: "synthetic output",
      status: "completed",
    },
    { id: "answer", kind: "assistant", text: "Answer" },
  ],
  nextCursor: "older",
});

function fixture() {
  let terminal: TerminalInfo = {
    id: "terminal",
    hostId: "host",
    cwd: "/fixture",
    title: "Fixture",
    exited: false,
    connectionState: "connected",
    agentConnected: true,
    agentKind: "codex",
    agentState: "idle",
    agentSessionId: "native-session",
  };
  const writes: string[] = [],
    queued: unknown[] = [];
  let authorized = true,
    native = true;
  const operations: IdeConversationOperations = {
    runtimeId: "runtime",
    terminal: (id) => (id === "terminal" ? terminal : undefined),
    readHistory: async () => detail(),
    terminalReady: async () => true,
    write: (_id, data) => {
      writes.push(data);
    },
    codex: {
      available: () => native,
      currentSession: () => terminal.agentSessionId,
      submitUser: async (id, input, beforeEnqueue) => {
        beforeEnqueue?.();
        queued.push([id, input]);
        return "queued";
      },
    },
  };
  return {
    service: new IdeConversations(operations),
    operations,
    writes,
    queued,
    update: (change: Partial<TerminalInfo>) => {
      terminal = { ...terminal, ...change };
    },
    offlineNative: () => {
      native = false;
    },
    deny: () => {
      authorized = false;
    },
    authorize: () => {
      if (!authorized) throw new Error("Control revoked");
    },
    input: {
      runtimeId: "runtime",
      sessionId: "native-session",
      requestId: "request-1",
      text: "사용자 질문\nsecond line",
      submit: true as const,
    },
  };
}

test("IDE reads preserve native item order and tools, coalesce pages, and reject changed bindings", async () => {
  const f = fixture();
  let release!: (page: HistoryDetail) => void,
    reads = 0;
  f.operations.readHistory = async (host, provider, session, cursor) => {
    assert.deepEqual(
      [host, provider, session, cursor],
      ["host", "codex", "native-session", "older"],
    );
    reads++;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const one = f.service.read("terminal", "native-session", "older");
  const two = f.service.read("terminal", "native-session", "older");
  release(detail());
  assert.deepEqual(await one, await two);
  assert.equal(reads, 1);
  assert.deepEqual((await one).items, detail().items);
  assert.equal((await one).capabilities.transport, "codex-native");
  const stale = f.service.read("terminal", "native-session", "older");
  f.update({ hostId: "replacement" });
  release(detail());
  await assert.rejects(stale, /변경/);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.queued, []);
});

test("fresh native conversations retain send capability when no saved history exists", async () => {
  const f = fixture();
  f.operations.readHistory = async () => {
    throw new Error("no rollout");
  };
  const page = await f.service.read("terminal", "native-session");
  assert.ok(page.historyError);
  assert.deepEqual(page.items, []);
  assert.equal(page.capabilities.canSend, true);
});

test("native send validates identity and lease and deduplicates concurrent requests without PTY input", async () => {
  const f = fixture();
  for (const change of [
    { runtimeId: "stale" },
    { sessionId: "other" },
    { text: "escape\x1b[201~\rcommand" },
  ])
    await assert.rejects(
      f.service.send("terminal", { ...f.input, ...change }, f.authorize),
    );
  f.update({ agentState: "working" });
  const [first, second] = await Promise.all([
    f.service.send("terminal", f.input, f.authorize),
    f.service.send("terminal", f.input, f.authorize),
  ]);
  assert.equal(first.status, "queued");
  assert.equal(second.duplicate, true);
  assert.equal(f.queued.length, 1);
  assert.deepEqual(f.writes, []);
  await assert.rejects(
    f.service.send("terminal", { ...f.input, text: "different" }, f.authorize),
    /같은 요청/,
  );
  f.deny();
  await assert.rejects(
    f.service.send(
      "terminal",
      { ...f.input, requestId: "request-2" },
      f.authorize,
    ),
    /Control revoked/,
  );
});

test("native enqueue rechecks control and conversation after asynchronous preparation", async () => {
  for (const revoke of ["control", "conversation", "connection"] as const) {
    const f = fixture();
    f.operations.codex.submitUser = async (_id, _input, beforeEnqueue) => {
      if (revoke === "control") f.deny();
      else if (revoke === "conversation")
        f.update({ agentSessionId: "replacement" });
      else f.update({ connectionState: "disconnected" });
      beforeEnqueue?.();
      throw new Error("must never enqueue");
    };
    await assert.rejects(f.service.send("terminal", f.input, f.authorize));
    assert.deepEqual(f.writes, []);
  }
});

test("Claude fallback requires explicit terminal submission, idle agent and observed paste mode", async () => {
  const f = fixture();
  f.update({ agentKind: "claude" });
  f.offlineNative();
  assert.equal(
    (await f.service.read("terminal", "native-session")).capabilities.transport,
    "terminal",
  );
  await assert.rejects(
    f.service.send("terminal", f.input, f.authorize),
    /CLI 입력칸/,
  );
  for (const state of ["working", "waiting"] as const) {
    f.update({ agentState: state });
    await assert.rejects(
      f.service.send(
        "terminal",
        { ...f.input, terminalSubmit: true },
        f.authorize,
      ),
    );
  }
  f.update({ agentState: "idle" });
  f.operations.terminalReady = async () => false;
  await assert.rejects(
    f.service.send(
      "terminal",
      { ...f.input, terminalSubmit: true },
      f.authorize,
    ),
  );
  f.operations.terminalReady = async () => true;
  const result = await f.service.send(
    "terminal",
    { ...f.input, terminalSubmit: true },
    f.authorize,
  );
  assert.equal(result.status, "submitted");
  assert.deepEqual(f.writes, [`\x1b[200~${f.input.text}\x1b[201~\r`]);
  assert.equal(
    (
      await f.service.send(
        "terminal",
        { ...f.input, terminalSubmit: true },
        f.authorize,
      )
    ).duplicate,
    true,
  );
  assert.equal(f.writes.length, 1);
});

test("uncertain PTY acknowledgement is retained and never replayed", async () => {
  const f = fixture();
  f.update({ agentKind: "claude" });
  let writes = 0;
  f.operations.write = () => {
    writes++;
    throw new Error("channel closed after write");
  };
  const input = { ...f.input, terminalSubmit: true };
  assert.equal(
    (await f.service.send("terminal", input, f.authorize)).status,
    "uncertain",
  );
  assert.equal(
    (await f.service.send("terminal", input, f.authorize)).status,
    "uncertain",
  );
  assert.equal(writes, 1);
});

test("bracketed mode follows the last observed setting, including combined DEC modes", () => {
  assert.equal(ideTerminalReady({ data: "text" }), false);
  assert.equal(ideTerminalReady({ data: "\x1b[?25;2004h" }), true);
  assert.equal(ideTerminalReady({ data: "\x1b[?2004h\x1b[?2004l" }), false);
});

test("desktop IDE routes require desktop pairing and current control, and mobile cannot access them", async () => {
  const f = await mobileFixture();
  try {
    await f.gateway.stop();
    f.state.terminals[0].agentConnected = true;
    f.operations.ide = new IdeConversations({
      runtimeId: f.state.runtimeId,
      terminal: (id) => f.state.terminals.find((t) => t.id === id),
      readHistory: async () => detail("native-fixture"),
      terminalReady: async () => true,
      write: f.operations.write,
      codex: {
        available: () => false,
        currentSession: () => undefined,
        submitUser: async () => {
          throw new Error("not available");
        },
      },
    });
    await f.gateway.start();
    const path = `/desktop-api/ide/terminals/${f.id}`;
    assert.equal(
      (await f.http(`${path}/conversation?sessionId=native-fixture`)).status,
      401,
    );
    const phone = await f.pair();
    assert.equal(
      (
        await f.http(
          `${path}/conversation?sessionId=native-fixture`,
          undefined,
          { cookie: phone },
        )
      ).status,
      403,
    );
    const invitation = f.access.pairing("desktop");
    const code = new URLSearchParams(new URL(invitation.url).hash.slice(1)).get(
      "pair",
    );
    const paired = await f.http("/mobile-api/pair", {
      code,
      name: "Synthetic desktop",
    });
    const cookie = paired.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (
        await f.http(
          `${path}/conversation?sessionId=native-fixture`,
          undefined,
          { cookie },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await f.http(
          `${path}/conversation?sessionId=native-fixture&host=other`,
          undefined,
          { cookie },
        )
      ).status,
      400,
    );
    const body = {
      runtimeId: f.state.runtimeId,
      sessionId: "native-fixture",
      requestId: randomUUID(),
      text: "synthetic input",
      submit: true,
      terminalSubmit: true,
    };
    assert.equal(
      (await f.http(`${path}/messages`, body, { cookie })).status,
      409,
    );
    const clientId = randomUUID();
    const claim = await f.http(
      `/mobile-api/terminals/${f.id}/control`,
      {
        runtimeId: f.state.runtimeId,
        sessionId: "native-fixture",
        clientId,
        action: "claim",
      },
      { cookie },
    );
    const token = (await claim.json()).token;
    const sent = await f.http(`${path}/messages`, body, {
      cookie,
      "x-harbor-client": clientId,
      "x-harbor-control": token,
    });
    assert.equal(sent.status, 200, await sent.text());
    assert.deepEqual(f.writes, ["\x1b[200~synthetic input\x1b[201~\r"]);
    const receipt = await f.http(`${path}/messages`, body, {
      cookie,
      "x-harbor-client": clientId,
      "x-harbor-control": token,
    });
    assert.equal((await receipt.json()).duplicate, true);
    assert.equal(f.writes.length, 1);
  } finally {
    await f.close();
  }
});
