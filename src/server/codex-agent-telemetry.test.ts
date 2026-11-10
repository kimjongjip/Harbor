import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexAgentTelemetry,
  codexAgentTail,
} from "./codex-agent-telemetry.js";
import { History } from "./history.js";
import type { HostConfig } from "../shared/types.js";
import type { TerminalCrewSnapshot } from "../shared/terminal-agents.js";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const usage = (total = 12000) =>
  JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: total,
          input_tokens: 10000,
          output_tokens: 2000,
          cached_input_tokens: 8000,
        },
        last_token_usage: { total_tokens: 3000 },
      },
    },
  }) + "\n";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const crew = (count: number): TerminalCrewSnapshot => ({
  source: "history",
  updatedAt: 1,
  agents: Array.from({ length: count }, (_, i) => ({
    id: id(i),
    name: `agent-${i}`,
    state: "working",
  })),
});

test("agent tail uses the latest cumulative count, tolerates partial records, and keeps unknown distinct from zero", () => {
  assert.equal(
    codexAgentTail(usage() + usage() + '{"type":').tokens?.total,
    12000,
  );
  assert.equal(codexAgentTail(usage(0)).tokens?.total, 0);
  assert.equal(codexAgentTail(usage(-1)).tokens, undefined);
  assert.equal(
    codexAgentTail(
      JSON.stringify({
        type: "event_msg",
        payload: { type: "agent_message", message: "PRIVATE ANSWER" },
      }) + "\n",
    ).tokens,
    undefined,
  );
});

test("child metadata reads stay bounded and never delay, replace, or leak into the parent snapshot", async () => {
  const store = new CodexAgentTelemetry(),
    source = crew(8),
    lookups: string[] = [],
    releases: (() => void)[] = [];
  const lookup = (child: string) => {
    lookups.push(child);
    return new Promise<{ path: string; task: string }>((resolve) =>
      releases.push(() =>
        resolve({
          path: `/saved/${child}.jsonl`,
          task: "Review input rendering",
        }),
      ),
    );
  };
  const tail = async () => usage();
  const immediate = store.read("host", "parent", source, lookup, tail);
  assert.equal(lookups.length, 4);
  assert.equal(immediate.agents[0].tokens, undefined);
  store.read("host", "parent", source, lookup, tail);
  assert.equal(lookups.length, 4, "a slow read is coalesced");
  releases.splice(0).forEach((release) => release());
  await tick();
  const populated = store.read("host", "parent", source, lookup, tail);
  assert.equal(lookups.length, 8);
  assert.equal(populated.agents[0].tokens?.total, 12000);
  assert.equal(populated.agents[0].task, "Review input rendering");
  assert.equal(
    source.agents[0].tokens,
    undefined,
    "never mutate shared primary usage",
  );
  store.clear("host");
  releases.splice(0).forEach((release) => release());
  await tick();
  const different = store.read(
    "host",
    "other-parent",
    crew(1),
    async () => ({ path: null }),
    tail,
  );
  assert.equal(different.agents[0].tokens, undefined);
  store.shutdown();
});

test("native agent totals take precedence and known telemetry never launches a history scan", () => {
  const store = new CodexAgentTelemetry(),
    source = crew(1);
  source.agents[0] = {
    ...source.agents[0],
    task: "Review layout",
    tokens: { total: 0, scope: "session" },
  };
  let called = 0;
  const value = store.read(
    "host",
    "parent",
    source,
    async () => {
      called++;
      return { path: null };
    },
    async () => usage(),
  );
  assert.equal(value.agents[0].tokens?.total, 0);
  assert.equal(called, 0);
  store.shutdown();
});

test("agent path lookup uses read-only metadata and rejects a different returned conversation", async () => {
  const calls: any[] = [];
  let returned = id(1);
  const history = new History(async () => ({
    alive: true,
    stop() {},
    async call(method, params) {
      calls.push({ method, params });
      return {
        thread: {
          id: returned,
          path: "/saved/child.jsonl",
          preview: "Review layout",
        },
      };
    },
  }));
  const host = { id: "host", kind: "local" } as HostConfig;
  try {
    assert.deepEqual(await history.agentTelemetryPath(host, undefined, id(1)), {
      path: "/saved/child.jsonl",
      task: "Review layout",
    });
    returned = id(2);
    await assert.rejects(
      history.agentTelemetryPath(host, undefined, id(1)),
      /Agent session changed/,
    );
    assert.ok(
      calls.every(
        (c) =>
          c.method === "thread/read" &&
          c.params.threadId === id(1) &&
          c.params.includeTurns === false,
      ),
    );
  } finally {
    history.shutdown();
  }
});
