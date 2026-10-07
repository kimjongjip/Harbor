import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import http from "node:http";
import readline from "node:readline";
import test from "node:test";
import express from "express";
import { AgentBridge } from "./agent-bridge.js";
import { Mailbox } from "./mailbox.js";
import type { TerminalInfo } from "../shared/types.js";
import {
  claudePeerMcpConfig,
  nodeClaudePeerAdapter,
  pythonClaudePeerAdapter,
} from "./claude-peer-channel.js";

const token = "synthetic-session-scoped-token";
type Packet = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
};
type EventMessage = {
  id: string;
  threadId: string;
  text: string;
  recipient: { sessionId: string };
  sender: { title: string; hostName: string; cwd: string };
};

async function waitFor(predicate: () => boolean, milliseconds = 4000) {
  const until = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= until)
      throw new Error("Timed out waiting for isolated adapter fixture");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(automatic: boolean) {
  const packets: Packet[] = [];
  const calls: { path: string; body: any }[] = [];
  let sessionId = "synthetic-native-session-A";
  let messages: EventMessage[] = [];
  let rejectTools = false;
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = data ? JSON.parse(data) : undefined;
    const path = new URL(req.url!, "http://127.0.0.1").pathname;
    calls.push({ path, body });
    res.setHeader("Content-Type", "application/json");
    if (path === "/bridge/peers/events") {
      res.end(JSON.stringify({ sessionId, messages }));
    } else if (path === "/bridge/mcp") {
      if (rejectTools) {
        res.writeHead(503).end(JSON.stringify({ error: "synthetic offline" }));
        return;
      }
      const result =
        body.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              instructions: "Synthetic bridge instructions",
            }
          : body.method === "tools/list"
            ? {
                tools: [
                  { name: "harbor_reply", inputSchema: { type: "object" } },
                ],
              }
            : {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      replied: body.params.arguments.messageId,
                      text: body.params.arguments.text,
                    }),
                  },
                ],
              };
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    } else res.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ["-e", nodeClaudePeerAdapter],
    {
      windowsHide: true,
      env: {
        ...process.env,
        HARBOR_SESSION_TOKEN: token,
        HARBOR_BRIDGE_URL: `http://127.0.0.1:${address.port}/bridge/mcp`,
        HARBOR_CLAUDE_CHANNEL_ENABLED: automatic ? "1" : "0",
      },
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    packets.push(JSON.parse(line));
  });
  const send = (packet: Packet) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...packet }) + "\n");
  const close = async () => {
    const exited = child.exitCode !== null;
    if (!exited) {
      const result = once(child, "exit");
      child.stdin.end();
      await result;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return {
    child,
    packets,
    calls,
    send,
    close,
    stderr: () => stderr,
    messages: (next: EventMessage[]) => {
      messages = next;
    },
    session: (next: string) => {
      sessionId = next;
    },
    rejectTools: () => {
      rejectTools = true;
    },
  };
}

function event(
  id = "message-1",
  recipientSessionId = "synthetic-native-session-A",
): EventMessage {
  return {
    id,
    threadId: "thread-1",
    text: "Why did you choose that design? 한글 질문",
    recipient: { sessionId: recipientSessionId },
    sender: {
      title: "Codex design",
      hostName: "Fixture host",
      cwd: "/fixture/project",
    },
  };
}

test("per-launch configuration keeps credentials out of config and only enables channels explicitly", () => {
  const ordinary = JSON.parse(
    claudePeerMcpConfig(
      "windows",
      "http://127.0.0.1:9999/bridge/mcp",
      false,
      "C:\\fixture\\node.exe",
    ),
  );
  const automatic = JSON.parse(
    claudePeerMcpConfig("posix", "http://127.0.0.1:9999/bridge/mcp", true),
  );
  assert.equal(ordinary.mcpServers.harbor.command, "C:\\fixture\\node.exe");
  assert.equal(
    ordinary.mcpServers.harbor.env.HARBOR_CLAUDE_CHANNEL_ENABLED,
    "0",
  );
  assert.equal(automatic.mcpServers.harbor.command, "python3");
  assert.deepEqual(automatic.mcpServers.harbor.args.slice(0, 4), [
    "-X",
    "utf8",
    "-u",
    "-c",
  ]);
  assert.equal(
    automatic.mcpServers.harbor.env.HARBOR_CLAUDE_CHANNEL_ENABLED,
    "1",
  );
  assert.equal(
    automatic.mcpServers.harbor.args.at(-1),
    pythonClaudePeerAdapter,
  );
  assert.equal(ordinary.mcpServers.harbor.env.HARBOR_SESSION_TOKEN, undefined);
  assert(!JSON.stringify(ordinary).includes(token));
  assert.throws(
    () => claudePeerMcpConfig("posix", "https://example.org/bridge/mcp"),
    /loopback/,
  );
  const authenticatedUrl = new URL("http://localhost:9999/bridge/mcp");
  authenticatedUrl.username = "fixture-user";
  authenticatedUrl.password = "fixture-secret";
  assert.throws(
    () => claudePeerMcpConfig("windows", authenticatedUrl.href),
    /loopback/,
  );
});

test("automatic adapter negotiates supported MCP revision and offers only current native-session messages", async (t) => {
  const f = await fixture(true);
  t.after(f.close);
  f.messages([event(), event("wrong-session", "synthetic-unrelated-session")]);
  f.send({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2026-07-28",
      capabilities: {},
      clientInfo: { name: "fixture-cli" },
    },
  });
  await waitFor(() => f.packets.some((p) => p.id === 1));
  const initial = f.packets.find((p) => p.id === 1)!.result;
  assert.equal(initial.protocolVersion, "2025-06-18");
  assert.deepEqual(initial.capabilities.experimental, { "claude/channel": {} });
  assert.equal(
    initial.capabilities.experimental["claude/channel/permission"],
    undefined,
  );
  assert.match(initial.instructions, /not user authorization/);
  assert.equal(f.calls[0].body.params.clientInfo.name, "harbor-claude-adapter");
  assert.equal(
    f.calls.some((c) => c.path === "/bridge/peers/events"),
    false,
  );
  f.send({ method: "notifications/initialized" });
  await waitFor(() => f.calls.some((c) => c.path === "/bridge/peers/ack"));
  const notification = f.packets.find(
    (p) => p.method === "notifications/claude/channel",
  )!;
  assert.equal(notification.params.meta.message_id, "message-1");
  assert.equal(JSON.parse(notification.params.content).text, event().text);
  assert.deepEqual(f.calls.find((c) => c.path === "/bridge/peers/ack")!.body, {
    messageId: "message-1",
    sessionId: "synthetic-native-session-A",
  });
  assert.equal(
    f.calls.some((c) => c.body?.params?.name === "harbor_inbox"),
    false,
    "offering must not impersonate a model inbox read",
  );
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(
    f.packets.filter((p) => p.method === "notifications/claude/channel").length,
    1,
    "a repeated HTTP batch must not duplicate native notifications",
  );
  f.session("synthetic-native-session-B");
  f.messages([
    event("old-after-resume"),
    event("new-after-resume", "synthetic-native-session-B"),
  ]);
  await waitFor(() =>
    f.packets.some((p) => p.params?.meta?.message_id === "new-after-resume"),
  );
  assert.equal(
    f.packets.some((p) => p.params?.meta?.message_id === "old-after-resume"),
    false,
  );
});

