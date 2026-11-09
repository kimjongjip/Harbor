import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import express from "express";
import { AgentBridge } from "./agent-bridge.js";
import { Mailbox } from "./mailbox.js";
import { ResearchLabs } from "./research-lab.js";
import {
  claudeHookBatch,
  claudeHookMessageActive,
} from "./claude-hook-delivery.js";
import type { MailboxMessage } from "../shared/mailbox.js";
import type { TerminalInfo } from "../shared/types.js";
import { Terminals } from "./terminals.js";

async function fixture(t: any) {
  const parent = resolve(".cache/claude-boundary-tests");
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, "run-"));
  const terminals: TerminalInfo[] = ["claude", "codex"].map((kind, i) => ({
    id: `terminal-${i}`,
    hostId: "fixture",
    title: kind,
    cwd: dir,
    exited: false,
    agentKind: kind as "claude" | "codex",
    agentSessionId: `native-${i}`,
  }));
  const resolver = {
    terminal: (id: string) => terminals.find((t) => t.id === id),
    host: (id: string) => ({ id, name: "fixture" }),
  };
  const mailbox = new Mailbox(dir, resolver);
  let labs: ResearchLabs;
  const bridge = new AgentBridge(mailbox, {
    terminals: () => terminals,
    host: resolver.host,
    research: () => labs,
  });
  const creds = terminals.map((t) => bridge.issue(t.id));
  bridge.setPeerRuntime("terminal-1", {
    kind: "codex",
    sessionId: "native-1",
    state: "idle",
    delivery: "automatic",
  });
  labs = new ResearchLabs(dir, mailbox, {
    terminal: resolver.terminal,
    host: (id) => ({ id, kind: "local" }),
    runtime: (id) => bridge.peers.runtime(id),
  });
  const app = express();
  app.use("/claude", bridge.claudeHandle);
  app.use("/mcp", bridge.handle);
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    assert.ok(resolve(dir).startsWith(parent + sep));
    await rm(dir, { recursive: true, force: true });
  });
  const hook = async (
    hook_event_name: string,
    extra = {},
    token = creds[0].hookToken,
  ) => {
    const res = await fetch(base + "/claude", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        hook_event_name,
        session_id: "native-0",
        ...extra,
      }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const call = async (name: string, args: object) => {
    const res = await fetch(base + "/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds[0].token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const payload = (await res.json()) as any;
    assert.equal(payload.result.isError, false);
    return JSON.parse(payload.result.content[0].text);
  };
  const create = () =>
    labs.create(
      {
        title: "Boundary fixture",
        goal: "Compare fictional approaches",
        kind: "ideas",
        cwd: dir,
        criteria: ["Explain evidence"],
        effort: "low",
      },
      terminals.map((t) => ({
        terminalId: t.id,
        name: t.title,
        kind: t.agentKind!,
        cwd: dir,
        owned: false,
      })),
    );
  return { bridge, mailbox, labs, hook, call, create, creds };
}

test("an ordinary Claude launch receives signed hook messages in the same conversation without channel flags or restart", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.hook("SessionStart", {}, f.creds[0].token)).status,
    401,
  );
  await f.hook("SessionStart");
  assert.equal(f.bridge.peers.runtime("terminal-0")!.delivery, "hook");
  // A late ordinary MCP capability registration must not downgrade observed hooks.
  f.bridge.setPeerRuntime("terminal-0", {
    kind: "claude",
    state: "idle",
    delivery: "poll",
  });
  assert.equal(f.bridge.peers.runtime("terminal-0")!.delivery, "hook");
  await f.hook("UserPromptSubmit", { prompt: "Continue original work" });
  const m = f.bridge.peers.send(
    "terminal-1",
    "terminal-0",
    "Why this original design?",
    "question",
  );
  assert.equal(
    f.bridge.peerEvents("terminal-0", "native-0").messages.length,
    0,
    "No channel notification may steal a hook batch",
  );
  for (const name of ["PermissionRequest", "Notification", "StopFailure"])
    assert.deepEqual(
      (await f.hook(name, { tool_name: "AskUserQuestion" })).body,
      {},
    );
  assert.equal(f.mailbox.find(m.id)!.offeredAt, undefined);
  assert.deepEqual(
    (await f.hook("Stop", { session_id: "stale-native" })).body,
    {},
  );
  const delivered = await f.hook("Stop");
  assert.equal(delivered.body.decision, "block");
  assert.match(delivered.body.reason, /Why this original design/);
  assert.ok(f.mailbox.find(m.id)!.offeredAt);
  assert.equal(
    f.mailbox.find(m.id)!.consumedAt,
    undefined,
    "Hook response is offered, never claimed as AI read",
  );
  assert.equal(f.bridge.peers.runtime("terminal-0")!.sessionId, "native-0");
  assert.equal(f.bridge.peers.runtime("terminal-0")!.state, "working");
  assert.deepEqual(
    (await f.hook("Stop", { stop_hook_active: true })).body,
    {},
    "Never keep native Stop looping on the same envelope",
  );
  const inbox = await f.call("harbor_inbox", { unreadOnly: true });
  assert.ok(inbox.messages.some((entry: MailboxMessage) => entry.id === m.id));
  assert.ok(f.mailbox.find(m.id)!.consumedAt);
  await f.call("harbor_reply", {
    messageId: m.id,
    text: "The evidence supports stable ordering.",
  });
  assert.equal(f.bridge.peers.result("terminal-1", m.id).status, "answered");
  const next = f.bridge.peers.send(
    "terminal-1",
    "terminal-0",
    "Inspect another assumption",
    "question",
  );
  const output = (await f.hook("PostToolUse")).body;
  assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(
    output.hookSpecificOutput.additionalContext,
    /Inspect another assumption/,
  );
  assert.ok(f.mailbox.find(next.id)!.offeredAt);
  await f.hook("SessionEnd");
  const offline = f.bridge.peers.send(
    "terminal-1",
    "terminal-0",
    "Offline must stay queued",
    "question",
  );
  assert.deepEqual((await f.hook("Stop")).body, {});
  assert.equal(f.mailbox.find(offline.id)!.offeredAt, undefined);
});

