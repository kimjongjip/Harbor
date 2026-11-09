import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { Mailbox } from "./mailbox.js";
import { ResearchLabs } from "./research-lab.js";
import { PeerDelivery, type PeerRuntimeStatus } from "./peer-delivery.js";
import type { TerminalInfo } from "../shared/types.js";
import type { ResearchLab, ResearchReport } from "../shared/research.js";
import { codexPeerPrompt } from "./codex-peer-runtime.js";
import { powershellInitialization } from "./terminal-shell.js";
import { Store } from "./store.js";
import { researchConversation } from "./research-conversation.js";
import type { HistoryDetail } from "../shared/history.js";
import express from "express";
import { createServer } from "node:http";
import { once } from "node:events";
import { AgentBridge } from "./agent-bridge.js";
import { Requests } from "./requests.js";

function prepare(f: ReturnType<typeof fixture>) {
  return f.labs.prepare(
    {
      title: "Prepare together",
      cwd: f.directory,
      leadKind: "claude",
      effort: "low",
    },
    participant(f, 0),
  );
}

test("native turn failure pauses only the bound unfinished research job and keeps reports/revision for explicit retry", (t) => {
  const f = fixture(t),
    lab = f.create();
  submit(f, lab.id, 0, report(lab, true));
  const before = f.labs.get(lab.id);
  f.labs.nativeFailure("terminal-1", "unrelated", "Must ignore");
  f.labs.nativeFailure("terminal-0", "conversation-0", "Already submitted");
  assert.equal(f.labs.get(lab.id).status, "running");
  f.labs.nativeFailure(
    "terminal-1",
    "conversation-1",
    "Codex 모델을 사용할 수 없습니다.",
  );
  const failed = f.labs.get(lab.id);
  assert.equal(failed.status, "paused");
  assert.equal(failed.revision, before.revision);
  assert.equal(failed.phase, before.phase);
  assert.deepEqual(failed.assignments, before.assignments);
  assert.deepEqual(failed.participants, before.participants);
  assert.match(failed.attention!, /Codex 모델/);
  f.labs.tick();
  assert.equal(f.labs.get(lab.id).status, "paused");
  f.labs.control(lab.id, "resume");
  f.labs.control(lab.id, "retry");
  const retried = f.labs.get(lab.id);
  assert.equal(retried.revision, before.revision);
  assert.deepEqual(retried.assignments[0], before.assignments[0]);
  assert.equal(retried.assignments[1].id, before.assignments[1].id);
  assert.ok(
    retried.assignments[1].messageIds.length >
      before.assignments[1].messageIds.length,
  );
});

test("native preparation failure is visible without turning a one-AI conversation into joint work", (t) => {
  const f = fixture(t),
    lab = prepare(f);
  f.labs.nativeFailure("terminal-0", "conversation-0", "Native failure");
  const failed = f.labs.get(lab.id);
  assert.equal(failed.status, "preparing");
  assert.equal(failed.participants.length, 1);
  assert.equal(failed.assignments.length, 0);
  assert.match(failed.attention!, /Native failure/);
  assert.equal(f.mailbox.list().length, 0);
});
function participant(f: ReturnType<typeof fixture>, index: number) {
  const t = f.terminals[index];
  return {
    terminalId: t.id,
    hostId: t.hostId,
    name: t.title,
    kind: t.agentKind!,
    cwd: t.cwd,
    owned: false,
  };
}
const proposal = {
  goal: "Compare two research directions",
  kind: "ideas" as const,
  criteria: ["Compare evidence", "Recommend a validation experiment"],
  context: "The user chose a low-cost experiment.",
};
const startInput = (lab: ResearchLab) => ({
  ...proposal,
  revision: lab.revision,
  partnerKind: "codex" as const,
  manualContext: true,
});

test("preparing has one native conversation and no assignments; a plan request is scoped and never starts collaboration", (t) => {
  const f = fixture(t),
    lab = prepare(f);
  assert.equal(lab.status, "preparing");
  assert.equal(lab.phase, "preparation");
  assert.equal(lab.participants.length, 1);
  assert.equal(lab.goal, "");
  f.labs.tick();
  assert.equal(f.mailbox.list().length, 0);
  assert.equal(f.labs.get(lab.id).assignments.length, 0);
  assert.throws(
    () => f.labs.control(lab.id, "resume", "Start now"),
    /준비 중에는/,
  );
  const request = f.labs.requestPlan(lab.id);
  assert.equal(f.labs.requestPlan(lab.id).messageId, request.messageId);
  const message = f.mailbox.find(request.messageId)!;
  assert.equal(message.recipient.sessionId, "conversation-0");
  assert.match(codexPeerPrompt(message as any), /harbor_lab_plan/);
  assert.match(
    codexPeerPrompt(message as any),
    /Do not submit harbor_lab_report/,
  );
  const context = f.labs.context("terminal-0", "conversation-0", lab.id);
  assert.equal(context.assignment, undefined);
  assert.deepEqual(context.peers, []);
  assert.ok(f.mailbox.find(request.messageId)?.consumedAt);
  f.labs.plan("terminal-0", "conversation-0", lab.id, proposal);
  const saved = f.labs.get(lab.id);
  assert.equal(saved.proposal?.source, "agent");
  assert.equal(saved.status, "preparing");
  assert.equal(saved.assignments.length, 0);
  assert.equal(saved.participants.length, 1);
});

test("plan requests distinguish manual queuing, actual receipt and saved plans across refresh and restart", (t) => {
  const f = fixture(t),
    lab = prepare(f);
  f.runtimes.get("terminal-0")!.delivery = "poll";
  const request = f.labs.requestPlan(lab.id);
  assert.equal(request.automatic, false);
  assert.equal(request.state, "queued");
  assert.equal(f.labs.list()[0].planRequest?.messageId, request.messageId);
  assert.equal(f.labs.requestPlan(lab.id).messageId, request.messageId);
  f.mailbox.offer("terminal-0", request.messageId, "conversation-0");
  assert.equal(f.labs.list()[0].planRequest?.state, "offered");
  f.labs.context("terminal-0", "conversation-0", lab.id);
  assert.equal(f.labs.list()[0].planRequest?.state, "consumed");
  f.labs.plan("terminal-0", "conversation-0", lab.id, proposal);
  assert.equal(f.labs.list()[0].planRequest?.state, "saved");
  assert.equal(f.labs.get(lab.id).status, "preparing");
  const restored = new ResearchLabs(f.directory, f.mailbox, f.options);
  assert.equal(restored.list()[0].planRequest?.state, "saved");
});

test("a disconnected lead can save a user draft but cannot silently start native collaboration", (t) => {
  const f = fixture(t),
    lab = prepare(f);
  f.runtimes.get("terminal-0")!.state = "offline";
  const saved = f.labs.proposal(lab.id, proposal, "user", lab.revision);
  assert.equal(saved.proposal?.goal, proposal.goal);
  assert.equal(saved.proposal?.source, "user");
  assert.equal(saved.status, "preparing");
  assert.throws(
    () => f.labs.start(lab.id, startInput(saved), participant(f, 1)),
    /실행 중|원래 대화/,
  );
  assert.equal(f.mailbox.list().length, 0);
});

test("lead and partner keep independent launch model and effort through joint start and restart", (t) => {
  const f = fixture(t);
  const leadSettings = { model: "opus", effort: "high" as const };
  const partnerSettings = {
    model: "fixture-codex-model",
    effort: "xhigh" as const,
  };
  const lab = f.labs.prepare(
    {
      title: "Independent settings",
      cwd: f.directory,
      leadKind: "claude",
      effort: "low",
      agentSettings: leadSettings,
    },
    { ...participant(f, 0), owned: true },
  );
  assert.deepEqual(lab.participants[0].settings, leadSettings);
  const started = f.labs.start(
    lab.id,
    { ...startInput(lab), partnerSettings },
    { ...participant(f, 1), owned: true },
  );
  assert.deepEqual(
    started.participants.map((p) => p.settings),
    [leadSettings, partnerSettings],
  );
  assert.deepEqual(
    started.participants.map((p) => p.sessionId),
    ["conversation-0", "conversation-1"],
  );
  const restored = new ResearchLabs(f.directory, f.mailbox, f.options);
  assert.deepEqual(
    restored.get(lab.id).participants.map((p) => p.settings),
    [leadSettings, partnerSettings],
  );
  assert.equal(restored.get(lab.id).status, "paused");
});

