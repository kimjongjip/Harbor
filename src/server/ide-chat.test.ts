import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { Hub } from "./hub.js";
import type { Store } from "./store.js";
import type { HostConfig } from "../shared/types.js";
import {
  IdeChats,
  IdeChatError,
  createIdeChatRouter,
  type IdeChatDependencies,
} from "./ide-chat.js";
import {
  createClaudeChatFactory,
  type ClaudeQuery,
} from "./ide-chat-claude.js";

const guard = () => {};
const host: HostConfig = {
  id: "test-host",
  name: "Test",
  kind: "ssh",
  address: "example.invalid",
  username: "test",
  port: 22,
  identityFile: "",
  codexPath: "codex",
  defaultCwd: "/old/default",
  mode: "isolated",
  color: "blue",
  createdAt: 0,
};
function harness(overrides: Partial<IdeChatDependencies> = {}) {
  const calls: { method: string; params: any }[] = [];
  const replies: { id: unknown; result: any }[] = [];
  const hub = new Hub({
    data: {
      hosts: [host],
      sessions: [],
      activities: [],
      transfers: [],
      discussions: [],
    },
    session() {},
    save() {},
    activity() {},
  } as unknown as Store);
  hub.host(host.id).status = "connected";
  const client = {
    alive: true,
    async call(method: string, params: any) {
      calls.push({ method, params });
      if (method === "thread/start")
        return {
          thread: { id: randomUUID(), cwd: params.cwd, status: "idle" },
        };
      if (method === "thread/read" || method === "thread/resume")
        return {
          thread: {
            id: params.threadId,
            cwd: "/project",
            status: "idle",
            name: "Prior work",
          },
        };
      if (method === "thread/turns/list") return { data: [], nextCursor: null };
      if (method === "turn/start") return { turn: { id: randomUUID() } };
      return {};
    },
    respond(id: unknown, result: unknown) {
      replies.push({ id, result });
    },
    rejectRequest() {},
  };
  hub.clients.set(host.id, client as any);
  const dependencies: IdeChatDependencies = {
    runtimeId: "test-runtime",
    hub,
    host: (id) => {
      assert.equal(id, host.id);
      return host;
    },
    password: async () => undefined,
    resolveCwd: async (_hostId, cwd) => cwd || "/home/test",
    historyList: async () => ({ data: [], nextCursor: null }),
    historyRead: async (hostId, provider, id) => ({
      thread: {
        provider,
        id,
        hostId,
        title: "Past conversation",
        cwd: "/project",
        preview: "",
        updatedAt: 0,
        source: "test",
        active: false,
      },
      items: [{ id: "old-user", kind: "user", text: "Previous question" }],
      nextCursor: "next",
    }),
    nativeActive: () => false,
    ...overrides,
  };
  const chats = new IdeChats(dependencies);
  return { chats, hub, calls, replies, client, dependencies };
}
const create = (
  chats: IdeChats,
  provider: "codex" | "claude" = "codex",
  extra = {},
) =>
  chats.create(
    { hostId: host.id, provider, requestId: randomUUID(), ...extra },
    "desktop",
    guard,
  );
const send = (
  chats: IdeChats,
  id: string,
  text = "Explain this project",
  requestId = randomUUID(),
) =>
  chats.send(
    id,
    { runtimeId: "test-runtime", requestId, text },
    "desktop",
    guard,
  );
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(predicate());
}

test("fresh Codex chat starts at actual home and sends one structured turn without a terminal", async () => {
  const { chats, calls } = harness();
  const requestId = randomUUID();
  const input = { hostId: host.id, provider: "codex" as const, requestId };
  const [first, duplicate] = await Promise.all([
    chats.create(input, "desktop", guard),
    chats.create(input, "desktop", guard),
  ]);
  assert.equal(first.id, duplicate.id);
  assert.equal(first.cwd, "/home/test");
  assert.equal(
    calls.filter((call) => call.method === "thread/start").length,
    1,
  );
  assert.equal(calls[0].params.approvalPolicy, "on-request");
  const messageId = randomUUID();
  await send(chats, first.id, "hello", messageId);
  assert.equal(
    (await send(chats, first.id, "hello", messageId)).duplicate,
    true,
  );
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 1);
  assert.deepEqual(
    calls.find((call) => call.method === "turn/start")?.params.input,
    [{ type: "text", text: "hello", text_elements: [] }],
  );
  await assert.rejects(
    send(chats, first.id, "different", messageId),
    /다른 메시지/,
  );
  await assert.rejects(send(chats, first.id, "second prompt"), /현재 답변/);
});

