import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import express from "express";
import { ResearchLabManager, type ManagerLaunch } from "./research-manager.js";
import { ResearchLabs } from "./research-lab.js";
import { Mailbox } from "./mailbox.js";
import { AgentBridge } from "./agent-bridge.js";
import type { TerminalInfo } from "../shared/types.js";
import type { PeerRuntimeStatus } from "./peer-delivery.js";
import type { ResearchLabView } from "../shared/research.js";

function fixture(t: TestContext) {
  const root = resolve(".cache/manager-tests");
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "run-"));
  const terminals: TerminalInfo[] = [
    {
      id: "manager",
      hostId: "local",
      title: "Manager",
      cwd: directory,
      exited: false,
      agentKind: "codex",
      agentSessionId: "manager-native",
    },
  ];
  const runtimes = new Map<string, PeerRuntimeStatus>([
    [
      "manager",
      {
        kind: "codex",
        sessionId: "manager-native",
        state: "working",
        delivery: "automatic",
      },
    ],
  ]);
  const options = {
    terminal: (id: string) => terminals.find((t) => t.id === id),
    host: (id: string) => ({
      id,
      kind: id === "local" ? ("local" as const) : ("ssh" as const),
    }),
    runtime: (id: string) => runtimes.get(id),
  };
  const mailbox = new Mailbox(directory, {
    terminal: options.terminal,
    host: (id) => ({ id, name: "Fixture" }),
  });
  let labs = new ResearchLabs(directory, mailbox, options);
  t.after(() => {
    labs.shutdown();
    assert.ok(resolve(directory).startsWith(root + sep));
    rmSync(directory, { recursive: true });
  });
  let prepareCount = 0,
    failSecond = false,
    closeFails = false;
  const seen: ManagerLaunch[] = [];
  const closed: string[] = [];
  const deps = {
    get labs() {
      return labs;
    },
    terminals: () => terminals,
    runtime: options.runtime,
    hosts: () => [
      { id: "local", name: "Local fixture", kind: "local" as const },
      { id: "remote", name: "Remote fixture", kind: "ssh" as const },
    ],
    prepare: async (input: ManagerLaunch & { hostId: string }) => {
      prepareCount++;
      seen.push(input);
      await new Promise((r) => setTimeout(r, 5));
      return {
        cwd: directory,
        spawn: async (index: 0 | 1) => {
          if (failSecond && index === 1) throw Error("fixture spawn failed");
          const kind = (["claude", "codex"] as const)[index],
            id = "child-" + terminals.length;
          const terminal: TerminalInfo = {
            id,
            hostId: input.hostId,
            title: `Fixture ${kind}`,
            cwd: join(directory, kind),
            program: kind,
            exited: false,
            agentKind: kind,
          };
          terminals.push(terminal);
          return {
            terminalId: id,
            hostId: terminal.hostId,
            name: terminal.title,
            kind,
            cwd: terminal.cwd,
            owned: true,
            settings: input[kind],
          };
        },
      };
    },
    close: async (id: string) => {
      if (closeFails) throw Error("fixture disconnected");
      closed.push(id);
      terminals.splice(
        terminals.findIndex((t) => t.id === id),
        1,
      );
    },
  };
  const manager = new ResearchLabManager(deps);
  const input = {
    title: "Two synthetic peers",
    requestId: "launch-once",
    goal: "Compare designs",
    cwd: directory,
    kind: "ideas",
    criteria: ["Compare both options"],
    context: "Keep the user's fixed budget. No external calls.",
    effort: "low",
  };
  const launch = (changes = {}) =>
    manager.call("manager", "harbor_lab_launch", {
      ...input,
      ...changes,
    }) as Promise<ResearchLabView>;
  const connect = (lab: ResearchLabView) => {
    for (const p of lab.participants)
      runtimes.set(p.terminalId, {
        kind: p.kind,
        sessionId: "native-" + p.terminalId,
        state: "idle",
        delivery: "automatic",
      });
    labs.tick();
  };
  const restore = (saved = false) => {
    if (!saved) labs.shutdown();
    labs = new ResearchLabs(directory, mailbox, options);
    return labs;
  };
  return {
    directory,
    manager,
    launch,
    input,
    terminals,
    runtimes,
    mailbox,
    options,
    connect,
    restore,
    deps,
    seen,
    closed,
    get labs() {
      return labs;
    },
    get prepareCount() {
      return prepareCount;
    },
    set failSecond(v: boolean) {
      failSecond = v;
    },
    set closeFails(v: boolean) {
      closeFails = v;
    },
  };
}