test("existing conversations retain their launch record and reject requested model overrides without starting or changing native settings", (t) => {
  const f = fixture(t);
  const settings = { model: "existing-fixture", effort: "medium" as const };
  const input = {
    title: "Existing conversation",
    cwd: f.directory,
    leadKind: "claude" as const,
    effort: "low" as const,
    terminalId: "terminal-0",
  };
  assert.throws(
    () =>
      f.labs.prepare({ ...input, agentSettings: settings }, participant(f, 0)),
    /해당 CLI/,
  );
  assert.equal(f.labs.list().length, 0);
  const lab = f.labs.prepare(input, { ...participant(f, 0), settings });
  const before = structuredClone([...f.runtimes]);
  assert.throws(
    () =>
      f.labs.start(
        lab.id,
        {
          ...startInput(lab),
          partnerSettings: settings,
          partnerTerminalId: "terminal-1",
        },
        participant(f, 1),
      ),
    /해당 CLI/,
  );
  assert.equal(f.labs.get(lab.id).status, "preparing");
  assert.deepEqual(f.labs.get(lab.id).participants[0].settings, settings);
  assert.deepEqual([...f.runtimes], before);
  const started = f.labs.start(lab.id, startInput(lab), participant(f, 1));
  assert.equal(started.participants[1].settings, undefined);
  assert.deepEqual(started.participants[0].settings, settings);
});

test("unsupported lead effort never creates a lab or reserves its existing native conversation", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      f.labs.prepare(
        {
          title: "Invalid launch",
          cwd: f.directory,
          leadKind: "claude",
          effort: "low",
          agentSettings: { effort: "ultra" },
        },
        { ...participant(f, 0), owned: true },
      ),
    /지원하지 않는/,
  );
  assert.deepEqual(f.labs.list(), []);
  assert.equal(prepare(f).participants[0].sessionId, "conversation-0");
});

test("only the lead's original conversation can propose a plan; stale plans and missing context cannot start", (t) => {
  const f = fixture(t),
    lab = prepare(f);
  assert.throws(
    () => f.labs.plan("terminal-1", "conversation-1", lab.id, proposal),
    /참여하는/,
  );
  assert.throws(
    () => f.labs.plan("terminal-0", "different-conversation", lab.id, proposal),
    /참여하는/,
  );
  assert.throws(
    () =>
      f.labs.start(
        lab.id,
        { ...startInput(lab), context: "" },
        participant(f, 1),
      ),
    /배경을 입력/,
  );
  assert.throws(
    () =>
      f.labs.start(
        lab.id,
        { ...startInput(lab), manualContext: false },
        participant(f, 1),
      ),
    /기록을 읽지/,
  );
  f.labs.plan("terminal-0", "conversation-0", lab.id, proposal);
  assert.throws(
    () => f.labs.start(lab.id, startInput(lab), participant(f, 1)),
    /변경되었습니다/,
  );
  assert.throws(
    () => f.labs.proposal(lab.id, proposal, "user", lab.revision),
    /변경되었습니다/,
  );
  assert.equal(f.labs.get(lab.id).participants.length, 1);
  assert.equal(f.labs.get(lab.id).assignments.length, 0);
});

test("explicit joint start keeps the lead and shares its actual visible native conversation with the partner", (t) => {
  const f = fixture(t),
    lab = prepare(f);
  const conversation = {
    text: "[사용자]\nCost matters\n\n[AI]\nCompare a small experiment",
    sessionId: "conversation-0",
    hostId: "local",
    items: 2,
    capturedAt: Date.now(),
    truncated: false,
  };
  assert.throws(
    () =>
      f.labs.start(
        lab.id,
        { ...startInput(lab), manualContext: false },
        participant(f, 1),
        { ...conversation, sessionId: "wrong" },
      ),
    /기록을 읽지/,
  );
  f.runtimes.get("terminal-0")!.state = "working";
  assert.throws(
    () => f.labs.start(lab.id, startInput(lab), participant(f, 1)),
    /답변이 끝난/,
  );
  f.runtimes.get("terminal-0")!.state = "idle";
  const started = f.labs.start(
    lab.id,
    { ...startInput(lab), manualContext: false },
    participant(f, 1),
    conversation,
  );
  assert.equal(started.status, "running");
  assert.equal(started.assignments.length, 2);
  assert.equal(
    started.participants[0].terminalId,
    lab.participants[0].terminalId,
  );
  assert.equal(
    started.participants[0].sessionId,
    lab.participants[0].sessionId,
  );
  const ctx = f.labs.context("terminal-1", "conversation-1", lab.id);
  assert.equal(ctx.preparationConversation?.text, conversation.text);
  assert.equal(ctx.proposal?.context, proposal.context);
  assert.equal(ctx.goal, proposal.goal);
  assert.deepEqual(ctx.reports, []);
  assert.throws(
    () => f.labs.plan("terminal-0", "conversation-0", lab.id, proposal),
    /준비 중인/,
  );
  const previousJob = started.assignments[0];
  f.labs.control(lab.id, "resume", "Focus on the cheaper direction.");
  const updated = f.labs.context("terminal-1", "conversation-1", lab.id);
  assert.deepEqual(updated.directives, ["Focus on the cheaper direction."]);
  assert.equal(updated.preparationConversation?.text, conversation.text);
  assert.throws(
    () =>
      f.labs.report(
        "terminal-0",
        "conversation-0",
        lab.id,
        previousJob.id,
        report(started, false),
      ),
    /바뀌었습니다/,
  );
});

test("preparation persists across restart, rebinds just the original lead and can release its membership without closing terminals", (t) => {
  const f = fixture(t),
    lab = prepare(f);
  f.labs.plan("terminal-0", "conversation-0", lab.id, proposal);
  f.labs.shutdown();
  const restored = new ResearchLabs(f.directory, f.mailbox, f.options);
  assert.equal(restored.get(lab.id).status, "preparing");
  assert.equal(restored.get(lab.id).proposal?.context, proposal.context);
  f.terminals.push({ ...f.terminals[0], id: "restored-lead" });
  f.runtimes.set("restored-lead", {
    ...f.runtimes.get("terminal-0")!,
    sessionId: "other",
  });
  assert.throws(
    () => restored.rebind(lab.id, ["restored-lead"]),
    /기존 대화 ID/,
  );
  f.runtimes.get("restored-lead")!.sessionId = "conversation-0";
  restored.rebind(lab.id, ["restored-lead"]);
  assert.equal(
    restored.context("restored-lead", "conversation-0", lab.id).status,
    "preparing",
  );
  restored.removePreparation(lab.id);
  assert.equal(restored.list().length, 0);
  assert.ok(f.terminals.every((terminal) => !terminal.exited));
});

test("preparation and explicit start preserve each participant's own server and native identity", (t) => {
  const f = fixture(t);
  f.terminals[0].hostId = "fixture-ssh";
  f.terminals[0].cwd = "/srv/fixture";
  const lab = f.labs.prepare(
    {
      title: "Remote lead",
      hostId: "fixture-ssh",
      cwd: "/srv/fixture",
      leadKind: "claude",
      effort: "low",
    },
    participant(f, 0),
  );
  const started = f.labs.start(lab.id, startInput(lab), participant(f, 1));
  assert.equal(started.hostId, "fixture-ssh");
  assert.deepEqual(
    started.participants.map((p) => p.hostId),
    ["fixture-ssh", "local"],
  );
  assert.deepEqual(
    f.labs.context("terminal-1", "conversation-1", lab.id).referenceProject,
    { hostId: "fixture-ssh", cwd: "/srv/fixture" },
  );
});

test("conversation sharing excludes tool output and notices, bounds recent text, and discloses pagination", () => {
  const detail: HistoryDetail = {
    thread: {
      id: "native-id",
      hostId: "fixture-host",
      title: "fixture",
      cwd: "/fixture",
      preview: "",
      updatedAt: 0,
      source: "fixture",
      active: true,
    },
    nextCursor: "older",
    items: [
      { id: "a", kind: "user", text: "Question" },
      { id: "b", kind: "tool", text: "Private tool result" },
      { id: "c", kind: "notice", text: "Runtime notice" },
      { id: "d", kind: "assistant", text: "Answer" },
    ],
  };
  const snapshot = researchConversation(detail);
  assert.match(snapshot.text, /Question/);
  assert.match(snapshot.text, /Answer/);
  assert.doesNotMatch(snapshot.text, /Private|Runtime/);
  assert.equal(snapshot.items, 2);
  assert.equal(snapshot.truncated, true);
  detail.items.push({
    id: "long",
    kind: "assistant",
    text: "x".repeat(33000) + "Most recent decision",
  });
  const bounded = researchConversation(detail);
  assert.ok(bounded.text.length <= 32000);
  assert.match(bounded.text, /Most recent decision$/);
});