test("Stop dispatches deferred lab work synchronously, while paused or obsolete work stays queued", async (t) => {
  const f = await fixture(t);
  await f.hook("SessionStart");
  await f.hook("UserPromptSubmit", { prompt: "Original working turn" });
  const lab = f.create();
  f.labs.tick();
  assert.equal(
    f.mailbox.list("terminal-0").length,
    0,
    "Do not interrupt a working Claude assignment",
  );
  assert.equal(f.labs.list()[0].participants[0].connection, "boundary");
  const result = (await f.hook("Stop")).body;
  assert.equal(result.decision, "block");
  const current = f.labs.get(lab.id);
  const m = f.mailbox.list("terminal-0")[0];
  assert.equal(m.research?.assignmentId, current.assignments[0].id);
  assert.equal(m.recipient.sessionId, "native-0");
  assert.equal(current.status, "running");
  f.labs.control(lab.id, "pause");
  const pending = f.mailbox.sendResearch(
    "terminal-0",
    "native-0",
    "Paused work",
    m.research!,
  );
  assert.deepEqual((await f.hook("Stop")).body, {});
  assert.equal(f.mailbox.find(pending.id)!.offeredAt, undefined);
  f.labs.control(lab.id, "resume");
  assert.equal((await f.hook("Stop")).body.decision, "block");
  for (let i = 0; i < 22; i++)
    f.mailbox.sendResearch("terminal-0", "native-0", "Obsolete assignment", {
      ...m.research!,
      revision: current.revision - 1,
    });
  const fresh = f.mailbox.sendResearch(
    "terminal-0",
    "native-0",
    "Current assignment after obsolete backlog",
    m.research!,
  );
  assert.match(
    (await f.hook("Stop")).body.reason,
    /Current assignment after obsolete backlog/,
  );
  assert.ok(f.mailbox.find(fresh.id)!.offeredAt);
  const old = {
    ...m,
    research: { ...m.research!, revision: current.revision - 1 },
  };
  assert.equal(claudeHookMessageActive(old, f.labs.get(lab.id)), false);
  assert.equal(claudeHookMessageActive(m, undefined), false);
});