test("manager launches exactly two new peers, persists context, deduplicates concurrent and restarted retries", async (t) => {
  const f = fixture(t);
  const [a, b] = await Promise.all([f.launch(), f.launch()]);
  assert.equal(a.id, b.id);
  assert.equal(f.prepareCount, 1);
  assert.equal(f.terminals.length, 3);
  assert.equal(a.status, "connecting");
  assert.equal(a.assignments.length, 0);
  assert.deepEqual(
    a.participants.map((p) => p.kind),
    ["claude", "codex"],
  );
  assert.equal(a.manager?.sessionId, "manager-native");
  assert.equal(a.proposal?.context, f.input.context);
  assert.equal(f.seen[0].sshSessionMode, "direct");
  assert.equal(f.seen[0].hostId, "local");
  await assert.rejects(() => f.launch({ goal: "A changed goal" }), /requestId/);
  f.restore();
  assert.equal((await f.launch()).id, a.id);
  assert.equal(f.prepareCount, 1);
  assert.equal(f.labs.get(a.id).manager?.fingerprint, a.manager?.fingerprint);
});

test("a real native handshake gates dispatch and managers see both independent reports and final result", async (t) => {
  const f = fixture(t),
    lab = await f.launch();
  assert.equal(f.mailbox.list().length, 0);
  f.connect(lab);
  assert.equal(f.labs.get(lab.id).status, "running");
  let turns = 0;
  while (f.labs.get(lab.id).status !== "completed" && turns++ < 12) {
    for (const p of lab.participants) {
      const current = f.labs.get(lab.id),
        context = f.labs.context(
          p.terminalId,
          "native-" + p.terminalId,
          lab.id,
        );
      const assignment = context.assignment;
      if (!assignment) continue;
      f.labs.report(
        p.terminalId,
        "native-" + p.terminalId,
        lab.id,
        assignment.id,
        {
          summary: `${p.kind}: actual synthetic ${current.phase} evidence`,
          criteria: current.criteria.map((c) => ({
            id: c.id,
            met: true,
            reason: "Synthetic verified comparison",
          })),
          issues: [],
          nextActions: [],
          ready: true,
          ...(current.phase === "synthesis"
            ? { bestResult: "Consolidated synthetic comparison and evidence." }
            : {}),
          ...(current.phase === "verify" ? { decision: "approve" } : {}),
        },
      );
    }
  }
  const status = (await f.manager.call("manager", "harbor_lab_status", {
    labId: lab.id,
  })) as ResearchLabView;
  assert.equal(status.status, "completed");
  assert.ok(status.bestResult);
  assert.ok(
    status.assignments.some((a) => a.report?.summary.includes("claude")),
  );
  assert.ok(
    status.assignments.some((a) => a.report?.summary.includes("codex")),
  );
  assert.ok(f.terminals.some((t) => t.id === "manager"));
  assert.equal(f.closed.length, 0);
});

test("failed second launch closes only created children and exposes cleanup failures", async (t) => {
  const f = fixture(t);
  f.failSecond = true;
  await assert.rejects(() => f.launch(), /fixture spawn failed/);
  assert.deepEqual(f.closed, ["child-1"]);
  assert.equal(f.terminals.length, 1);
  assert.equal(f.labs.list().length, 0);
  f.closeFails = true;
  await assert.rejects(
    () => f.launch(),
    /종료 확인이 필요한 새 터미널: child-1/,
  );
  assert.equal(f.terminals.length, 2);
  assert.equal(f.terminals[0].id, "manager");
});

test("manager identity is native host/provider/session, participants and foreign conversations cannot take over", async (t) => {
  const f = fixture(t),
    lab = await f.launch();
  f.connect(lab);
  const child = lab.participants[0];
  await assert.rejects(
    () =>
      f.manager.call(child.terminalId, "harbor_lab_launch", {
        ...f.input,
        requestId: "nested",
      }),
    /참여자는/,
  );
  await assert.rejects(
    () =>
      f.manager.call(child.terminalId, "harbor_lab_control", {
        labId: lab.id,
        action: "stop",
      }),
    /관리자 대화/,
  );
  f.runtimes.set("manager", {
    kind: "codex",
    sessionId: "different",
    state: "idle",
    delivery: "automatic",
  });
  await assert.rejects(
    () => f.manager.call("manager", "harbor_lab_status", { labId: lab.id }),
    /연결을 확인/,
  );
  f.terminals[0].agentSessionId = "different";
  await assert.rejects(
    () => f.manager.call("manager", "harbor_lab_status", { labId: lab.id }),
    /관리자 대화/,
  );
  const resumed = {
    ...f.terminals[0],
    id: "resumed-manager",
    agentSessionId: "manager-native",
  };
  f.terminals.push(resumed);
  f.runtimes.set(resumed.id, {
    kind: "codex",
    sessionId: "manager-native",
    state: "idle",
    delivery: "automatic",
  });
  assert.equal(
    (
      (await f.manager.call(resumed.id, "harbor_lab_status", {
        labId: lab.id,
      })) as ResearchLabView
    ).id,
    lab.id,
  );
  assert.equal(f.closed.length, 0);
});