test("authenticated MCP exposes proposal tools for both CLI providers without granting another native session access", async (t) => {
  const f = fixture(t),
    lab = prepare(f);
  const bridge = new AgentBridge(f.mailbox, {
    terminals: () => f.terminals,
    host: (id) => ({ id, name: "Fixture" }),
    research: () => f.labs,
  });
  const lead = bridge.issue("terminal-0"),
    peer = bridge.issue("terminal-1");
  bridge.peers.setRuntime("terminal-0", f.runtimes.get("terminal-0")!);
  bridge.peers.setRuntime("terminal-1", f.runtimes.get("terminal-1")!);
  const app = express();
  app.all("/bridge/mcp", bridge.handle);
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as any).port}/bridge/mcp`;
  const rpc = async (token: string, method: string, params: unknown) =>
    (await (
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
    ).json()) as any;
  const tools = (await rpc(lead.token, "tools/list", {})).result.tools;
  assert.ok(tools.some((tool: any) => tool.name === "harbor_lab_plan"));
  const denied = await rpc(peer.token, "tools/call", {
    name: "harbor_lab_plan",
    arguments: { labId: lab.id, ...proposal },
  });
  assert.equal(denied.result.isError, true);
  const saved = await rpc(lead.token, "tools/call", {
    name: "harbor_lab_plan",
    arguments: { labId: lab.id, ...proposal },
  });
  assert.ok(!saved.result.isError);
  assert.equal(f.labs.get(lab.id).status, "preparing");
  assert.equal(f.labs.get(lab.id).assignments.length, 0);
});

function fixture(t: any, connected = true) {
  const parent = resolve(".cache/research-tests");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "run-"));
  t.after(() => {
    assert.ok(resolve(directory).startsWith(parent + sep));
    rmSync(directory, { recursive: true, force: true });
  });
  const terminals: TerminalInfo[] = ["claude", "codex"].map((kind, i) => ({
    id: `terminal-${i}`,
    hostId: "local",
    cwd: directory,
    title: `Research ${kind}`,
    exited: false,
    program: kind as "claude" | "codex",
    agentKind: kind as "claude" | "codex",
  }));
  const runtimes = new Map<string, PeerRuntimeStatus>(
    connected
      ? terminals.map((terminal, i) => [
          terminal.id,
          {
            kind: terminal.agentKind!,
            sessionId: `conversation-${i}`,
            state: "idle",
            delivery: "automatic",
          },
        ])
      : [],
  );
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
    host: (id) => ({ id, name: "Fixture local" }),
  });
  const labs = new ResearchLabs(directory, mailbox, options);
  const create = () =>
    labs.create(
      {
        title: "Synthetic research",
        goal: "Compare two fictional ideas and justify a recommendation.",
        kind: "ideas",
        cwd: directory,
        criteria: ["Compare alternatives", "Explain evidence"],
        effort: "low",
      },
      terminals.map((t) => ({
        terminalId: t.id,
        name: t.title,
        kind: t.agentKind!,
        cwd: t.cwd,
        owned: false,
      })),
    );
  return { directory, labs, create, mailbox, options, runtimes, terminals };
}
function report(
  lab: ResearchLab,
  ready: boolean,
  summary = "Actual fixture analysis",
): ResearchReport {
  return {
    summary,
    criteria: lab.criteria.map((c) => ({
      id: c.id,
      met: ready,
      reason: ready ? "Evidence reviewed" : "Still needs investigation",
    })),
    issues: ready ? [] : ["Need a comparison"],
    nextActions: ready ? [] : ["Investigate the alternative"],
    ready,
  };
}
function submit(
  f: ReturnType<typeof fixture>,
  labId: string,
  participant: number,
  input: ResearchReport,
) {
  const lab = f.labs.get(labId);
  const job = lab.assignments.find(
    (j) =>
      j.revision === lab.revision &&
      j.phase === lab.phase &&
      j.cycle === lab.cycle &&
      j.participant === participant &&
      !j.report,
  )!;
  assert.ok(job, "Participant has a real current assignment");
  return f.labs.report(
    `terminal-${participant}`,
    `conversation-${participant}`,
    labId,
    job.id,
    input,
  );
}
function analysis(f: ReturnType<typeof fixture>, lab: ResearchLab) {
  submit(f, lab.id, 0, report(lab, false, "Claude initial independent view"));
  submit(f, lab.id, 1, report(lab, false, "Codex initial independent view"));
}

test("deleting active research removes delivered assignments and scoped question threads without touching native sessions or files", (t) => {
  const f = fixture(t),
    lab = f.create();
  analysis(f, lab);
  const question = f.mailbox.sendAgent(
    "terminal-0",
    "terminal-1",
    "Review this",
    {
      senderSessionId: "conversation-0",
      recipientSessionId: "conversation-1",
      labId: lab.id,
    },
  );
  const assignmentMessage = f.mailbox
    .list()
    .find(
      (m) =>
        m.research?.labId === lab.id && m.recipient.terminalId === "terminal-1",
    )!;
  f.mailbox.replyAgent(
    "terminal-1",
    assignmentMessage.id,
    "Acknowledged assignment",
    "conversation-1",
  );
  f.mailbox.replyAgent("terminal-1", question.id, "Reviewed", "conversation-1");
  const unrelated = f.mailbox.send({
    toTerminalId: "terminal-0",
    text: "Keep this personal message",
  });
  for (const message of f.mailbox
    .list()
    .filter((m) => m.research?.labId === lab.id))
    f.mailbox.offer(
      message.recipient.terminalId!,
      message.id,
      message.recipient.sessionId!,
    );
  const projectFile = join(f.directory, "project.md");
  writeFileSync(projectFile, "Keep project contents");
  const terminals = structuredClone(f.terminals),
    runtimes = structuredClone([...f.runtimes]);
  const messagesRemoved = f.mailbox.list().length - 1;
  assert.deepEqual(f.labs.remove([lab.id]), { removed: 1, messagesRemoved });
  f.labs.tick();
  assert.deepEqual(f.labs.list(), []);
  assert.deepEqual(
    f.mailbox.list().map((m) => m.id),
    [unrelated.id],
  );
  assert.deepEqual(f.terminals, terminals);
  assert.deepEqual([...f.runtimes], runtimes);
  assert.equal(readFileSync(projectFile, "utf8"), "Keep project contents");
  assert.throws(() => f.labs.context("terminal-0", "conversation-0", lab.id));
  const restored = new ResearchLabs(f.directory, f.mailbox, f.options);
  assert.deepEqual(restored.list(), []);
  assert.equal(prepare(f).participants[0].sessionId, "conversation-0");
});

test("bulk deletion validates every lab before removing anything and preserves active resource reservations", (t) => {
  const f = fixture(t),
    lab = f.create();
  analysis(f, lab);
  submit(f, lab.id, 0, report(lab, false));
  submit(f, lab.id, 1, report(lab, false));
  const job = f.labs.context(
    "terminal-0",
    "conversation-0",
    lab.id,
  ).assignment!;
  const input = {
    labId: lab.id,
    assignmentId: job.id,
    title: "Active experiment",
    kind: "experiment",
    status: "running",
    resource: "gpu:0",
  };
  const work = f.labs.work("terminal-0", "conversation-0", input).work;
  f.terminals.push({ ...f.terminals[0], id: "another-terminal" });
  f.runtimes.set("another-terminal", {
    ...f.runtimes.get("terminal-0")!,
    sessionId: "another-conversation",
  });
  const other = f.labs.prepare(
    {
      title: "Old preparation",
      cwd: f.directory,
      leadKind: "claude",
      effort: "low",
    },
    participant(f, 2),
  );
  f.labs.requestPlan(other.id);
  const records = readFileSync(join(f.directory, "research.json"), "utf8");
  const messages = f.mailbox.list();
  assert.throws(() => f.labs.remove([other.id, lab.id]), /Active experiment/);
  assert.equal(
    readFileSync(join(f.directory, "research.json"), "utf8"),
    records,
  );
  assert.deepEqual(f.mailbox.list(), messages);
  assert.equal(f.labs.get(lab.id).works[0].resource, "gpu:0");
  f.labs.control(lab.id, "pause");
  assert.throws(() => f.labs.remove([lab.id]), /실행 중으로 등록된/);
  f.labs.work("terminal-0", "conversation-0", {
    ...input,
    workId: work.id,
    status: "completed",
    exitCode: 0,
  });
  assert.equal(f.labs.remove([other.id, lab.id]).removed, 2);
  assert.deepEqual(f.labs.list(), []);
  assert.deepEqual(f.mailbox.list(), []);
});

test("a failed record write leaves lab membership and all mailbox records intact", (t) => {
  const f = fixture(t),
    lab = f.create();
  const messages = f.mailbox.list();
  const records = f.labs.list();
  const file = join(f.directory, "research.json");
  renameSync(file, join(f.directory, "research.backup"));
  mkdirSync(file);
  assert.throws(() => f.labs.remove([lab.id]));
  assert.deepEqual(f.labs.list(), records);
  assert.deepEqual(f.mailbox.list(), messages);
  assert.throws(() => prepare(f), /이미 다른 연구실/);
});

test("abandoned work can be removed once its owner terminal is closed; unrelated live participants are preserved", (t) => {
  const f = fixture(t),
    lab = f.create();
  analysis(f, lab);
  submit(f, lab.id, 0, report(lab, false));
  submit(f, lab.id, 1, report(lab, false));
  f.labs.work("terminal-0", "conversation-0", {
    labId: lab.id,
    assignmentId: f.labs.context("terminal-0", "conversation-0", lab.id)
      .assignment!.id,
    title: "Abandoned work",
    kind: "experiment",
    status: "running",
  });
  f.terminals[0].exited = true;
  assert.equal(f.labs.remove([lab.id]).removed, 1);
  assert.equal(f.terminals[1].exited, false);
});

test("completed research and preparing records can be deleted together; repeat deletion is harmless", (t) => {
  const f = fixture(t),
    lab = f.create();
  analysis(f, lab);
  submit(f, lab.id, 0, report(lab, true));
  submit(f, lab.id, 1, report(lab, true));
  submit(f, lab.id, 0, {
    ...report(lab, true),
    bestResult: "Final recommendation",
  });
  submit(f, lab.id, 1, { ...report(lab, true), decision: "approve" });
  assert.equal(f.labs.get(lab.id).status, "completed");
  const other = prepare(f);
  f.labs.requestPlan(other.id);
  assert.equal(f.labs.remove([lab.id, other.id, lab.id]).removed, 2);
  assert.deepEqual(f.labs.remove([lab.id, other.id]), {
    removed: 0,
    messagesRemoved: 0,
  });
  assert.throws(() => f.labs.remove([]));
  assert.throws(() => f.labs.remove(Array(101).fill("invalid")));
  assert.deepEqual(
    new ResearchLabs(f.directory, f.mailbox, f.options).list(),
    [],
  );
  assert.equal(f.terminals.length, 2);
});

test("research waits for actual conversation IDs and persists one correlated assignment per participant", (t) => {
  const f = fixture(t, false);
  const lab = f.create();
  assert.equal(lab.status, "connecting");
  assert.equal(f.mailbox.list().length, 0);
  for (let i = 0; i < 2; i++)
    f.runtimes.set(`terminal-${i}`, {
      kind: i ? "codex" : "claude",
      sessionId: `conversation-${i}`,
      state: "idle",
      delivery: "automatic",
    });
  f.labs.tick();
  f.labs.tick();
  assert.equal(f.labs.get(lab.id).status, "running");
  assert.equal(f.mailbox.list().length, 2);
  const delivered = f.mailbox.list()[0];
  assert.equal(delivered.purpose, "research");
  assert.ok(delivered.research?.assignmentId);
  assert.equal(delivered.recipient.sessionId, "conversation-1");
  assert.ok(
    codexPeerPrompt({
      ...delivered,
      recipientSessionId: delivered.recipient.sessionId,
    }).includes("harbor_lab_context"),
  );
  const reopenedMailbox = new Mailbox(f.directory, {
    terminal: f.options.terminal,
    host: (id) => ({ id, name: "Fixture" }),
  });
  assert.deepEqual(
    reopenedMailbox.find(delivered.id)?.research,
    delivered.research,
  );
});
test("independent analyses are isolated and transport acknowledgement is not a result", (t) => {
  const f = fixture(t);
  const lab = f.create();
  submit(f, lab.id, 0, report(lab, false, "PRIVATE_INITIAL_PROPOSAL"));
  const ctx = f.labs.context("terminal-1", "conversation-1", lab.id);
  assert.equal(ctx.reports.length, 0);
  assert.equal(ctx.bestResult, "");
  assert.equal(
    f.labs.peerScope(
      "terminal-1",
      "conversation-1",
      "terminal-0",
      "conversation-0",
    ),
    lab.id,
  );
  const job = ctx.assignment!;
  const messageId = job.messageIds[0];
  f.mailbox.offer("terminal-1", messageId, "conversation-1");
  assert.equal(f.labs.get(lab.id).phase, "analysis");
  submit(f, lab.id, 1, report(lab, false));
  assert.equal(f.labs.get(lab.id).phase, "discussion");
  const scope = f.labs.peerScope(
    "terminal-1",
    "conversation-1",
    "terminal-0",
    "conversation-0",
  );
  assert.equal(scope, lab.id);
  const peers = new PeerDelivery(f.mailbox);
  for (const [id, runtime] of f.runtimes) peers.setRuntime(id, runtime);
  const question = peers.send(
    "terminal-1",
    "terminal-0",
    "Actual fixture critique",
    "question",
    scope,
  );
  const answer = f.mailbox.replyAgent(
    "terminal-0",
    question.id,
    "Actual fixture reply",
    "conversation-0",
  );
  assert.equal(answer.labId, lab.id);
  assert.ok(
    JSON.stringify(
      f.labs.context("terminal-1", "conversation-1", lab.id).reports,
    ).includes("PRIVATE_INITIAL_PROPOSAL"),
  );
});
test("discussion has no fixed round limit and only genuine criteria and final review complete the lab", (t) => {
  const f = fixture(t);
  const lab = f.create();
  analysis(f, lab);
  for (let round = 0; round < 14; round++) {
    submit(f, lab.id, 0, report(lab, false, `Review A ${round}`));
    submit(f, lab.id, 1, report(lab, false, `Review B ${round}`));
    assert.equal(f.labs.get(lab.id).phase, "work");
    submit(f, lab.id, 0, report(lab, false, `Evidence A ${round}`));
    submit(f, lab.id, 1, report(lab, false, `Evidence B ${round}`));
    assert.equal(f.labs.get(lab.id).status, "running");
  }
  assert.equal(f.labs.get(lab.id).cycle, 14);
  submit(f, lab.id, 0, report(lab, true));
  submit(f, lab.id, 1, report(lab, true));
  assert.equal(f.labs.get(lab.id).phase, "synthesis");
  submit(f, lab.id, 0, {
    ...report(lab, true),
    bestResult: "# Recommendation\n\nEvidence and uncertainty.",
  });
  assert.equal(f.labs.get(lab.id).phase, "verify");
  assert.equal(f.labs.get(lab.id).status, "running");
  submit(f, lab.id, 1, { ...report(lab, true), decision: "approve" });
  assert.equal(f.labs.get(lab.id).status, "completed");
  assert.ok(f.labs.get(lab.id).bestResult.includes("Recommendation"));
});
test("a final reviewer can reject consensus and send the lab back to work", (t) => {
  const f = fixture(t);
  const lab = f.create();
  analysis(f, lab);
  submit(f, lab.id, 0, report(lab, true));
  submit(f, lab.id, 1, report(lab, true));
  submit(f, lab.id, 0, {
    ...report(lab, true),
    bestResult: "Candidate result",
  });
  submit(f, lab.id, 1, {
    ...report(lab, false, "Evidence does not support the claim"),
    decision: "revise",
  });
  assert.equal(f.labs.get(lab.id).phase, "work");
  assert.equal(f.labs.get(lab.id).status, "running");
  assert.equal(f.labs.get(lab.id).bestResult, "Candidate result");
});
test("native conversation boundaries, duplicate submissions and complete criteria are enforced", (t) => {
  const f = fixture(t);
  const lab = f.create();
  const job = f.labs.get(lab.id).assignments[0];
  const input = report(lab, false);
  assert.throws(
    () => f.labs.report("terminal-1", "conversation-1", lab.id, job.id, input),
    /배정/,
  );
  assert.throws(
    () => f.labs.context("terminal-0", "replacement-conversation", lab.id),
    /네이티브/,
  );
  assert.throws(
    () =>
      f.labs.report("terminal-0", "conversation-0", lab.id, job.id, {
        ...input,
        criteria: [input.criteria[0], input.criteria[0]],
      }),
    /모든 완료/,
  );
  assert.throws(
    () =>
      f.labs.report("terminal-0", "conversation-0", lab.id, job.id, {
        ...input,
        ready: true,
      }),
    /nextActions/,
  );
  f.labs.report("terminal-0", "conversation-0", lab.id, job.id, input);
  assert.equal(
    f.labs.report("terminal-0", "conversation-0", lab.id, job.id, input)
      .duplicate,
    true,
  );
  assert.throws(
    () =>
      f.labs.report("terminal-0", "conversation-0", lab.id, job.id, {
        ...input,
        summary: "different",
      }),
    /이미 제출/,
  );
});
test("pause suppresses undelivered assignments, keeps reports and does not invent completion", (t) => {
  const f = fixture(t);
  const lab = f.create();
  f.labs.control(lab.id, "pause");
  assert.equal(f.mailbox.list().length, 0);
  submit(f, lab.id, 0, {
    ...report(lab, false),
    bestResult: "Saved intermediate result",
  });
  submit(f, lab.id, 1, report(lab, false));
  assert.equal(f.labs.get(lab.id).phase, "analysis");
  assert.equal(f.labs.get(lab.id).status, "paused");
  f.labs.control(lab.id, "resume");
  assert.equal(f.labs.get(lab.id).phase, "discussion");
  assert.equal(f.labs.get(lab.id).bestResult, "Saved intermediate result");
});
test("ordinary report questions go to the peer and explicit direction changes still revise scope", (t) => {
  const f = fixture(t);
  const lab = f.create();
  submit(f, lab.id, 0, {
    ...report(lab, false),
    userQuestion: "Which objective matters?",
    bestResult: "Current best proposal",
  });
  assert.equal(f.labs.get(lab.id).status, "running");
  assert.equal(
    f.mailbox.list().filter((m) => m.purpose === "question").length,
    0,
  );
  const previous = f.labs
    .get(lab.id)
    .assignments.find((j) => j.participant === 1)!;
  f.labs.control(lab.id, "resume", "Prioritize latency over memory.");
  assert.equal(f.labs.get(lab.id).revision, 2);
  assert.equal(f.labs.get(lab.id).bestResult, "Current best proposal");
  assert.throws(
    () =>
      f.labs.report(
        "terminal-1",
        "conversation-1",
        lab.id,
        previous.id,
        report(lab, true),
      ),
    /바뀌/,
  );
  assert.equal(
    f.labs.context("terminal-1", "conversation-1", lab.id).directives[0],
    "Prioritize latency over memory.",
  );
});
test("report questions are durable native peer exchanges and never pause ordinary research", (t) => {
  const f = fixture(t),
    lab = f.create();
  submit(f, lab.id, 0, {
    ...report(lab, false),
    peerQuestions: ["Which candidate fits the existing constraints?"],
  });
  assert.equal(
    f.mailbox.list().filter((m) => m.purpose === "question").length,
    0,
  );
  submit(f, lab.id, 1, {
    ...report(lab, false),
    userQuestion: "How should we compare the evidence?",
  });
  assert.equal(f.labs.get(lab.id).status, "running");
  assert.equal(f.labs.get(lab.id).phase, "discussion");
  const questions = f.mailbox.list().filter((m) => m.purpose === "question");
  assert.equal(questions.length, 2);
  for (const q of questions) {
    assert.equal(q.author, "agent");
    assert.equal(q.labId, lab.id);
    assert.equal(q.questionSource?.revision, lab.revision);
    assert.ok(q.sender.sessionId && q.recipient.sessionId);
    assert.equal(q.research, undefined);
    f.mailbox.replyAgent(
      q.recipient.terminalId!,
      q.id,
      "Peer's actual comparison within the authorized scope",
      q.recipient.sessionId,
    );
  }
  f.labs.tick();
  f.labs.tick();
  assert.equal(
    f.mailbox.list().filter((m) => m.purpose === "question").length,
    2,
  );
  const context = f.labs.context("terminal-0", "conversation-0", lab.id);
  assert.ok(
    context.peerQuestions.every(
      (q) => q.status === "answered" && q.reply?.includes("actual comparison"),
    ),
  );
  submit(f, lab.id, 0, report(lab, true));
  submit(f, lab.id, 1, report(lab, true));
  assert.equal(f.labs.get(lab.id).phase, "synthesis");
});

test("pending peer questions prevent claiming a final result before the peer actually replies", (t) => {
  const f = fixture(t),
    lab = f.create();
  analysis(f, lab);
  const q = f.mailbox.sendAgent(
    "terminal-0",
    "terminal-1",
    "Review this uncertainty",
    {
      senderSessionId: "conversation-0",
      recipientSessionId: "conversation-1",
      purpose: "question",
      labId: lab.id,
    },
  );
  f.mailbox.offer("terminal-1", q.id, "conversation-1");
  f.mailbox.consumeMessage("terminal-1", q.id, "conversation-1");
  submit(f, lab.id, 0, report(lab, true));
  submit(f, lab.id, 1, report(lab, true));
  assert.equal(f.labs.get(lab.id).phase, "work");
  assert.equal(f.labs.get(lab.id).status, "running");
});

test("question outbox survives restart, Claude Stop, backpressure and duplicate report questions", (t) => {
  const f = fixture(t),
    lab = f.create();
  f.runtimes.get("terminal-0")!.state = "working";
  submit(f, lab.id, 0, report(lab, false));
  submit(f, lab.id, 1, {
    ...report(lab, false),
    peerQuestions: ["Concrete question to Claude"],
  });
  assert.equal(
    f.mailbox.list().filter((m) => m.purpose === "question").length,
    0,
  );
  const restarted = new ResearchLabs(f.directory, f.mailbox, f.options);
  assert.equal(restarted.get(lab.id).status, "paused");
  restarted.control(lab.id, "resume");
  assert.equal(
    f.mailbox.list().filter((m) => m.purpose === "question").length,
    0,
  );
  f.runtimes.get("terminal-0")!.state = "idle";
  for (let i = 0; i < 8; i++)
    f.mailbox.sendAgent(
      "terminal-1",
      "terminal-0",
      `Old native question ${i}`,
      {
        senderSessionId: "retired-sender",
        recipientSessionId: "retired-recipient",
        purpose: "question",
      },
    );
  const blocked = Array.from({ length: 8 }, (_, i) =>
    f.mailbox.sendAgent(
      "terminal-1",
      "terminal-0",
      `Other pending question ${i}`,
      {
        senderSessionId: "conversation-1",
        recipientSessionId: "conversation-0",
        purpose: "question",
      },
    ),
  );
  restarted.tick();
  assert.equal(
    f.mailbox
      .list()
      .filter((m) => m.labId === lab.id && m.purpose === "question").length,
    0,
  );
  f.mailbox.replyAgent(
    "terminal-0",
    blocked[0].id,
    "Actual fixture answer",
    "conversation-0",
  );
  restarted.tick();
  assert.equal(
    f.mailbox
      .list()
      .filter((m) => m.labId === lab.id && m.purpose === "question").length,
    1,
  );
  const recoveredMailbox = new Mailbox(f.directory, {
    terminal: f.options.terminal,
    host: (id) => ({ id, name: "Fixture" }),
  });
  const recovered = new ResearchLabs(f.directory, recoveredMailbox, f.options);
  recovered.control(lab.id, "resume");
  recovered.tick();
  assert.equal(
    recoveredMailbox
      .list()
      .filter((m) => m.labId === lab.id && m.purpose === "question").length,
    1,
  );
});

test("failed starting candidates are delegated to the peer without a user pause, retain evidence and retry idempotently", (t) => {
  const f = fixture(t),
    lab = f.create();
  analysis(f, lab);
  const job = f.labs.context(
    "terminal-0",
    "conversation-0",
    lab.id,
  ).assignment!;
  const submitted = {
    ...report(lab, false),
    userDecision: {
      kind: "scope-change" as const,
      question:
        "All starting candidates failed. Should we explore another bottleneck or fix the baseline?",
      reason: "The two participants need to choose another research path.",
      peerMessageId: "not-a-user-permission",
    },
  };
  f.labs.report("terminal-0", "conversation-0", lab.id, job.id, submitted);
  const saved = f.labs.get(lab.id);
  assert.equal(saved.status, "running");
  assert.equal(saved.pendingDecision, undefined);
  assert.equal(
    saved.assignments.find((j) => j.id === job.id)!.report?.userDecision,
    undefined,
  );
  assert.equal(
    saved.assignments.find((j) => j.id === job.id)!.report?.researchDecision
      ?.question,
    submitted.userDecision.question,
  );
  assert.deepEqual(
    saved.assignments.find((j) => j.id === job.id)!.report?.criteria,
    submitted.criteria,
  );
  const delegated = f.mailbox.list().find((m) => m.purpose === "question")!;
  assert.ok(delegated);
  assert.equal(delegated.recipient.sessionId, "conversation-1");
  assert.match(delegated.text, /not a user request/);
  assert.match(delegated.text, /Preserve fixed hardware/);
  assert.equal(
    f.labs.report("terminal-0", "conversation-0", lab.id, job.id, submitted)
      .duplicate,
    true,
  );
  assert.equal(
    f.mailbox.list().filter((m) => m.purpose === "question").length,
    1,
  );
  f.mailbox.replyAgent(
    "terminal-1",
    delegated.id,
    "Keep hardware fixed and investigate a new measured bottleneck.",
    "conversation-1",
  );
  submit(f, lab.id, 1, report(lab, false));
  const active = f.labs.get(lab.id);
  assert.equal(active.phase, "work");
  assert.equal(active.revision, lab.revision);
  assert.equal(active.goal, lab.goal);
  const context = f.labs.context("terminal-0", "conversation-0", lab.id);
  assert.equal(context.decisionPolicy.researchChoices, "delegated-to-peers");
  assert.match(context.instructions, /another measured bottleneck/);
  assert.match(context.instructions, /Native command\/security approvals/);
});

test("fixed hardware exceptions require an exact user constraint and real scoped peer consultation", (t) => {
  const f = fixture(t);
  const lab = f.labs.create(
    {
      title: "Fixed hardware",
      goal: "Keep hardware fixed at four cores; compare research mechanisms.",
      kind: "ideas",
      cwd: f.directory,
      criteria: ["Use four cores", "Compare evidence"],
      effort: "low",
    },
    f.terminals.map((_, i) => participant(f, i)),
  );
  analysis(f, lab);
  const q = f.mailbox.sendAgent(
    "terminal-0",
    "terminal-1",
    "Can we preserve the fixed hardware?",
    {
      senderSessionId: "conversation-0",
      recipientSessionId: "conversation-1",
      purpose: "question",
      labId: lab.id,
      labRevision: lab.revision,
    },
  );
  f.mailbox.replyAgent(
    "terminal-1",
    q.id,
    "The proposed exception changes the user's fixed hardware.",
    "conversation-1",
  );
  const decision = {
    kind: "scope-change" as const,
    question: "Allow eight cores?",
    reason: "This changes the fixed hardware condition.",
    peerMessageId: q.id,
    constraintChange: {
      category: "hardware" as const,
      constraint: "Invented fixed hardware condition",
      proposedChange: "Use eight cores",
    },
  };
  assert.throws(
    () =>
      submit(f, lab.id, 0, { ...report(lab, false), userDecision: decision }),
    /그대로 인용/,
  );
  decision.constraintChange.constraint = "Keep hardware fixed at four cores";
  submit(f, lab.id, 0, { ...report(lab, false), userDecision: decision });
  assert.equal(f.labs.get(lab.id).status, "needs-input");
  assert.equal(
    f.labs.get(lab.id).pendingDecision?.constraintChange?.proposedChange,
    "Use eight cores",
  );
  assert.throws(() => f.labs.control(lab.id, "resume"), /질문에 답변/);
});

test("repeated review checkpoints choose further peer work without inventing completion or asking the user for strategy", (t) => {
  const f = fixture(t),
    lab = f.create();
  analysis(f, lab);
  for (let round = 0; round < 4; round++) {
    submit(
      f,
      lab.id,
      0,
      report(lab, false, "Same explicit unresolved evidence"),
    );
    submit(
      f,
      lab.id,
      1,
      report(lab, false, "Same explicit unresolved evidence"),
    );
    assert.equal(f.labs.get(lab.id).phase, "work");
    assert.equal(f.labs.get(lab.id).status, "running");
    assert.equal(f.labs.get(lab.id).pendingDecision, undefined);
    if (round < 3) {
      submit(f, lab.id, 0, report(lab, false, "No executed work claimed"));
      submit(f, lab.id, 1, report(lab, false, "No executed work claimed"));
    }
  }
  assert.ok(
    f.labs.get(lab.id).events.some((e) => e.text.includes("새로운 접근")),
  );
  assert.equal(f.labs.get(lab.id).works.length, 0);
});

test("legacy generic scope pauses recover into delegated peer decisions, preserving both reports and requiring native reconnection", (t) => {
  const f = fixture(t),
    lab = f.create();
  analysis(f, lab);
  submit(f, lab.id, 0, report(lab, false));
  submit(f, lab.id, 1, report(lab, false));
  const file = join(f.directory, "research.json"),
    data = JSON.parse(readFileSync(file, "utf8")),
    saved = data.labs[0];
  const job = saved.assignments.find(
    (j: any) => j.phase === "discussion" && j.participant === 0,
  );
  const legacy = {
    kind: "scope-change",
    question: "Choose another research direction?",
    reason: "Initial candidates failed",
    peerMessageId: "legacy-peer-question",
  };
  job.report.userDecision = legacy;
  saved.pendingDecision = { ...legacy, assignmentId: job.id, participant: 0 };
  saved.status = "needs-input";
  saved.phase = "discussion";
  saved.cycle = 0;
  saved.attention = legacy.question;
  writeFileSync(file, JSON.stringify(data));
  const restored = new ResearchLabs(f.directory, f.mailbox, f.options);
  const recovered = restored.get(lab.id);
  assert.equal(recovered.status, "paused");
  assert.equal(recovered.pendingDecision, undefined);
  assert.equal(recovered.revision, lab.revision);
  assert.equal(
    recovered.assignments.filter((j) => j.phase === "discussion" && j.report)
      .length,
    2,
  );
  assert.equal(
    recovered.assignments.find((j) => j.id === job.id)!.report?.researchDecision
      ?.question,
    legacy.question,
  );
  const resumed = restored.control(lab.id, "resume");
  assert.equal(resumed.status, "running");
  assert.equal(resumed.phase, "work");
  assert.ok(
    f.mailbox
      .list()
      .some(
        (m) => m.purpose === "question" && m.text.includes(legacy.question),
      ),
  );
});

test("only actual current peer consultation permits user-only escalation, and answering preserves progress", (t) => {
  const f = fixture(t),
    lab = f.create();
  const decision = {
    kind: "external-approval" as const,
    question: "May we purchase the private dataset?",
    reason:
      "The free evidence is insufficient and neither AI can authorize payment.",
    peerMessageId: "made-up",
  };
  assert.throws(
    () =>
      submit(f, lab.id, 0, { ...report(lab, false), userDecision: decision }),
    /동료 AI/,
  );
  assert.equal(f.labs.get(lab.id).assignments[0].report, undefined);
  analysis(f, lab);
  const q = f.mailbox.sendAgent(
    "terminal-0",
    "terminal-1",
    "Can we complete using the free evidence?",
    {
      senderSessionId: "conversation-0",
      recipientSessionId: "conversation-1",
      purpose: "question",
      labId: lab.id,
      labRevision: lab.revision,
    },
  );
  f.mailbox.offer("terminal-1", q.id, "conversation-1");
  assert.throws(
    () =>
      submit(f, lab.id, 0, {
        ...report(lab, false),
        userDecision: { ...decision, peerMessageId: q.id },
      }),
    /실제 질문/,
  );
  f.mailbox.replyAgent(
    "terminal-1",
    q.id,
    "The required data is unavailable without a purchase; permission must come from the user.",
    "conversation-1",
  );
  assert.throws(
    () =>
      submit(f, lab.id, 1, {
        ...report(lab, false),
        userDecision: { ...decision, peerMessageId: q.id },
      }),
    /실제 질문/,
  );
  submit(f, lab.id, 0, {
    ...report(lab, false),
    userDecision: { ...decision, peerMessageId: q.id },
  });
  const waiting = f.labs.get(lab.id);
  assert.equal(waiting.status, "needs-input");
  assert.equal(waiting.phase, "discussion");
  assert.equal(waiting.pendingDecision?.kind, "external-approval");
  submit(f, lab.id, 1, report(lab, false));
  assert.throws(() => f.labs.control(lab.id, "resume"), /질문에 답변/);
  assert.throws(
    () => f.labs.control(lab.id, "answer", "No purchase", "stale-assignment"),
    /변경/,
  );
  assert.throws(
    () =>
      f.labs.control(
        lab.id,
        "answer",
        "",
        waiting.pendingDecision!.assignmentId,
      ),
    /답변/,
  );
  const resumed = f.labs.control(
    lab.id,
    "answer",
    "Use the free subset and document the limitation.".padEnd(4000, "."),
    waiting.pendingDecision!.assignmentId,
  );
  assert.equal(resumed.revision, waiting.revision);
  assert.equal(resumed.phase, "work");
  assert.equal(resumed.pendingDecision, undefined);
  assert.equal(
    resumed.assignments.filter((j) => j.phase === "analysis").length,
    2,
  );
  const ctx = f.labs.context("terminal-0", "conversation-0", lab.id);
  assert.match(ctx.userAnswers[0].answer, /free subset/);
  assert.equal(ctx.peerQuestions[0].status, "answered");
  const restored = new ResearchLabs(f.directory, f.mailbox, f.options);
  assert.equal(restored.get(lab.id).revision, waiting.revision);
  assert.equal(
    restored
      .get(lab.id)
      .assignments.find((j) => j.id === waiting.pendingDecision!.assignmentId)!
      .decisionAnswer!.text.length,
    4000,
  );
});

test("UI replies, unrelated labs and obsolete revisions cannot establish a user-only decision", (t) => {
  const f = fixture(t),
    lab = f.create();
  analysis(f, lab);
  for (const scope of [
    { labId: "unrelated-lab", labRevision: lab.revision },
    { labId: lab.id, labRevision: lab.revision - 1 },
    { labId: lab.id },
  ]) {
    const q = f.mailbox.sendAgent(
      "terminal-0",
      "terminal-1",
      "Is new permission indispensable?",
      {
        senderSessionId: "conversation-0",
        recipientSessionId: "conversation-1",
        purpose: "question",
        ...scope,
      },
    );
    f.mailbox.replyAgent(
      "terminal-1",
      q.id,
      "This requires permission",
      "conversation-1",
    );
    assert.throws(
      () =>
        submit(f, lab.id, 0, {
          ...report(lab, false),
          userDecision: {
            kind: "external-approval",
            question: "Allow new action?",
            reason: "Cannot grant it ourselves",
            peerMessageId: q.id,
          },
        }),
      /동료 AI/,
    );
  }
  const user = f.mailbox.send({
    fromTerminalId: "terminal-0",
    toTerminalId: "terminal-1",
    text: "A user-composed message",
  });
  f.mailbox.replyAgent(
    "terminal-1",
    user.id,
    "A genuine reply to a user message",
    "conversation-1",
  );
  assert.throws(
    () =>
      submit(f, lab.id, 0, {
        ...report(lab, false),
        userDecision: {
          kind: "missing-information",
          question: "What is the dataset password?",
          reason: "Neither AI knows it",
          peerMessageId: user.id,
        },
      }),
    /동료 AI/,
  );
  assert.equal(f.labs.get(lab.id).pendingDecision, undefined);
  assert.equal(f.labs.get(lab.id).status, "running");
});

test("legacy question pauses migrate without discarding existing analysis or resuming automatically", (t) => {
  const f = fixture(t),
    lab = f.create();
  submit(f, lab.id, 0, {
    ...report(lab, false),
    userQuestion: "Candidate A or B?",
  });
  f.labs.control(lab.id, "pause");
  submit(f, lab.id, 1, report(lab, false));
  const file = join(f.directory, "research.json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  data.labs[0].status = "needs-input";
  data.labs[0].attention = "Candidate A or B?";
  writeFileSync(file, JSON.stringify(data));
  const restored = new ResearchLabs(f.directory, f.mailbox, f.options);
  assert.equal(restored.get(lab.id).status, "paused");
  assert.equal(
    restored.get(lab.id).assignments.filter((j) => j.report).length,
    2,
  );
  const resumed = restored.control(lab.id, "resume");
  assert.equal(resumed.phase, "discussion");
  assert.equal(resumed.revision, lab.revision);
  assert.ok(
    f.mailbox
      .list()
      .some((m) => m.purpose === "question" && m.text === "Candidate A or B?"),
  );
});

test("authenticated MCP exposes and relays report questions between both native providers", async (t) => {
  const f = fixture(t),
    lab = f.create();
  const requestStore = new Requests(f.directory, {
    terminal: f.options.terminal,
    host: (id) => ({ id, name: "Fixture" }),
  });
  const bridge = new AgentBridge(f.mailbox, {
    terminals: () => f.terminals,
    host: (id) => ({ id, name: "Fixture" }),
    research: () => f.labs,
    requests: requestStore,
  });
  const credentials = f.terminals.map((terminal) => bridge.issue(terminal.id));
  for (const [id, runtime] of f.runtimes) bridge.peers.setRuntime(id, runtime);
  const app = express();
  app.all("/bridge/mcp", bridge.handle);
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as any).port}/bridge/mcp`;
  const rpc = async (i: number, method: string, params: unknown) =>
    (await (
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credentials[i].token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
    ).json()) as any;
  const call = (i: number, name: string, args: unknown) =>
    rpc(i, "tools/call", { name, arguments: args });
  const tool = (await rpc(0, "tools/list", {})).result.tools.find(
    (t: any) => t.name === "harbor_lab_report",
  );
  assert.ok(tool.inputSchema.properties.peerQuestions);
  assert.ok(tool.inputSchema.properties.userDecision);
  const ask = await call(0, "harbor_ask", {
    to: "terminal-1",
    question: "Clarify the assigned constraints",
    waitMs: 0,
  });
  assert.ok(!ask.result.isError);
  const manual = f.mailbox.list().find((m) => m.purpose === "question")!;
  assert.equal(manual.labRevision, lab.revision);
  const redirected = await call(0, "harbor_request", {
    title: "Research choice",
    question: "Which research direction should we try?",
    waitMs: 50000,
  });
  assert.ok(!redirected.result.isError);
  const redirectResult = JSON.parse(redirected.result.content[0].text);
  assert.equal(redirectResult.redirectedToPeer, true);
  assert.equal(requestStore.list().length, 0);
  assert.equal(redirectResult.to, "Research codex");
  assert.equal(
    f.mailbox.find(redirectResult.questionId)?.recipient.sessionId,
    "conversation-1",
  );
  const duplicateRedirect = await call(0, "harbor_request", {
    title: "Research choice",
    question: "Which research direction should we try?",
    waitMs: 0,
  });
  assert.equal(
    JSON.parse(duplicateRedirect.result.content[0].text).questionId,
    redirectResult.questionId,
  );
  assert.equal(requestStore.list().length, 0);
  const pendingRedirect = await call(0, "harbor_ask_result", {
    requestId: redirectResult.questionId,
    waitMs: 0,
  });
  assert.ok(!pendingRedirect.result.isError);
  assert.equal(
    JSON.parse(pendingRedirect.result.content[0].text).request.status,
    "pending",
  );
  for (const i of [0, 1]) {
    const job = f.labs.context(
      `terminal-${i}`,
      `conversation-${i}`,
      lab.id,
    ).assignment!;
    const saved = await call(i, "harbor_lab_report", {
      labId: lab.id,
      assignmentId: job.id,
      ...report(lab, false),
      peerQuestions: [`Provider ${i}'s concrete question`],
    });
    assert.ok(!saved.result.isError);
  }
  const questions = f.mailbox.list().filter((m) => m.purpose === "question");
  assert.equal(questions.length, 4);
  for (const q of questions) {
    const recipient = Number(q.recipient.terminalId!.slice(-1));
    const reply = await call(recipient, "harbor_reply", {
      messageId: q.id,
      text: "Native authenticated peer answer",
    });
    assert.ok(!reply.result.isError, JSON.stringify(reply));
  }
  assert.equal(f.labs.get(lab.id).status, "running");
  assert.ok(
    f.labs
      .context("terminal-0", "conversation-0", lab.id)
      .peerQuestions.every(
        (q) => q.reply === "Native authenticated peer answer",
      ),
  );
});