test("ordinary Claude receives real scoped MCP tools without pretending it has push delivery", async (t) => {
  const f = await fixture(false);
  t.after(f.close);
  f.messages([event()]);
  f.send({
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26" },
  });
  await waitFor(() => f.packets.some((p) => p.id === 1));
  const initial = f.packets.find((p) => p.id === 1)!.result;
  assert.equal(initial.protocolVersion, "2025-03-26");
  assert.equal(initial.capabilities.experimental, undefined);
  f.send({ method: "notifications/initialized" });
  await waitFor(() => f.calls.some((c) => c.path === "/bridge/peers/runtime"));
  assert.equal(
    f.calls.find((c) => c.path === "/bridge/peers/runtime")!.body.delivery,
    "poll",
  );
  assert.equal(
    f.calls.some((c) => c.path === "/bridge/peers/ack"),
    false,
  );
  assert.equal(
    f.packets.some((p) => p.method === "notifications/claude/channel"),
    false,
  );
  f.send({ id: 2, method: "tools/list", params: {} });
  await waitFor(() => f.packets.some((p) => p.id === 2));
  assert.equal(
    f.packets.find((p) => p.id === 2)!.result.tools[0].name,
    "harbor_reply",
  );
  f.send({
    id: 3,
    method: "tools/call",
    params: {
      name: "harbor_reply",
      arguments: { messageId: "message-1", text: "Original context answer" },
    },
  });
  await waitFor(() => f.packets.some((p) => p.id === 3));
  assert.deepEqual(
    JSON.parse(f.packets.find((p) => p.id === 3)!.result.content[0].text),
    { replied: "message-1", text: "Original context answer" },
  );
  f.rejectTools();
  f.send({
    id: 4,
    method: "tools/call",
    params: {
      name: "harbor_reply",
      arguments: { messageId: "message-1", text: "not delivered" },
    },
  });
  await waitFor(() => f.packets.some((p) => p.id === 4));
  assert.match(
    f.packets.find((p) => p.id === 4)!.error.message,
    /No delivery or answer was confirmed/,
  );
});

test("adapter closes its runtime without terminating a native conversation", async (t) => {
  const f = await fixture(false);
  t.after(f.close);
  f.send({ id: 1, method: "initialize", params: {} });
  await waitFor(() => f.packets.some((p) => p.id === 1));
  f.send({ method: "notifications/initialized" });
  await waitFor(
    () => f.calls.filter((c) => c.path === "/bridge/peers/runtime").length >= 2,
  );
  await f.close();
  assert(
    f.calls.some(
      (c) => c.path === "/bridge/peers/runtime" && c.body.state === "offline",
    ),
  );
  assert.equal(
    f.calls.some((c) => /interrupt|kill|turn\/start/.test(c.path)),
    false,
  );
});