test("both providers title quoted messages with the question while sending the full selection", async () => {
  const question = "이 함수 설명해줘";
  const text = `${question}\n\n<editor_selection>\n${JSON.stringify({ path: "/project/example.ts", startLine: 2, endLine: 4, unsaved: true, text: "function selected() {\n  return 42;\n}" }, null, 2)}\n</editor_selection>`;
  for (const provider of ["codex", "claude"] as const) {
    let claudeText = "";
    const { chats, calls } = harness({
      claude: (turn) => {
        claudeText = turn.text;
        return { done: Promise.resolve(), async interrupt() {}, close() {} };
      },
    });
    const view = await create(chats, provider);
    await send(chats, view.id, text);
    assert.equal(chats.snapshot(view.id).title, question, provider);
    assert.equal(
      provider === "codex"
        ? calls.find((call) => call.method === "turn/start")?.params.input[0]
            .text
        : claudeText,
      text,
      "selection metadata must remain in the native prompt",
    );
    if (provider === "claude")
      assert.equal(chats.snapshot(view.id).items[0].text, text);
    const malformed = "Q\n\n<editor_selection>\n{}\n</editor_selection>";
    const next = await create(chats, provider);
    await send(chats, next.id, malformed);
    assert.equal(
      chats.snapshot(next.id).title,
      malformed,
      "ordinary literal text is retained",
    );
    chats.close();
  }
});

test("history resume can open a closed native conversation; an open CLI blocks competing writers", async () => {
  let active = false;
  const { chats, calls } = harness({ nativeActive: () => active });
  const nativeId = randomUUID();
  const resumed = await create(chats, "codex", { resumeId: nativeId });
  assert.equal(resumed.nativeId, nativeId);
  assert.equal(resumed.cwd, "/project");
  assert.ok(calls.some((call) => call.method === "thread/resume"));
  assert.equal(
    (await create(chats, "codex", { resumeId: nativeId })).id,
    resumed.id,
  );
  active = true;
  await assert.rejects(send(chats, resumed.id), /터미널에서 열려/);
  await assert.rejects(
    create(chats, "claude", { resumeId: randomUUID() }),
    /터미널에서 열려/,
  );
});

test("the same create request recovers after a busy native CLI is closed", async () => {
  let active = true;
  const { chats } = harness({ nativeActive: () => active });
  const input = {
    hostId: host.id,
    provider: "claude" as const,
    resumeId: randomUUID(),
    requestId: randomUUID(),
  };
  await assert.rejects(
    chats.create(input, "desktop", guard),
    /터미널에서 열려/,
  );
  active = false;
  assert.equal(
    (await chats.create(input, "desktop", guard)).nativeId,
    input.resumeId,
  );
});

test("late auth revocation at native dispatch sends no prompt; runtime IDs are checked", async () => {
  const { chats, hub, calls } = harness();
  const view = await create(chats);
  let allowed = true;
  const originalOpen = hub.openSession.bind(hub);
  hub.openSession = async (id) => {
    const result = await originalOpen(id);
    allowed = false;
    return result;
  };
  await assert.rejects(
    chats.send(
      view.id,
      { runtimeId: view.runtimeId, requestId: randomUUID(), text: "sensitive" },
      "desktop",
      () => {
        if (!allowed) throw new IdeChatError("revoked", 403);
      },
    ),
    /revoked/,
  );
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 0);
  await assert.rejects(
    chats.send(
      view.id,
      { runtimeId: "stale", requestId: randomUUID(), text: "hello" },
      "desktop",
      guard,
    ),
    /연결이 바뀌/,
  );
});

test("uncertain turn dispatch is retained and retry does not submit it twice", async () => {
  const { chats, client, calls } = harness();
  const view = await create(chats);
  const originalCall = client.call.bind(client);
  client.call = async (method, params) => {
    const result = await originalCall(method, params);
    if (method === "turn/start") throw new Error("response lost");
    return result;
  };
  const requestId = randomUUID();
  await assert.rejects(
    send(chats, view.id, "only once", requestId),
    /response lost/,
  );
  assert.equal(
    (await send(chats, view.id, "only once", requestId)).status,
    "uncertain",
  );
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 1);
});

test("a changed host binding cannot receive a prompt intended for its previous server", async () => {
  const config = { ...host };
  const { chats } = harness({ host: () => config });
  const view = await create(chats, "claude");
  config.address = "changed.invalid";
  await assert.rejects(send(chats, view.id), /서버 연결 설정이 바뀌/);
  const reopened = await create(chats, "claude", { resumeId: view.nativeId });
  assert.notEqual(reopened.id, view.id);
});

test("Codex approval is bound to native conversation and only grants original turn permissions", async () => {
  const { chats, hub, client, replies } = harness();
  const first = await create(chats),
    second = await create(chats);
  const permissions = {
    network: { enabled: true },
    fileSystem: { read: ["/specific"] },
  };
  (hub as any).request(host.id, client, {
    id: 100,
    method: "item/permissions/requestApproval",
    params: { threadId: first.nativeId, permissions },
  });
  const approval = chats.snapshot(first.id).approvals[0];
  const previousRevision = chats.snapshot(first.id).revision;
  await assert.rejects(
    chats.answer(
      second.id,
      approval.id,
      { runtimeId: first.runtimeId, approved: true },
      guard,
    ),
    /대기 중인 승인 요청이 아닙니다/,
  );
  await chats.answer(
    first.id,
    approval.id,
    { runtimeId: first.runtimeId, approved: true },
    guard,
  );
  assert.ok(chats.snapshot(first.id).revision > previousRevision);
  assert.deepEqual(replies, [
    { id: 100, result: { permissions, scope: "turn" } },
  ]);
  await assert.rejects(
    chats.answer(
      first.id,
      approval.id,
      { runtimeId: first.runtimeId, approved: true },
      guard,
    ),
    /대기 중인 승인 요청이 아닙니다/,
  );
});