test("work reserves shared resources, records actual metadata, and running work prevents transition", (t) => {
  const f = fixture(t);
  const lab = f.create();
  analysis(f, lab);
  submit(f, lab.id, 0, report(lab, false));
  submit(f, lab.id, 1, report(lab, false));
  const ctx = f.labs.context("terminal-0", "conversation-0", lab.id);
  const input = {
    labId: lab.id,
    assignmentId: ctx.assignment!.id,
    title: "Compare synthetic cases",
    kind: "experiment",
    status: "running",
    resource: "gpu:0",
    command: "python synthetic.py",
  };
  const work = f.labs.work("terminal-0", "conversation-0", input).work;
  assert.throws(() => submit(f, lab.id, 0, report(lab, true)), /実行|실행 중/);
  const other = f.labs.context("terminal-1", "conversation-1", lab.id);
  assert.throws(
    () =>
      f.labs.work("terminal-1", "conversation-1", {
        ...input,
        assignmentId: other.assignment!.id,
      }),
    /다른 실험/,
  );
  assert.throws(
    () =>
      f.labs.work("terminal-1", "conversation-1", {
        ...input,
        assignmentId: other.assignment!.id,
        workId: work.id,
      }),
    /본인/,
  );
  const done = f.labs.work("terminal-0", "conversation-0", {
    ...input,
    workId: work.id,
    status: "completed",
    exitCode: 0,
    metrics: "latency: 1ms",
    result: "fixture evidence",
    artifacts: ["result.csv"],
  }).work;
  assert.equal(done.evidence, "agent-reported");
  assert.equal(done.exitCode, 0);
  assert.equal(done.metrics, "latency: 1ms");
  assert.ok(
    f.labs.work("terminal-1", "conversation-1", {
      ...input,
      assignmentId: other.assignment!.id,
    }).work,
  );
});
test("restart pauses the lab and restoration retains assignment identity and evidence", (t) => {
  const f = fixture(t);
  const lab = f.create();
  submit(f, lab.id, 0, {
    ...report(lab, false),
    bestResult: "Persistent recommendation",
  });
  const before = f.labs.get(lab.id);
  const restored = new ResearchLabs(f.directory, f.mailbox, f.options);
  assert.equal(restored.get(lab.id).status, "paused");
  assert.equal(restored.get(lab.id).bestResult, "Persistent recommendation");
  assert.deepEqual(restored.get(lab.id).assignments, before.assignments);
  restored.control(lab.id, "resume");
  restored.tick();
  assert.equal(
    f.mailbox.list().filter((m) => m.research?.labId === lab.id).length,
    2,
  );
});
test("conversation replacement pauses rather than sending into an unrelated new chat", (t) => {
  const f = fixture(t);
  const lab = f.create();
  f.runtimes.set("terminal-0", {
    ...f.runtimes.get("terminal-0")!,
    sessionId: "other-chat",
  });
  f.labs.tick();
  assert.equal(f.labs.get(lab.id).status, "paused");
  assert.throws(() => f.labs.control(lab.id, "resume"), /원래 대화/);
  assert.throws(
    () => f.labs.rebind(lab.id, ["terminal-0", "terminal-1"]),
    /기존 대화/,
  );
});
test("mixed local and SSH participants exchange assignments and persist server identity", (t) => {
  const f = fixture(t);
  f.terminals[1].hostId = "synthetic-ssh";
  f.terminals[1].cwd = "/srv/research/codex";
  const lab = f.create();
  assert.deepEqual(
    lab.participants.map((p) => p.hostId),
    ["local", "synthetic-ssh"],
  );
  assert.equal(f.mailbox.list().length, 2);
  analysis(f, lab);
  assert.equal(f.labs.get(lab.id).phase, "discussion");
  const restored = new ResearchLabs(f.directory, f.mailbox, f.options);
  assert.equal(restored.get(lab.id).participants[1].hostId, "synthetic-ssh");
  f.terminals[1].hostId = "other-server";
  assert.throws(
    () => restored.rebind(lab.id, ["terminal-0", "terminal-1"]),
    /서버/,
  );
});

