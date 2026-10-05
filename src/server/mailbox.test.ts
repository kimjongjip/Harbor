import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import express from "express";
import { Mailbox } from "./mailbox.js";
import { AgentBridge } from "./agent-bridge.js";
import { MAILBOX_TEXT_LIMIT } from "../shared/mailbox.js";
import type { TerminalInfo } from "../shared/types.js";

async function setup(t: any) {
  const parent = resolve(".cache/mailbox-tests");
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, "run-"));
  const terminals: TerminalInfo[] = [
    {
      id: "a",
      title: "프런트엔드",
      hostId: "local",
      cwd: "C:/project",
      exited: false,
    },
    {
      id: "b",
      title: "서버 작업",
      hostId: "remote",
      cwd: "/home/project",
      exited: false,
    },
    {
      id: "c",
      title: "검토",
      hostId: "remote",
      cwd: "/home/review",
      exited: false,
    },
  ];
  const resolver = {
    terminal: (id: string) => terminals.find((terminal) => terminal.id === id),
    host: (id: string) => ({
      id,
      name: id === "local" ? "내 컴퓨터" : "build-server",
    }),
  };
  const mailbox = new Mailbox(dir, resolver);
  t.after(async () => {
    if (resolve(dir).startsWith(parent + sep))
      await rm(dir, { recursive: true, force: true });
  });
  return { dir, terminals, resolver, mailbox };
}

test("Claude cannot receive handoffs, but switching back to Codex restores messaging", async (t) => {
  const { mailbox, terminals } = await setup(t);
  terminals[1].agentKind = "claude";
  terminals[1].program = "claude";
  assert.throws(() => mailbox.send({ fromTerminalId: "a", toTerminalId: "b", text: "handoff" }), /Claude/);
  assert.throws(() => mailbox.sendAgent("b", "a", "handoff"), /Claude/);
  terminals[1].agentKind = "codex";
  assert.equal(mailbox.sendAgent("a", "b", "hello").recipient.terminalId, "b");
});

test("mailbox preserves named cross-host threads and exact peer context across restart", async (t) => {
  const { mailbox, dir, terminals, resolver } = await setup(t);
  const original = mailbox.send({
    fromTerminalId: "a",
    toTerminalId: "b",
    text: " API 응답을 확인해주세요. ",
  });
  assert.equal(original.status, "queued");
  assert.equal(original.author, "user");
  assert.equal(original.recipient.hostName, "build-server");
  assert.equal(original.text, "API 응답을 확인해주세요.");
  const reply = mailbox.replyAgent(
    "b",
    original.id,
    "응답 형식을 확인했습니다.",
  );
  assert.equal(reply.threadId, original.id);
  assert.equal(reply.author, "agent");
  assert.equal(reply.recipient.terminalId, "a");
  assert.throws(
    () => mailbox.replyAgent("c", original.id, "forged"),
    /받은 메시지/,
  );
  assert.throws(
    () =>
      mailbox.send({
        fromTerminalId: "c",
        toTerminalId: "b",
        text: "unrelated",
        replyToId: original.id,
      }),
    /원래 대화/,
  );
  terminals[0].title = "바뀐 이름";
  terminals[1].exited = true;
  const recovered = new Mailbox(dir, resolver).list();
  assert.equal(recovered[1].sender.title, "프런트엔드");
  assert.equal(recovered[1].recipient.cwd, "/home/project");
  recovered[1].text = "external mutation";
  assert.equal(mailbox.list()[1].text, original.text);
  assert.throws(
    () => mailbox.send({ toTerminalId: "b", text: "closed" }),
    /열려 있는 세션/,
  );
});

test("only recipient MCP consumption marks messages consumed; UI read and draft do not", async (t) => {
  const { mailbox } = await setup(t);
  const human = mailbox.send({ toTerminalId: "b", text: "이 작업을 확인해줘" });
  mailbox.mark(human.id, "read");
  mailbox.mark(human.id, "drafted");
  assert.equal(mailbox.list()[0].consumedAt, undefined);
  assert.deepEqual(mailbox.consume("a"), []);
  const consumed = mailbox.consume("b");
  assert.equal(consumed.length, 1);
  assert.equal(consumed[0].status, "consumed");
  assert.ok(consumed[0].consumedAt);
  assert.deepEqual(mailbox.consume("b"), []);
  assert.equal(mailbox.consume("b", { unreadOnly: false }).length, 1);
  assert.equal(mailbox.mark(human.id, "read").status, "consumed");
  assert.throws(() => mailbox.mark(human.id, "consumed" as any));
  const reply = mailbox.replyAgent("b", human.id, "완료했습니다");
  assert.equal(reply.recipient.kind, "user");
  assert.equal(reply.threadId, human.id);
});

