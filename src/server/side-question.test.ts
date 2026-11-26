import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { readAcpAnswer } from "./side-antigravity.js";
import { test } from "node:test";
import {
  createSideQuestions,
  sideAnswer,
  sidePrompt,
} from "./side-question.js";
import { sideTranscript, validateSidePaste } from "../shared/side-question.js";
import type { HostConfig, TerminalInfo } from "../shared/types.js";
import type { HistoryDetail } from "../shared/history.js";

test("the transcript copies only the two speakers verbatim", () => {
  const events = [
    { type: "item.completed", item: { type: "reasoning", text: "private" } },
    {
      type: "item.completed",
      item: { type: "command_execution", text: "tool" },
    },
    {
      type: "item.completed",
      item: { type: "agent_message", phase: "commentary", text: "progress" },
    },
    {
      type: "item.completed",
      item: { type: "agent_message", text: "  **answer**\nnext " },
    },
    { type: "turn.completed" },
  ];
  const text = sideAnswer(
    "codex",
    events.map((x) => JSON.stringify(x)).join("\n"),
  );
  assert.equal(
    sideTranscript(
      [
        { role: "user", text: " question " },
        { role: "assistant", text },
      ],
      "codex",
    ),
    "나\n question \n\nCodex\n  **answer**\nnext ",
  );
  assert.throws(() =>
    sideAnswer(
      "codex",
      events
        .slice(0, -1)
        .map((x) => JSON.stringify(x))
        .join("\n"),
    ),
  );
  assert.equal(
    sideAnswer(
      "claude",
      '{"type":"result","subtype":"success","result":"final"}',
    ),
    "final",
  );
  assert.throws(() => validateSidePaste("text\x1b[201~\r"));
});
test("Antigravity side chat uses a fresh ACP session and returns only visible answer chunks", async () => {
  const fromAgent = new PassThrough(),
    toAgent = new PassThrough();
  const reader = createInterface({ input: toAgent });
  const send = (value: unknown) =>
    fromAgent.write(JSON.stringify(value) + "\n");
  reader.on("line", (line) => {
    const m = JSON.parse(line);
    if (m.method === "initialize")
      send({ id: m.id, result: { protocolVersion: 1 } });
    if (m.method === "session/new")
      send({
        id: m.id,
        result: { sessionId: "side", models: { currentModelId: "fixture" } },
      });
    if (m.method === "session/prompt") {
      assert.equal(m.params.sessionId, "side");
      for (const [id, kind, text] of [
        ["side", "agent_thought_chunk", "not visible"],
        ["parent", "agent_message_chunk", "wrong thread"],
        ["side", "agent_message_chunk", "visible reply"],
      ])
        send({
          method: "session/update",
          params: {
            sessionId: id,
            update: { sessionUpdate: kind, content: { type: "text", text } },
          },
        });
      send({ id: m.id, result: { stopReason: "end_turn" } });
    }
  });
  try {
    assert.equal(
      await readAcpAnswer(
        fromAgent,
        toAgent,
        "/fixture",
        "fixture",
        "hello",
        AbortSignal.timeout(3000),
      ),
      "visible reply",
    );
  } finally {
    reader.close();
    toAgent.end();
    fromAgent.end();
  }
});
test("a scoped side request uses recent parent context, follows prior chat and rejects a switched session", async () => {
  const binding = {
    hostId: "test",
    provider: "codex" as const,
    sessionId: "parent",
    cwd: "/fixture",
  };
  const t = {
    id: "pty",
    hostId: "test",
    agentSessionId: "parent",
    agentKind: "codex",
    cwd: "/fixture",
    connectionState: "connected",
  } as TerminalInfo;
  let release!: () => void;
  const hold = new Promise<void>((r) => {
    release = r;
  });
  const ask = createSideQuestions(
    {
      terminal: () => t,
      host: () => ({ id: "test" }) as HostConfig,
      password: async () => undefined,
      history: async () =>
        ({
          thread: { id: "parent", hostId: "test" },
          items: [{ kind: "assistant", text: "parent result" }],
        }) as HistoryDetail,
      settings: async () => ({ model: "fixture", effort: "high" }),
      screen: async () => "",
    },
    async (_h, _p, b, settings, prompt) => {
      assert.equal(b.provider, "codex");
      assert.equal(settings.effort, "high");
      assert.match(prompt, /parent result/);
      assert.match(prompt, /earlier reply/);
      await hold;
      return { text: "new answer", model: "fixture" };
    },
  );
  const input = {
    binding,
    messages: [
      { role: "user" as const, text: "first" },
      { role: "assistant" as const, text: "earlier reply" },
      { role: "user" as const, text: "follow up" },
    ],
  };
  const run = () => ask("pty", input, new AbortController().signal, () => {});
  const first = run();
  await assert.rejects(run(), /진행 중/);
  await new Promise((r) => setImmediate(r));
  t.agentSessionId = "replacement";
  release();
  await assert.rejects(first, /변경/);
  t.agentSessionId = "parent";
  assert.equal((await run()).text, "new answer");
  assert.match(
    sidePrompt(input.messages, undefined, "screen reference"),
    /screen reference/,
  );
});

test("side runner sends the snapshot over stdin and reads a final CLI reply", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "harbor-side-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const exe = join(dir, "provider.cjs");
  await writeFile(
    exe,
    [
      "let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>prompt+=s);",
      "process.stdin.on('end',()=>{if(!process.argv.includes('--ephemeral')||!process.argv.includes('read-only')||!prompt.includes('fixture context')||!prompt.includes('question'))process.exit(2);",
      "console.log(JSON.stringify({type:'item.completed',item:{type:'reasoning',text:'hidden'}}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'verbatim result'}}));console.log(JSON.stringify({type:'turn.completed'}));});",
    ].join("\n"),
  );
  const binding = {
    hostId: "test",
    provider: "codex" as const,
    sessionId: "",
    cwd: dir,
  };
  const ask = createSideQuestions({
    terminal: () =>
      ({
        id: "t",
        hostId: "test",
        agentKind: "codex",
        cwd: dir,
        connectionState: "connected",
      }) as TerminalInfo,
    host: () => ({ id: "test", kind: "local", codexPath: exe }) as HostConfig,
    password: async () => undefined,
    history: async () => {
      throw Error("unbound");
    },
    settings: async () => ({}),
    screen: async () => "fixture context",
  });
  const result = await ask(
    "t",
    { binding, messages: [{ role: "user", text: "question" }] },
    AbortSignal.timeout(5000),
    () => {},
  );
  assert.deepEqual(result, {
    text: "verbatim result",
    model: undefined,
    effort: undefined,
    context: true,
  });
});