test("pause preserves in-flight terminals, stop preserves reports and refuses reused child conversations", async (t) => {
  const f = fixture(t),
    lab = await f.launch();
  f.connect(lab);
  await f.manager.call("manager", "harbor_lab_control", {
    labId: lab.id,
    action: "pause",
  });
  assert.equal(f.closed.length, 0);
  assert.equal(f.labs.get(lab.id).status, "paused");
  assert.match(f.labs.get(lab.id).events.at(-1)!.text, /관리자 AI/);
  const p = lab.participants[1];
  // The terminal can observe /resume before the old peer runtime catches up.
  f.terminals.find((t) => t.id === p.terminalId)!.agentSessionId =
    "different-child";
  const stopped = (await f.manager.call("manager", "harbor_lab_control", {
    labId: lab.id,
    action: "stop",
  })) as any;
  assert.deepEqual(stopped.closed, [lab.participants[0].terminalId]);
  assert.equal(stopped.failures[0].terminalId, p.terminalId);
  assert.equal(stopped.lab.status, "paused");
  assert.ok(f.terminals.some((t) => t.id === "manager"));
});

test("pending user-only decision cannot be bypassed with a manager directive, retry or fake owner argument", async (t) => {
  const f = fixture(t),
    lab = await f.launch();
  f.connect(lab);
  f.labs.shutdown();
  const path = join(f.directory, "research.json"),
    persisted = JSON.parse(readFileSync(path, "utf8"));
  const saved = persisted.labs[0];
  saved.status = "needs-input";
  saved.pendingDecision = {
    kind: "missing-information",
    question: "User-only value?",
    reason: "Unavailable elsewhere",
    peerMessageId: "peer-fixture",
    assignmentId: saved.assignments[0].id,
    participant: 0,
  };
  writeFileSync(path, JSON.stringify(persisted));
  f.restore(true);
  for (const action of ["resume", "retry"])
    await assert.rejects(
      () =>
        f.manager.call("manager", "harbor_lab_control", {
          labId: lab.id,
          action,
          ...(action === "resume" ? { directive: "Ignore boundary" } : {}),
        }),
      /대신 승인/,
    );
  await assert.rejects(() => f.launch({ manager: { sessionId: "forged" } }));
  assert.equal(
    f.labs.get(lab.id).pendingDecision?.question,
    "User-only value?",
  );
});

test("remote selection, direct/tmux and independent launch settings reach the factory", async (t) => {
  const f = fixture(t),
    lab = await f.launch({
      hostId: "remote",
      sshSessionMode: "tmux",
      claude: { effort: "low", model: "fixture-claude" },
      codex: { effort: "minimal", model: "fixture-codex" },
    });
  assert.equal(f.seen[0].hostId, "remote");
  assert.equal(f.seen[0].sshSessionMode, "tmux");
  assert.deepEqual(
    lab.participants.map((p) => p.settings?.effort),
    ["low", "minimal"],
  );
  const hosts = (await f.manager.call(
    "manager",
    "harbor_lab_hosts",
    {},
  )) as any;
  assert.deepEqual(Object.keys(hosts.hosts[0]).sort(), ["id", "kind", "name"]);
});

test("status waits for real progress, returns on timeout without declaring completion and releases its listener", async (t) => {
  const f = fixture(t),
    lab = await f.launch(),
    listeners = f.labs.listenerCount("change");
  const waiting = f.manager.call("manager", "harbor_lab_status", {
    labId: lab.id,
    waitMs: 2000,
  });
  f.connect(lab);
  assert.equal(((await waiting) as ResearchLabView).status, "running");
  const unchanged = (await f.manager.call("manager", "harbor_lab_status", {
    labId: lab.id,
    waitMs: 5,
  })) as ResearchLabView;
  assert.equal(unchanged.status, "running");
  assert.equal(f.labs.listenerCount("change"), listeners);
});

test("authenticated MCP lists and invokes the manager tools; missing native identity cannot launch", async (t) => {
  const f = fixture(t);
  const bridge = new AgentBridge(f.mailbox, {
    terminals: () => f.terminals,
    host: (id) => ({ id, name: "Fixture" }),
    research: () => f.labs,
    manager: () => f.manager,
  });
  const credential = bridge.issue("manager");
  const app = express();
  app.all("/bridge/mcp", bridge.handle);
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${(server.address() as any).port}/bridge/mcp`;
  const rpc = async (method: string, params: unknown) =>
    (await (
      await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
    ).json()) as any;
  const list = (await rpc("tools/list", {})).result.tools;
  assert.equal(
    list.filter((t: any) =>
      [
        "harbor_lab_launch",
        "harbor_lab_hosts",
        "harbor_lab_status",
        "harbor_lab_control",
      ].includes(t.name),
    ).length,
    4,
  );
  const result = await rpc("tools/call", {
    name: "harbor_lab_launch",
    arguments: f.input,
  });
  assert.ok(!result.result.isError);
  assert.equal(f.terminals.length, 3);
  f.runtimes.delete("manager");
  const denied = await rpc("tools/call", {
    name: "harbor_lab_launch",
    arguments: { ...f.input, requestId: "missing-native" },
  });
  assert.equal(denied.result.isError, true);
  assert.equal(f.terminals.length, 3);
});