test("production bridge routes Codex question to Claude adapter and records only an actual correlated MCP reply as answered", async (t) => {
  const parent = resolve(".cache/claude-peer-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "run-"));
  t.after(async () => {
    if (resolve(directory).startsWith(parent + sep))
      await rm(directory, { recursive: true, force: true });
  });
  const terminals: TerminalInfo[] = [
    {
      id: "fixture-codex",
      title: "Codex design",
      hostId: "local",
      cwd: "/fixture/design",
      exited: false,
      agentKind: "codex",
      agentSessionId: "native-codex",
    },
    {
      id: "fixture-claude",
      title: "Claude implementation",
      hostId: "remote",
      cwd: "/fixture/implementation",
      exited: false,
      agentKind: "claude",
    },
  ];
  const resolver = {
    terminal: (id: string) => terminals.find((item) => item.id === id),
    host: (id: string) => ({ id, name: `Synthetic ${id}` }),
  };
  const mailbox = new Mailbox(directory, resolver);
  const bridge = new AgentBridge(mailbox, {
    terminals: () => terminals,
    host: resolver.host,
    onClaudeEvent: (id, event) => {
      const terminal = resolver.terminal(id)!;
      terminal.agentKind = "claude";
      if (event.hook_event_name === "SessionStart")
        terminal.agentSessionId = event.session_id;
    },
  });
  const credentials = bridge.issue("fixture-claude");
  bridge.issue("fixture-codex");
  bridge.setPeerRuntime("fixture-codex", {
    kind: "codex",
    sessionId: "native-codex",
    state: "idle",
    delivery: "automatic",
  });
  const app = express();
  app.use("/bridge/mcp", bridge.handle);
  app.use("/bridge/peers", bridge.peerHandle);
  app.use("/bridge/claude", bridge.claudeHandle);
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const child = spawn(process.execPath, ["-e", nodeClaudePeerAdapter], {
    windowsHide: true,
    env: {
      ...process.env,
      HARBOR_SESSION_TOKEN: credentials.token,
      HARBOR_BRIDGE_URL: base + "/bridge/mcp",
      HARBOR_CLAUDE_CHANNEL_ENABLED: "1",
    },
  });
  const packets: Packet[] = [];
  child.stderr.resume();
  readline
    .createInterface({ input: child.stdout })
    .on("line", (line) => packets.push(JSON.parse(line)));
  const send = (packet: Packet) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...packet }) + "\n");
  t.after(async () => {
    if (child.exitCode === null) {
      const done = once(child, "exit");
      child.stdin.end();
      await done;
    }
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  send({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fixture-native-cli" },
    },
  });
  await waitFor(() => packets.some((packet) => packet.id === 1));
  assert.equal(bridge.peers.runtime("fixture-claude")!.kind, "claude");
  assert.equal(
    bridge.peers.runtime("fixture-claude")!.sessionId,
    undefined,
    "MCP initialize cannot invent a native conversation identity",
  );
  send({ method: "notifications/initialized" });
  const hook = await fetch(base + "/bridge/claude", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.hookToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "native-claude",
      cwd: "/fixture/implementation",
    }),
  });
  assert.equal(hook.status, 200);
  const original = bridge.peers.send(
    "fixture-codex",
    "fixture-claude",
    "Explain the design decision from your existing implementation conversation.",
    "question",
  );
  await waitFor(() =>
    packets.some((packet) => packet.params?.meta?.message_id === original.id),
  );
  await waitFor(() => Boolean(mailbox.find(original.id)?.offeredAt));
  assert.equal(mailbox.find(original.id)!.recipient.sessionId, "native-claude");
  assert.equal(mailbox.find(original.id)!.consumedAt, undefined);
  assert.equal(
    bridge.peers.result("fixture-codex", original.id).status,
    "pending",
  );
  send({
    id: 2,
    method: "tools/call",
    params: { name: "harbor_inbox", arguments: { unreadOnly: true } },
  });
  await waitFor(() => packets.some((packet) => packet.id === 2));
  assert.equal(
    packets.find((packet) => packet.id === 2)!.result.isError,
    false,
  );
  assert.equal(
    JSON.parse(
      packets.find((packet) => packet.id === 2)!.result.content[0].text,
    ).messages[0].id,
    original.id,
  );
  assert(mailbox.find(original.id)!.consumedAt);
  send({
    id: 3,
    method: "tools/call",
    params: {
      name: "harbor_reply",
      arguments: {
        messageId: original.id,
        text: "I chose it because the implementation already batches those requests.",
      },
    },
  });
  await waitFor(() => packets.some((packet) => packet.id === 3));
  assert.equal(
    packets.find((packet) => packet.id === 3)!.result.isError,
    false,
  );
  const answer = bridge.peers.result("fixture-codex", original.id);
  assert.equal(answer.status, "answered");
  assert.equal(answer.reply!.author, "agent");
  assert.equal(answer.reply!.sender.agentKind, "claude");
  assert.equal(answer.reply!.sender.sessionId, "native-claude");
  assert.equal(answer.reply!.recipient.sessionId, "native-codex");
  assert.equal(answer.reply!.threadId, original.threadId);
  assert.equal(answer.reply!.replyToId, original.id);
});
