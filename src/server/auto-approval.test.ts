import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { createServer } from "node:http";
import express from "express";
import type { TerminalInfo } from "../shared/types.js";
import { Requests } from "./requests.js";
import { AutoApproval } from "./auto-approval.js";
import { AgentBridge } from "./agent-bridge.js";
import { Mailbox } from "./mailbox.js";

async function fixture(t: any) {
  const root = resolve(".cache/auto-approval-tests");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "run-"));
  const terminals: TerminalInfo[] = ["a", "b"].map((id) => ({
    id,
    hostId: "fixture",
    title: id,
    cwd: "/fixture",
    exited: false,
    integration: "ready",
    agentSessionId: `native-${id}`,
    agentConnected: true,
  }));
  const resolver = {
    terminal: (id: string) => terminals.find((item) => item.id === id),
    host: (id: string) => ({ id, name: "Fixture" }),
  };
  const requests = new Requests(dir, resolver);
  const auto = new AutoApproval(requests, resolver.terminal, () => {});
  t.after(async () => {
    auto.dispose();
    requests.shutdown();
    assert.ok(dir.startsWith(root + sep));
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, terminals, requests, resolver, auto };
}
const permission = (session = "native-a", tool = "Bash") => ({
  hook_event_name: "PermissionRequest",
  session_id: session,
  tool_name: tool,
  tool_input: { command: "echo synthetic" },
});

test("live per-session auto acceptance handles pending/future permissions, not another terminal, stale conversation or questions", async (t) => {
  const { auto, requests, terminals } = await fixture(t);
  const pending = requests.createPermission("a", permission());
  assert.equal(pending.status, "pending");
  auto.set("a", true);
  assert.equal(requests.result("a", pending.id).answer?.optionId, "allow");
  assert.equal(requests.result("a", pending.id).answeredBy, "automatic");
  const other = requests.createPermission("b", permission("native-b"));
  const question = requests.create("a", {
    title: "Question",
    question: "Which direction?",
    options: [{ id: "allow", label: "Yes" }],
  });
  const stale = requests.createPermission("a", permission("old-session"));
  assert.equal(requests.result("b", other.id).status, "pending");
  assert.equal(requests.result("a", question.id).status, "pending");
  assert.equal(requests.result("a", stale.id).status, "pending");
  requests.cancel(question.id);
  requests.cancel(stale.id);
  for (const tool of [
    "AskUserQuestion",
    "ExitPlanMode",
    "mcp__x__request_user_input",
    "mcp__harbor__harbor_request",
  ]) {
    const ask = requests.createPermission("a", permission("native-a", tool));
    assert.equal(requests.result("a", ask.id).status, "pending");
    requests.cancel(ask.id);
  }
  auto.set("a", false);
  const off = requests.createPermission("a", permission());
  assert.equal(requests.result("a", off.id).status, "pending");
  requests.respond(off.id, { text: "", optionId: "deny" });
  auto.set("a", true);
  assert.equal(requests.result("a", off.id).answer?.optionId, "deny");
  terminals[0].agentSessionId = "replacement";
  auto.refresh();
  assert.equal(auto.state("a").enabled, false);
  const replaced = requests.createPermission("a", permission("replacement"));
  assert.equal(requests.result("a", replaced.id).status, "pending");
  auto.set("a", true);
  assert.equal(requests.result("a", replaced.id).answer?.optionId, "allow");
  terminals[0].exited = true;
  auto.refresh();
  assert.equal(auto.state("a").enabled, false);
});

test("failed decision persistence stops automation with no approval; a new controller starts off", async (t) => {
  const { auto, requests, resolver } = await fixture(t);
  auto.set("a", true);
  t.mock.method(requests, "acceptAutomatically", () => {
    throw new Error("fixture disk failure");
  });
  const failed = requests.createPermission("a", permission());
  assert.equal(requests.result("a", failed.id).status, "pending");
  assert.equal(auto.state("a").enabled, false);
  assert.equal(auto.state("a").accepted, 0);
  auto.dispose();
  const restarted = new AutoApproval(requests, resolver.terminal, () => {});
  assert.equal(restarted.state("a").enabled, false);
  restarted.dispose();
});

for (const kind of ["codex", "claude"] as const)
  test(`${kind} native approval hook receives real allow responses only for the enabled session, including over 30 actions`, async (t) => {
    const { auto, requests, terminals, dir, resolver } = await fixture(t);
    const bridge = new AgentBridge(new Mailbox(dir, resolver), {
      terminals: () => terminals,
      host: resolver.host,
      requests,
    });
    const a = bridge.issue("a"),
      b = bridge.issue("b");
    const app = express();
    app.all("/permission", bridge.permissionHandle);
    app.all("/claude", bridge.claudeHandle);
    const server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      requests.shutdown();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    });
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const post = (
      credential: typeof a,
      body: unknown,
      token = credential.hookToken,
    ) =>
      fetch(base + (kind === "claude" ? "/claude" : "/permission"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
    if (kind === "claude")
      for (const [id, credential] of [
        ["a", a],
        ["b", b],
      ] as const)
        assert.equal(
          (
            await post(credential, {
              hook_event_name: "SessionStart",
              session_id: `native-${id}`,
            })
          ).status,
          200,
        );
    assert.equal((await post(a, permission(), a.token)).status, 401);
    const appeared = once(requests, "change");
    const waiting = post(a, permission());
    await appeared;
    auto.set("a", true);
    assert.equal(
      (await (await waiting).json()).hookSpecificOutput.decision.behavior,
      "allow",
    );
    for (let i = 0; i < 34; i++) {
      const response = await post(a, permission());
      assert.equal(response.status, 200);
      assert.equal(
        (await response.json()).hookSpecificOutput.decision.behavior,
        "allow",
      );
    }
    assert.equal(auto.state("a").accepted, 35);
    assert.equal(
      requests
        .list()
        .filter(
          (item) =>
            item.answeredBy === "automatic" && item.status === "consumed",
        ).length,
      35,
    );
    const otherAppeared = once(requests, "change");
    const other = post(b, permission("native-b"));
    await otherAppeared;
    const pending = requests.list().find((item) => item.status === "pending")!;
    assert.equal(pending.terminal.terminalId, "b");
    requests.respond(pending.id, { text: "", optionId: "deny" });
    assert.equal(
      (await (await other).json()).hookSpecificOutput.decision.behavior,
      "deny",
    );
    auto.set("a", false);
    const offAppeared = once(requests, "change");
    const off = post(a, permission());
    await offAppeared;
    const manual = requests.list().find((item) => item.status === "pending")!;
    requests.cancel(manual.id);
    assert.deepEqual(await (await off).json(), {});
  });