test("peer artifact reads route to the work owner's SSH server, with native membership checks", async (t) => {
  const f = fixture(t);
  f.terminals[0].hostId = "ssh-a";
  f.terminals[0].cwd = "/srv/claude";
  f.terminals[1].hostId = "ssh-b";
  f.terminals[1].cwd = "/srv/codex";
  const reads: unknown[][] = [];
  const labs = new ResearchLabs(f.directory, f.mailbox, {
    ...f.options,
    artifact: async (...args) => {
      reads.push(args);
      return {
        path: "/srv/claude/result.md",
        bytes: Buffer.from("Verified fixture result"),
      };
    },
  });
  const lab = labs.create(
    {
      title: "Remote fixture",
      goal: "Review server artifacts",
      kind: "ideas",
      cwd: "/srv/claude",
      criteria: ["Read evidence"],
      effort: "low",
      hostId: "ssh-a",
    },
    f.terminals.map((terminal) => ({
      terminalId: terminal.id,
      name: terminal.title,
      kind: terminal.agentKind!,
      cwd: terminal.cwd,
      owned: false,
    })),
  );
  labs.tick();
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 2; i++) {
      const job = labs.context(
        `terminal-${i}`,
        `conversation-${i}`,
        lab.id,
      ).assignment!;
      labs.report(
        `terminal-${i}`,
        `conversation-${i}`,
        lab.id,
        job.id,
        report(lab, false),
      );
    }
  }
  const assignment = labs.context(
    "terminal-0",
    "conversation-0",
    lab.id,
  ).assignment!;
  const work = labs.work("terminal-0", "conversation-0", {
    labId: lab.id,
    assignmentId: assignment.id,
    title: "Result",
    kind: "investigation",
    status: "completed",
    artifacts: ["result.md"],
  }).work;
  const input = { labId: lab.id, workId: work.id, path: "result.md" };
  const result = await labs.artifact("terminal-1", "conversation-1", input);
  assert.equal(result.text, "Verified fixture result");
  assert.deepEqual(reads, [
    ["ssh-a", "/srv/claude", "/srv/claude", "result.md"],
  ]);
  await assert.rejects(
    labs.artifact("terminal-1", "wrong-chat", input),
    /네이티브/,
  );
  assert.equal(reads.length, 1);
  for (let i = 0; i < 2; i++) {
    const job = labs.context(
      `terminal-${i}`,
      `conversation-${i}`,
      lab.id,
    ).assignment!;
    assert.doesNotThrow(
      () =>
        labs.work(`terminal-${i}`, `conversation-${i}`, {
          labId: lab.id,
          assignmentId: job.id,
          title: `Own server GPU ${i}`,
          kind: "experiment",
          status: "running",
          resource: "gpu:0",
        }),
      "Identical GPU names on different servers do not conflict",
    );
  }
});
test("lab launch effort overrides are session-local while ordinary terminal launch stays unchanged", (t) => {
  const f = fixture(t);
  const host = new Store(f.directory).data.hosts[0];
  const regular = powershellInitialization(host, "codex");
  assert.ok(!regular.includes('model_reasoning_effort="low"'));
  const low = powershellInitialization(
    host,
    "codex",
    undefined,
    undefined,
    false,
    undefined,
    { cwd: f.directory, effort: "low" },
  );
  assert.ok(low.includes('model_reasoning_effort="low"'));
  assert.ok(low.includes(" -C "));
  const claude = powershellInitialization(
    host,
    "claude",
    undefined,
    undefined,
    false,
    undefined,
    { cwd: f.directory, effort: "low" },
  );
  assert.ok(claude.includes("claude --harbor-peers '--effort' 'low'"));
  assert.ok(claude.includes("Set-Location -LiteralPath"));
});

