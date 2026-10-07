import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rmdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createServer, type Server } from "node:http";
import express from "express";
import { Requests } from "./requests.js";
import { Mailbox } from "./mailbox.js";
import { AgentBridge } from "./agent-bridge.js";
import type { TerminalInfo } from "../shared/types.js";

function closeServer(server: Server) {
  return new Promise<void>((done, reject) => {
    // Stop accepting connections before destroying existing ones. Reversing
    // this order lets a late connection outlive the test's teardown.
    server.close((error) => (error ? reject(error) : done()));
    server.closeAllConnections();
  });
}
const changed = (requests: Requests) =>
  once(requests, "change", { signal: AbortSignal.timeout(5000) });
const boundedSignal = (signal?: AbortSignal) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
    : AbortSignal.timeout(5000);

async function fixture(t: any) {
  const parent = resolve(".cache/request-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "run-"));
  const terminals: TerminalInfo[] = ["a", "b"].map((id) => ({
    id,
    hostId: id === "a" ? "local" : "remote",
    title: `Worker ${id}`,
    cwd: `/project/${id}`,
    exited: false,
    integration: "ready",
  }));
  const resolver = {
    terminal: (id: string) => terminals.find((terminal) => terminal.id === id),
    host: (id: string) => ({
      id,
      name: id === "local" ? "내 컴퓨터" : "build-server",
    }),
  };
  const requests = new Requests(directory, resolver);
  const mailbox = new Mailbox(directory, resolver);
  const servers: Server[] = [];
  t.after(async () => {
    const errors: unknown[] = [];
    try {
      requests.shutdown();
    } catch (error) {
      errors.push(error);
    } finally {
      // A disk failure in shutdown must not skip closing the test listeners.
      // Preserve every failure after all owned resources have been cleaned up.
      await Promise.all(
        servers.map((server) =>
          closeServer(server).catch((error) => errors.push(error)),
        ),
      );
      try {
        assert.ok(resolve(directory).startsWith(parent + sep));
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "Request fixture cleanup failed");
  });
  return { requests, mailbox, resolver, directory, terminals, servers };
}
const question = {
  title: "대상 선택",
  question: "어느 파일을 먼저 검토할까요?",
  options: [
    { id: "api", label: "API 파일" },
    { id: "ui", label: "화면 파일" },
  ],
};

test("a scoped waiting MCP request receives the exact UI answer, with distinct answered and consumed states", async (t) => {
  const { requests } = await fixture(t);
  const request = requests.create("a", question);
  assert.throws(() => requests.result("b", request.id), /이 세션/);
  assert.throws(
    () => requests.respond(request.id, { text: "", optionId: "forged" }),
    /유효/,
  );
  assert.throws(() => requests.respond(request.id, { text: " " }), /답변/);
  const pending = requests.wait("a", request.id, 1000);
  const answered = requests.respond(request.id, {
    text: "API 파일부터 봐주세요.",
    optionId: "api",
  });
  assert.equal(answered.status, "answered");
  assert.equal(answered.consumedAt, undefined);
  const result = await pending;
  assert.equal(result.status, "consumed");
  assert.equal(result.answer?.text, "API 파일부터 봐주세요.");
  assert.equal(result.answer?.optionId, "api");
  assert.ok(result.consumedAt);
  assert.throws(
    () => requests.respond(request.id, { text: "changed" }),
    /이미/,
  );
  result.question = "mutated";
  assert.equal(requests.list()[0].question, question.question);
});

test("timeout and aborted transport never imply an answer; closing or restarting cancels outstanding requests", async (t) => {
  const { requests, directory, resolver } = await fixture(t);
  const first = requests.create("a", question);
  assert.equal((await requests.wait("a", first.id, 1)).status, "pending");
  const second = requests.create("b", question);
  const controller = new AbortController();
  const waiting = requests.wait("b", second.id, 1000, controller.signal);
  controller.abort();
  await waiting;
  assert.equal(
    requests.respond(second.id, { text: "", optionId: "ui" }).status,
    "answered",
  );
  assert.equal(requests.result("b", second.id, false).consumedAt, undefined);
  requests.cancelTerminal("a");
  assert.equal(requests.result("a", first.id).status, "cancelled");
  assert.throws(() => requests.respond(first.id, { text: "late" }), /이미/);
  const restored = new Requests(directory, resolver);
  assert.equal(restored.result("b", second.id).status, "cancelled");
  assert.equal(restored.result("b", second.id).answer?.text, "화면 파일");
  assert.equal(restored.result("b", second.id).consumedAt, undefined);
});

test("request bounds preserve waiting questions and reject ambiguous options", async (t) => {
  const { requests } = await fixture(t);
  assert.throws(
    () =>
      requests.create("a", {
        ...question,
        options: [
          { id: "one", label: "A" },
          { id: "one", label: "B" },
        ],
      }),
    /중복/,
  );
  for (let index = 0; index < 3; index++) requests.create("a", question);
  assert.throws(() => requests.create("a", question), /먼저/);
  assert.equal(requests.list().length, 3);
  assert.throws(() =>
    requests.create("a", { ...question, kind: "permission" } as any),
  );
});

test("real scoped HTTP bridge waits for UI answers, reports connection and mailbox state, and revokes pending requests", async (t) => {
  const { requests, mailbox, resolver, terminals, directory, servers } =
    await fixture(t);
  const bridge = new AgentBridge(mailbox, {
    terminals: () => terminals,
    host: resolver.host,
    requests,
  });
  const a = bridge.issue("a"),
    b = bridge.issue("b");
  assert.equal(bridge.connections()[0].state, "shell");
  const app = express();
  app.all("/bridge/mcp", bridge.handle);
  const server = createServer(app).listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as any).port}/bridge/mcp`;
  let sequence = 0;
  const rpc = async (token: string, method: string, params: unknown) => {
    const response = await fetch(url, {
      signal: boundedSignal(),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    });
    return (await response.json()) as any;
  };
  const call = async (token: string, name: string, args: unknown) =>
    (await rpc(token, "tools/call", { name, arguments: args })).result;
  await rpc(a.token, "initialize", { protocolVersion: "2025-03-26" });
  assert.equal(bridge.connections()[0].state, "connected");
  assert.ok(bridge.connections()[0].connectedAt);
  assert.equal((await rpc(a.token, "tools/list", {})).result.tools.length, 8);
  const created = changed(requests);
  const tool = call(a.token, "harbor_request", { ...question, waitMs: 1000 });
  await created;
  const request = requests.list()[0];
  assert.equal(bridge.connections()[0].pendingQuestions, 1);
  assert.equal(
    (
      await call(b.token, "harbor_request_result", {
        requestId: request.id,
        waitMs: 0,
      })
    ).isError,
    true,
  );
  requests.respond(request.id, { text: "왼쪽 UI 답변", optionId: "api" });
  const result = await tool;
  assert.equal(result.isError, false);
  assert.equal(
    JSON.parse(result.content[0].text).request.answer.text,
    "왼쪽 UI 답변",
  );
  const message = mailbox.sendAgent("a", "b", "확인 부탁해요");
  assert.equal(bridge.connections()[1].pendingMessages, 1);
  assert.equal(bridge.connections()[0].unansweredMessages, 1);
  mailbox.consume("b");
  mailbox.replyAgent("b", message.id, "확인했습니다");
  assert.equal(bridge.connections()[0].unansweredMessages, 0);
  assert.ok(mailbox.list().find((item) => item.id === message.id)?.repliedAt);
  const waitingCreated = changed(requests);
  const waitingId = sequence + 1;
  const interrupted = rpc(a.token, "tools/call", {
    name: "harbor_request",
    arguments: { ...question, waitMs: 1000 },
  });
  await waitingCreated;
  const interruptedRequest = requests.list()[0];
  const cancelCall = (token: string) =>
    fetch(url, {
      signal: boundedSignal(),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: waitingId },
      }),
    });
  await cancelCall(b.token);
  assert.equal(
    requests.result("a", interruptedRequest.id, false).status,
    "pending",
    "Another terminal cannot cancel this request",
  );
  await cancelCall(a.token);
  assert.equal((await interrupted).error.code, -32800);
  assert.equal(
    requests.result("a", interruptedRequest.id, false).status,
    "cancelled",
  );
  const again = requests.create("a", question);
  bridge.revoke("a");
  assert.equal(requests.result("a", again.id).status, "cancelled");
  assert.equal(bridge.connections()[0].state, "unavailable");
  assert.equal(
    (await readFile(join(directory, "requests.json"), "utf8")).includes(
      a.token,
    ),
    false,
  );
});

test("only a separate native hook capability creates permissions and only an explicit UI choice approves", async (t) => {
  const { requests, mailbox, resolver, terminals, directory, servers } =
    await fixture(t);
  const bridge = new AgentBridge(mailbox, {
    terminals: () => terminals,
    host: resolver.host,
    requests,
  });
  const issued = bridge.issue("a");
  const app = express();
  app.all("/bridge/mcp", bridge.handle);
  app.all("/bridge/permission", bridge.permissionHandle);
  const server = createServer(app).listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const event = {
    hook_event_name: "PermissionRequest",
    session_id: "native-session",
    tool_name: "Bash",
    cwd: "/project/a",
    tool_input: {
      command: "echo harmless fixture",
      description: "승인 UI 확인",
    },
  };
  const post = (
    path: string,
    token: string,
    body: unknown,
    signal?: AbortSignal,
  ) =>
    fetch(base + path, {
      method: "POST",
      signal: boundedSignal(signal),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  assert.equal((await post(issued.hookPath, issued.token, event)).status, 401);
  assert.equal(
    (
      await post(issued.path, issued.hookToken, {
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
      })
    ).status,
    401,
  );
  assert.deepEqual(
    await (
      await post(issued.hookPath, issued.hookToken, {
        ...event,
        hook_event_name: "PreToolUse",
      })
    ).json(),
    {},
  );
  assert.equal(requests.list().length, 0);
  for (const optionId of ["allow", "deny"]) {
    const created = changed(requests);
    const result = post(issued.hookPath, issued.hookToken, event);
    await created;
    const request = requests.list()[0];
    assert.equal(request.kind, "permission");
    assert.equal(request.permission?.command, "echo harmless fixture");
    assert.equal(request.permission?.cwd, "/project/a");
    assert.throws(
      () => requests.respond(request.id, { text: "yes" }),
      /직접 선택/,
    );
    requests.respond(request.id, { optionId, text: "" });
    const body = (await (await result).json()) as any;
    assert.equal(body.hookSpecificOutput.hookEventName, "PermissionRequest");
    assert.equal(body.hookSpecificOutput.decision.behavior, optionId);
    assert.equal(requests.result("a", request.id, false).status, "consumed");
  }
  const created = changed(requests);
  const fallback = post(issued.hookPath, issued.hookToken, event);
  await created;
  requests.cancel(requests.list()[0].id);
  assert.deepEqual(
    await (await fallback).json(),
    {},
    "Closing the UI leaves Codex's native approval prompt intact",
  );
  requests.once("change", () =>
    requests.respond(requests.list()[0].id, { optionId: "allow", text: "" }),
  );
  const immediate = (await (
    await post(issued.hookPath, issued.hookToken, event)
  ).json()) as any;
  assert.equal(
    immediate.hookSpecificOutput.decision.behavior,
    "allow",
    "An answer emitted synchronously during request creation must be consumed",
  );
  assert.equal(requests.list()[0].status, "consumed");
  const secretFile = await readFile(join(directory, "requests.json"), "utf8");
  assert.equal(secretFile.includes(issued.hookToken), false);
  const another = changed(requests);
  const revoked = post(issued.hookPath, issued.hookToken, event);
  await another;
  bridge.revoke("a");
  assert.deepEqual(await (await revoked).json(), {});
  assert.equal(
    (await post(issued.hookPath, issued.hookToken, event)).status,
    401,
  );
});

test(
  "disk write failures propagate for UI answers but cannot crash socket cleanup or prevent credential revocation",
  { timeout: 15000 },
  async (t) => {
    const { requests, mailbox, resolver, terminals, servers } =
      await fixture(t);
    const bridge = new AgentBridge(mailbox, {
      terminals: () => terminals,
      host: resolver.host,
      requests,
    });
    const issued = bridge.issue("a");
    const app = express();
    app.all("/bridge/mcp", bridge.handle);
    app.all("/bridge/permission", bridge.permissionHandle);
    const server = createServer(app).listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const post = (
      path: string,
      token: string,
      body: unknown,
      signal?: AbortSignal,
    ) =>
      fetch(base + path, {
        method: "POST",
        signal: boundedSignal(signal),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    const questionController = new AbortController();
    const questionCreated = changed(requests);
    const questionCall = post(
      issued.path,
      issued.token,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "harbor_request", arguments: question },
      },
      questionController.signal,
    ).catch((error) => error);
    await questionCreated;
    const request = requests.list()[0];
    const permissionController = new AbortController();
    const permissionCreated = changed(requests);
    const permissionCall = post(
      issued.hookPath,
      issued.hookToken,
      {
        hook_event_name: "PermissionRequest",
        session_id: "native-session",
        tool_name: "Bash",
        tool_input: { command: "echo fixture" },
      },
      permissionController.signal,
    ).catch((error) => error);
    await permissionCreated;
    const backup = `${requests.file}.backup`;
    await rename(requests.file, backup);
    await mkdir(requests.file); // A directory at the state-file destination forces a real rename failure.
    try {
      assert.throws(() =>
        requests.respond(request.id, { text: "Must not be silently accepted" }),
      );
      assert.equal(requests.result("a", request.id, false).status, "pending");
      questionController.abort();
      permissionController.abort();
      await Promise.all([questionCall, permissionCall]);
      await new Promise((done) => setTimeout(done, 80));
      assert.equal(
        (
          await post(issued.path, issued.token, {
            jsonrpc: "2.0",
            id: 2,
            method: "ping",
          })
        ).status,
        200,
      );
      assert.doesNotThrow(() => bridge.revoke("a"));
      assert.equal((await post(issued.path, issued.token, {})).status, 401);
    } finally {
      await rmdir(requests.file);
      await rename(backup, requests.file);
    }
  },
);