test("Claude SDK streams a native answer, asks permission in IDE, and resumes its persisted ID", async () => {
  const invocations: any[] = [];
  const permissionResults: any[] = [];
  const fakeQuery = ((invocation: any) => {
    invocations.push(invocation);
    return {
      async *[Symbol.asyncIterator]() {
        const prompt = (await invocation.prompt[Symbol.asyncIterator]().next())
          .value;
        const session_id =
          invocation.options.sessionId || invocation.options.resume;
        assert.equal(prompt.message.role, "user");
        yield {
          type: "system",
          subtype: "init",
          session_id,
          model: "fake-model",
        };
        permissionResults.push(
          await invocation.options.canUseTool(
            "Bash",
            { command: "echo sample" },
            { signal: new AbortController().signal },
          ),
        );
        yield {
          type: "stream_event",
          session_id,
          event: { type: "message_start", message: { id: "reply-id" } },
        };
        yield {
          type: "stream_event",
          session_id,
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        };
        yield {
          type: "stream_event",
          session_id,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Rendered answer" },
          },
        };
        yield {
          type: "assistant",
          session_id,
          message: {
            id: "reply-id",
            content: [{ type: "text", text: "Rendered answer" }],
          },
        };
        yield {
          type: "result",
          session_id,
          subtype: "success",
          is_error: false,
        };
      },
      async interrupt() {},
      close() {},
    };
  }) as ClaudeQuery;
  const { chats } = harness({
    claude: createClaudeChatFactory({ query: fakeQuery }),
  });
  const view = await create(chats, "claude");
  assert.equal(invocations.length, 0, "creating a draft doesn't start a model");
  await send(chats, view.id);
  await until(() => chats.snapshot(view.id).status === "waiting");
  const approval = chats.snapshot(view.id).approvals[0];
  await chats.answer(
    view.id,
    approval.id,
    { runtimeId: view.runtimeId, approved: true },
    guard,
  );
  await until(() => chats.snapshot(view.id).status === "idle");
  const done = chats.snapshot(view.id);
  assert.equal(
    done.items.filter((item) => item.kind === "assistant").length,
    1,
  );
  assert.equal(
    done.items.find((item) => item.kind === "assistant")?.text,
    "Rendered answer",
  );
  assert.equal(permissionResults[0].behavior, "allow");
  assert.equal(invocations[0].options.permissionMode, "default");
  assert.deepEqual(invocations[0].options.settingSources, [
    "user",
    "project",
    "local",
  ]);
  await send(chats, view.id, "continue");
  await until(() => chats.snapshot(view.id).status === "waiting");
  assert.equal(invocations[1].options.resume, view.nativeId);
  assert.equal(invocations[1].options.sessionId, undefined);
  await chats.answer(
    view.id,
    chats.snapshot(view.id).approvals[0].id,
    { runtimeId: view.runtimeId, approved: false },
    guard,
  );
  await until(() => chats.snapshot(view.id).status === "idle");
  assert.equal(permissionResults[1].behavior, "deny");
  chats.close();
});

test("router enforces authorization for reads/writes and accepts scoped Codex approval IDs", async (t) => {
  const { chats, hub, client } = harness();
  const app = express();
  app.use(express.json());
  app.use(
    "/api/ide-chat",
    createIdeChatRouter(chats, {
      actor: () => "desktop",
      authorize: (req) => {
        if (req.headers.authorization !== "test-token")
          throw new IdeChatError("denied", 403);
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    chats.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ide-chat`;
  assert.equal(
    (await fetch(`${base}/hosts/${host.id}/history?provider=codex`)).status,
    403,
  );
  const response = await fetch(`${base}/conversations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "test-token",
    },
    body: JSON.stringify({
      hostId: host.id,
      provider: "codex",
      requestId: randomUUID(),
    }),
  });
  assert.equal(response.status, 200);
  const view = (await response.json()) as any;
  (hub as any).request(host.id, client, {
    id: 9,
    method: "item/commandExecution/requestApproval",
    params: { threadId: view.nativeId, command: "echo synthetic" },
  });
  const approval = chats.snapshot(view.id).approvals[0];
  const answer = await fetch(
    `${base}/conversations/${view.id}/approvals/${encodeURIComponent(approval.id)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "test-token",
      },
      body: JSON.stringify({ runtimeId: view.runtimeId, approved: true }),
    },
  );
  assert.equal(answer.status, 200);
  assert.equal((await fetch(`${base}/conversations/${view.id}`)).status, 403);
});