test("peer artifacts are actual bounded file reads restricted to registered work and conversation", async (t) => {
  const f = fixture(t);
  const folder = join(f.directory, "work");
  mkdirSync(folder);
  f.terminals[0].cwd = folder;
  writeFileSync(
    join(folder, "candidate.mjs"),
    "export const add = (a, b) => a + b;\n",
  );
  writeFileSync(
    join(f.directory, "outside.txt"),
    "OUTSIDE_ASSIGNED_WORK_FOLDER",
  );
  const lab = f.create();
  analysis(f, lab);
  submit(f, lab.id, 0, report(lab, false));
  submit(f, lab.id, 1, report(lab, false));
  const assignment = f.labs.context(
    "terminal-0",
    "conversation-0",
    lab.id,
  ).assignment!;
  const work = f.labs.work("terminal-0", "conversation-0", {
    labId: lab.id,
    assignmentId: assignment.id,
    title: "Actual candidate",
    kind: "code",
    status: "completed",
    artifacts: ["candidate.mjs", "../outside.txt"],
  }).work;
  const input = { labId: lab.id, workId: work.id, path: "candidate.mjs" };
  const read = await f.labs.artifact("terminal-1", "conversation-1", input);
  assert.match(read.text, /a \+ b/);
  assert.match(read.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(
    f.labs.artifact("terminal-1", "other-conversation", input),
    /네이티브/,
  );
  await assert.rejects(
    f.labs.artifact("terminal-1", "conversation-1", {
      ...input,
      path: "unregistered.txt",
    }),
    /등록된/,
  );
  await assert.rejects(
    f.labs.artifact("terminal-1", "conversation-1", {
      ...input,
      path: "../outside.txt",
    }),
    /작업 폴더/,
  );
});

test("Claude receives a new lab assignment only after its native turn becomes idle", (t) => {
  const f = fixture(t);
  const lab = f.create();
  f.runtimes.set("terminal-0", {
    ...f.runtimes.get("terminal-0")!,
    state: "working",
  });
  analysis(f, lab);
  const job = f.labs.context(
    "terminal-0",
    "conversation-0",
    lab.id,
  ).assignment!;
  assert.equal(job.messageIds.length, 0);
  f.runtimes.set("terminal-0", {
    ...f.runtimes.get("terminal-0")!,
    state: "idle",
  });
  f.labs.tick();
  assert.equal(
    f.labs.context("terminal-0", "conversation-0", lab.id).assignment!
      .messageIds.length,
    1,
  );
});

test("resuming a paused assignment ignores removed outbox messages and consumes only the new copy", (t) => {
  const f = fixture(t);
  const lab = f.create();
  const original = f.labs.get(lab.id).assignments[0].messageIds[0];
  f.labs.control(lab.id, "pause");
  assert.equal(f.mailbox.find(original), undefined);
  f.labs.control(lab.id, "resume");
  const context = f.labs.context("terminal-0", "conversation-0", lab.id);
  assert.equal(context.assignment!.messageIds.length, 2);
  const delivered = context.assignment!.messageIds[1];
  assert.ok(f.mailbox.find(delivered)?.consumedAt);
  submit(f, lab.id, 0, report(lab, false));
});

test("reconnecting the same native conversation to a new terminal retains history without reading old terminal envelopes", (t) => {
  const f = fixture(t);
  const lab = f.create();
  const job = f.labs.get(lab.id).assignments[0];
  f.mailbox.offer("terminal-0", job.messageIds[0], "conversation-0");
  f.labs.control(lab.id, "pause");
  f.terminals.push({ ...f.terminals[0], id: "restored-terminal" });
  f.terminals[0].exited = true;
  f.runtimes.set("restored-terminal", { ...f.runtimes.get("terminal-0")! });
  f.labs.rebind(lab.id, ["restored-terminal", "terminal-1"]);
  f.labs.control(lab.id, "resume");
  const ctx = f.labs.context("restored-terminal", "conversation-0", lab.id);
  assert.equal(ctx.assignment?.id, job.id);
  assert.equal(f.mailbox.find(job.messageIds[0])?.consumedAt, undefined);
  f.labs.report(
    "restored-terminal",
    "conversation-0",
    lab.id,
    job.id,
    report(lab, false),
  );
  assert.ok(f.labs.get(lab.id).assignments[0].report);
});
