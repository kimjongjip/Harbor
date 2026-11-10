import assert from "node:assert/strict";
import test from "node:test";
import { TerminalAgentRoster } from "./terminal-agent-roster.js";
import { terminalAgents } from "../shared/terminal-agents.js";
import {
  claudeUsage,
  TerminalUsageStore,
  codexUsage,
} from "./terminal-usage.js";
import { CodexUsageLedger } from "./codex-usage-history.js";

test("Codex native events track real children without treating a completed spawn as a finished agent", () => {
  const roster = new TerminalAgentRoster();
  assert.equal(
    roster.observe({ type: "agentMessage", text: "irrelevant" }),
    false,
  );
  roster.observe(
    {
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      status: "completed",
      receiverThreadIds: ["child"],
      prompt: "Review keyboard input",
      agentsStates: { child: { status: "running", message: "PRIVATE ANSWER" } },
    },
    1,
  );
  assert.deepEqual(roster.snapshot("native")!.agents, [
    {
      id: "child",
      name: "에이전트",
      state: "working",
      task: "Review keyboard input",
    },
  ]);
  roster.observe(
    {
      type: "subAgentActivity",
      agentThreadId: "child",
      agentPath: "/root/reviewer",
      kind: "started",
      model: "synthetic-model",
    },
    2,
  );
  roster.observe(
    {
      type: "subAgentActivity",
      agentThreadId: "child",
      agentPath: "/root/reviewer",
      kind: "completed",
    },
    3,
  );
  const result = roster.snapshot("native")!;
  assert.deepEqual(result.agents, [
    {
      id: "child",
      name: "reviewer",
      state: "completed",
      model: "synthetic-model",
      task: "Review keyboard input",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  assert.equal(result.updatedAt, 3);
  assert.equal(
    roster.observe(
      {
        type: "subAgentActivity",
        agentThreadId: "child",
        agentPath: "/root/reviewer",
        kind: "completed",
      },
      4,
    ),
    false,
  );
});

test("child usage is scoped to known agents and cumulative totals never mix with parent context", () => {
  const roster = new TerminalAgentRoster();
  const params = {
    tokenUsage: {
      total: {
        totalTokens: 12000,
        inputTokens: 10000,
        outputTokens: 2000,
        cachedInputTokens: 8000,
      },
      last: { totalTokens: 3000 },
    },
  };
  assert.equal(
    roster.observeChild("unrelated", "thread/tokenUsage/updated", params),
    false,
  );
  roster.observe({
    type: "collabToolCall",
    tool: "spawnAgent",
    status: "completed",
    newThreadId: "child",
    prompt: "x".repeat(400),
  });
  assert.equal(roster.snapshot("native")!.agents[0].task?.length, 160);
  roster.observeChild("child", "thread/tokenUsage/updated", params);
  assert.deepEqual(roster.snapshot("native")!.agents[0].tokens, {
    total: 12000,
    input: 10000,
    output: 2000,
    cached: 8000,
    scope: "session",
  });
  assert.equal(
    roster.observeChild("child", "thread/tokenUsage/updated", params),
    false,
    "duplicate cumulative events are not added",
  );
  roster.observeChild("child", "item/started", {
    item: {
      id: "tool-a",
      type: "commandExecution",
      command: "PRIVATE COMMAND",
    },
  });
  assert.equal(roster.snapshot("native")!.agents[0].activity, "명령 실행");
  assert.doesNotMatch(JSON.stringify(roster.snapshot("native")), /PRIVATE/);
  roster.observeChild("child", "item/completed", { item: { id: "tool-a" } });
  assert.equal(roster.snapshot("native")!.agents[0].activity, undefined);
  roster.observeChild("child", "turn/completed", {
    turn: { status: "completed" },
  });
  assert.equal(roster.snapshot("native")!.agents[0].state, "completed");
});

test("roster bounds metadata, strips controls, and keeps active children first", () => {
  const value = terminalAgents([
    { id: "bad id", name: "ignored" },
    ...Array.from({ length: 80 }, (_, i) => ({
      id: `agent-${i}`,
      name: "a\x1b".repeat(100),
      status: i === 70 ? "running" : "completed",
      prompt: "PRIVATE",
    })),
  ])!;
  assert.equal(value.length, 32);
  assert.equal(value[0].id, "agent-70");
  assert.ok(value.every((a) => a.name.length <= 80));
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE|\\u001b/);
  const native = claudeUsage({
    session_id: "session",
    harbor_agents: [{ id: "c1", type: "review", status: "waiting" }],
  });
  assert.equal(
    native?.crew?.agents[0].state,
    "waiting",
    "agent metadata can arrive before the first usage measurement",
  );
  assert.equal(native?.usedTokens, null);
});

test("crew updates bypass usage-read cache and remain isolated across sessions and compaction", async () => {
  const store = new TerminalUsageStore();
  const historical = {
    ...codexUsage("first", {
      last: { totalTokens: 2000 },
      modelContextWindow: 10000,
    })!,
    costUsd: 2,
    source: "history" as const,
  };
  const fallback = async () => historical;
  await store.read("terminal", "codex", "first", fallback);
  const crew = {
    agents: [{ id: "a", name: "review", state: "working" as const }],
    updatedAt: 1,
    source: "native" as const,
  };
  store.putCrew("terminal", "codex", "first", crew);
  store.put(
    "terminal",
    codexUsage("first", {
      last: { totalTokens: 3000 },
      modelContextWindow: 10000,
    })!,
  );
  const value = await store.read("terminal", "codex", "first", fallback);
  assert.equal(value?.crew, crew);
  assert.equal(value?.usedTokens, 3000);
  assert.equal(value?.costUsd, 2);
  assert.equal(
    await store.read("terminal", "codex", "second", async () => null),
    null,
  );
  store.compact("terminal");
  assert.equal(
    (await store.read("terminal", "codex", "first", fallback))?.crew,
    crew,
  );
  store.clear("terminal");
  store.putCrew("terminal", "codex", "first", { ...crew, source: "history" });
  const later = {
    ...crew,
    updatedAt: 2,
    source: "history" as const,
    agents: [{ ...crew.agents[0], state: "completed" as const }],
  };
  assert.equal(
    (
      await store.read("terminal", "codex", "first", async () => ({
        ...historical,
        crew: later,
      }))
    )?.crew,
    later,
    "later saved status replaces a disconnected native snapshot",
  );
  store.clear("terminal");
  assert.equal(
    await store.read("terminal", "codex", "first", async () => null),
    null,
  );
});

test("existing incremental Codex history scan extracts bounded task labels without answers or changed usage", () => {
  const ledger = new CodexUsageLedger("primary");
  for (const payload of [
    {
      type: "token_count",
      info: {
        last_token_usage: { total_tokens: 51000 },
        model_context_window: 258400,
      },
    },
    {
      type: "collab_agent_spawn_end",
      new_thread_id: "child",
      new_agent_nickname: "Reviewer",
      status: "running",
      prompt: "Review keyboard input",
    },
    {
      type: "collab_waiting_end",
      statuses: { child: { completed: "PRIVATE ANSWER" } },
    },
  ])
    ledger.append(
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-11-10T01:00:00Z",
        payload,
      }) + "\n",
    );
  const result = ledger.snapshot()!;
  assert.equal(result.contextWindow, 258400);
  assert.deepEqual(result.crew?.agents, [
    {
      id: "child",
      name: "Reviewer",
      state: "completed",
      task: "Review keyboard input",
    },
  ]);
  assert.equal(result.crew?.source, "history");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});