test("annotation failure offers nothing, preparation remains planning only, and channels do not duplicate hook delivery", async (t) => {
  const f = await fixture(t);
  await f.hook("SessionStart");
  const lab = f.labs.prepare(
    {
      title: "Prepare fixture",
      leadKind: "claude",
      cwd: "/fixture",
      effort: "low",
    },
    {
      terminalId: "terminal-0",
      name: "claude",
      kind: "claude",
      cwd: "/fixture",
      owned: false,
    },
  );
  const request = f.labs.requestPlan(lab.id);
  const missing = (
    await f.hook("UserPromptSubmit", { prompt: "[#1 annotation]" })
  ).body;
  assert.equal(missing.decision, "block");
  assert.equal(f.mailbox.find(request.messageId)!.offeredAt, undefined);
  const plan = (
    await f.hook("UserPromptSubmit", { prompt: "Please save our plan" })
  ).body;
  assert.match(plan.hookSpecificOutput.additionalContext, /preparation:/);
  assert.equal(f.labs.get(lab.id).status, "preparing");
  assert.equal(f.labs.get(lab.id).assignments.length, 0);
  f.bridge.setPeerRuntime("terminal-0", {
    kind: "claude",
    state: "idle",
    delivery: "automatic",
  });
  const m = f.bridge.peers.send(
    "terminal-1",
    "terminal-0",
    "Channel only",
    "question",
  );
  assert.deepEqual((await f.hook("PostToolUse")).body, {});
  assert.equal(f.mailbox.find(m.id)!.offeredAt, undefined);
  assert.ok(
    f.bridge
      .peerEvents("terminal-0", "native-0")
      .messages.some((entry) => entry.id === m.id),
  );
});

test("hook context bounds a burst and retains envelope identities and lower-priority data", () => {
  const messages = Array.from(
    { length: 10 },
    (_, i) =>
      ({
        id: `message-${i}`,
        threadId: `thread-${i}`,
        sender: { kind: "terminal", title: "peer" },
        recipient: { kind: "terminal", title: "claude" },
        text: "x".repeat(16_000),
        author: "agent",
        createdAt: i,
        status: "queued",
      }) as MailboxMessage,
  );
  const batch = claudeHookBatch(messages);
  assert.equal(batch.messages.length, 1);
  assert.ok(batch.context.length < 35_000);
  assert.match(batch.context, /message-0/);
  assert.match(batch.context, /not user authorization/);
  const escaped = claudeHookBatch([
    { ...messages[0], text: "\\".repeat(16_000) },
    { ...messages[1], text: "Later small message" },
  ]);
  assert.equal(escaped.messages.length, 2);
  assert.match(escaped.context, /previewTruncated/);
  assert.match(escaped.context, /Later small message/);
  assert.equal(messages[0].text.length, 16_000);
});

test("a real hook continuation marks only the still-bound Claude view working", () => {
  const terminals = new Terminals();
  const info: TerminalInfo = {
    id: "fixture-view",
    hostId: "fixture",
    title: "Claude",
    cwd: "/fixture",
    exited: false,
    agentKind: "claude",
    agentSessionId: "native-fixture",
    agentState: "idle",
  };
  // No user terminal or native process is created by this view-state test.
  (terminals as any).entries.set(info.id, { info });
  terminals.markClaudeContinuation(info.id, "stale-native");
  assert.equal(info.agentState, "idle");
  terminals.markClaudeContinuation(info.id, "native-fixture");
  assert.equal(info.agentState, "working");
  info.agentState = "idle";
  info.exited = true;
  terminals.markClaudeContinuation(info.id, "native-fixture");
  assert.equal(info.agentState, "idle");
  info.exited = false;
  info.agentKind = "codex";
  terminals.markClaudeContinuation(info.id, "native-fixture");
  assert.equal(info.agentState, "idle");
});