test("mailbox bounds storage without discarding unconsumed messages and rejects corrupt state", async (t) => {
  const { mailbox, dir, resolver } = await setup(t);
  assert.throws(() => mailbox.send({ toTerminalId: "b", text: " " }));
  assert.throws(() =>
    mailbox.send({
      toTerminalId: "b",
      text: "x".repeat(MAILBOX_TEXT_LIMIT + 1),
    }),
  );
  assert.throws(
    () =>
      mailbox.send({ fromTerminalId: "b", toTerminalId: "b", text: "loop" }),
    /다른 세션/,
  );
  const text = "x".repeat(MAILBOX_TEXT_LIMIT);
  for (let index = 0; index < 65; index++)
    mailbox.send({ toTerminalId: "b", text });
  assert.throws(() => mailbox.send({ toTerminalId: "b", text }), /가득/);
  assert.equal(mailbox.list().length, 65);
  mailbox.consume("b", { limit: 1 });
  mailbox.send({ toTerminalId: "b", text });
  assert.equal(mailbox.list().length, 65);
  assert.equal(
    mailbox.list().filter((message) => message.status === "queued").length,
    65,
  );
  assert.ok((await readFile(mailbox.file, "utf8")).length < 1_100_000);
  await writeFile(mailbox.file, "not json");
  assert.throws(() => new Mailbox(dir, resolver));
  assert.equal(await readFile(mailbox.file, "utf8"), "not json");
});

test("scoped MCP clients exchange real messages without PTY writes and cannot impersonate peers", async (t) => {
  const { mailbox, terminals, resolver } = await setup(t);
  const connected: string[] = [];
  const states: string[] = [];
  const bridge = new AgentBridge(mailbox, {
    terminals: () => terminals,
    host: resolver.host,
    onConnected: (id) => connected.push(id),
    onState: (id, state) => states.push(`${id}:${state}`),
  });
  const a = bridge.issue("a");
  const b = bridge.issue("b");
  const app = express();
  app.all("/bridge/mcp", bridge.handle);
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/bridge/mcp`;
  let sequence = 0;
  const request = (
    token: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const rpc = async (token: string, method: string, params?: unknown) => {
    const response = await request(token, {
      jsonrpc: "2.0",
      id: ++sequence,
      method,
      params,
    });
    assert.equal(response.status, 200);
    return (await response.json()) as any;
  };
  const call = async (token: string, name: string, args: unknown = {}) => {
    const result = (await rpc(token, "tools/call", { name, arguments: args }))
      .result;
    return {
      error: result.isError,
      data: result.isError
        ? result.content[0].text
        : JSON.parse(result.content[0].text),
    };
  };
  assert.equal((await request("0".repeat(64), {})).status, 401);
  assert.equal(
    (await request(a.token, {}, { Origin: "https://evil.example" })).status,
    403,
  );
  assert.equal(
    (await request(a.token, {}, { Origin: `http://127.0.0.1:${address.port}` }))
      .status,
    403,
  );
  const init = await rpc(a.token, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.deepEqual(connected, ["a"]);
  assert.equal(bridge.status("a").connected, true);
  assert.equal((await rpc(a.token, "tools/list")).result.tools.length, 4);
  const sessions = (await call(a.token, "harbor_sessions")).data;
  assert.equal(sessions.self, "a");
  assert.equal(sessions.sessions[1].host, "build-server");
  const sent = await call(a.token, "harbor_send", {
    to: "서버 작업",
    text: "선택한 로그를 확인해주세요.",
  });
  assert.equal(sent.error, false);
  assert.equal(sent.data.message.sender.terminalId, "a");
  assert.equal(sent.data.message.status, "queued");
  assert.equal((await call(a.token, "harbor_inbox")).data.messages.length, 0);
  const inbox = await call(b.token, "harbor_inbox");
  assert.equal(inbox.data.messages[0].status, "consumed");
  const reply = await call(b.token, "harbor_reply", {
    messageId: sent.data.message.id,
    text: "재현 위치를 찾았습니다.",
  });
  assert.equal(reply.data.message.threadId, sent.data.message.id);
  assert.equal(
    (await call(a.token, "harbor_inbox")).data.messages[0].text,
    "재현 위치를 찾았습니다.",
  );
  assert.equal(
    (
      await call(a.token, "harbor_send", {
        to: "b",
        text: "forgery",
        fromTerminalId: "c",
      })
    ).error,
    true,
  );
  assert.equal(
    (
      await call(a.token, "harbor_reply", {
        messageId: sent.data.message.id,
        text: "not recipient",
      })
    ).error,
    true,
  );
  assert.equal(
    (
      await request(a.token, {
        jsonrpc: "2.0",
        method: "notifications/harbor/terminal-state",
        params: { state: "shell" },
      })
    ).status,
    202,
  );
  assert.equal(bridge.status("a").connected, false);
  assert.ok(states.includes("a:shell"));
  const rotated = bridge.issue("a");
  assert.equal((await request(a.token, {})).status, 401);
  assert.equal((await rpc(rotated.token, "ping")).result.constructor, Object);
  bridge.revoke("b");
  assert.equal((await request(b.token, {})).status, 401);
  assert.equal(JSON.stringify(mailbox.list()).includes(a.token), false);
});
