import test from "node:test";
import assert from "node:assert/strict";
import { History } from "./history.js";
import type { HostConfig } from "../shared/types.js";
const host: HostConfig = {
  id: "local",
  kind: "local",
  name: "Local",
  address: "",
  username: "",
  port: 22,
  identityFile: "",
  codexPath: "codex",
  defaultCwd: "C:\\current-project",
  mode: "auto",
  color: "#112233",
  createdAt: 0,
};
const threadId = "0199aaaa-1111-7111-8111-111111111111";
test("model catalog is account/host scoped, paginated and read-only; labels never replace native model IDs", async () => {
  const calls: { method: string; params: any }[] = [];
  const selected = { ...host, id: "fixture-ssh", kind: "ssh" as const };
  const reader = new History(async (actual, password) => {
    assert.equal(actual.id, selected.id);
    assert.equal(password, "synthetic-password");
    return {
      alive: true,
      stop() {},
      async call(method, params: any) {
        calls.push({ method, params });
        assert.equal(method, "model/list");
        return params.cursor
          ? {
              data: [{ id: "second", displayName: "Second", isDefault: false }],
              nextCursor: null,
            }
          : {
              data: [
                {
                  id: "internal-id",
                  model: "gpt-6-astra",
                  displayName: "GPT-6 Astra",
                  isDefault: true,
                  defaultReasoningEffort: "low",
                  supportedReasoningEfforts: [
                    { reasoningEffort: "low" },
                    { reasoningEffort: "max" },
                    { reasoningEffort: "made-up" },
                  ],
                },
                { model: "hidden-model", hidden: true },
                { model: "invalid;id" },
              ],
              nextCursor: "second-page",
            };
      },
    };
  });
  try {
    assert.deepEqual(await reader.models(selected, "synthetic-password"), [
      {
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        isDefault: true,
        efforts: ["low", "max"],
        defaultEffort: "low",
      },
      { id: "second", name: "Second", isDefault: false },
    ]);
    assert.deepEqual(
      calls.map((c) => c.params),
      [
        { limit: 100, includeHidden: false, cursor: null },
        { limit: 100, includeHidden: false, cursor: "second-page" },
      ],
    );
  } finally {
    reader.shutdown();
  }
});

test("malformed or cycling native model catalogs fail rather than trusting a partial availability list", async () => {
  for (const result of [
    { data: {}, nextCursor: null },
    { data: [], nextCursor: "repeated" },
  ]) {
    const reader = new History(async () => ({
      alive: true,
      stop() {},
      async call() {
        return result;
      },
    }));
    try {
      await assert.rejects(reader.models(host), /모델 목록/);
    } finally {
      reader.shutdown();
    }
  }
});
test("history spans all projects, keeps cursor/source filters and never resumes during preview", async () => {
  const calls: { method: string; params: any }[] = [];
  let stops = 0;
  const history = new History(async () => ({
    alive: true,
    stop() {
      stops++;
    },
    async call(method, params) {
      calls.push({ method, params });
      if (method === "thread/list")
        return {
          data: [
            {
              id: threadId,
              name: "Earlier work",
              cwd: "C:\\different-project",
              updatedAt: 123,
              source: "cli",
            },
          ],
          nextCursor: "page-two",
        };
      if (method === "thread/read")
        return {
          thread: {
            id: threadId,
            cwd: "C:\\different-project",
            name: "Earlier work",
          },
        };
      if (method === "thread/turns/list")
        return {
          data: [
            {
              id: "newer",
              items: [
                { id: "a", type: "agentMessage", text: "answer" },
                { id: "private", type: "reasoning", text: "hidden" },
              ],
            },
            {
              id: "older",
              items: [
                {
                  id: "u",
                  type: "userMessage",
                  content: [{ type: "text", text: "question" }],
                },
              ],
            },
          ],
          nextCursor: "older-turns",
        };
      throw Error("Unexpected method");
    },
  }));
  try {
    const page = await history.list(host, undefined, {
      cursor: "previous",
      search: "Earlier",
    });
    assert.equal(page.data[0].cwd, "C:\\different-project");
    assert.equal(page.nextCursor, "page-two");
    assert.equal(calls[0].params.cwd, undefined);
    assert.equal(calls[0].params.cursor, "previous");
    assert.deepEqual(calls[0].params.sourceKinds, ["cli", "vscode"]);
    const detail = await history.read(host, undefined, threadId);
    assert.deepEqual(
      detail.items.map((i) => i.text),
      ["question", "answer"],
    );
    assert.equal(detail.nextCursor, "older-turns");
    assert.ok(!calls.some((c) => /resume|start/.test(c.method)));
    await history.list(host, undefined, {
      includeAutomation: true,
      archived: true,
    });
    assert.ok(calls.at(-1)!.params.sourceKinds.includes("exec"));
    assert.equal(calls.at(-1)!.params.archived, true);
  } finally {
    history.shutdown();
    await Promise.resolve();
  }
  assert.equal(stops, 1);
});
test("history supports old Codex read methods and disposes only its own reader after idle", async () => {
  let stops = 0,
    starts = 0;
  const history = new History(async () => {
    starts++;
    return {
      alive: true,
      stop() {
        stops++;
      },
      async call(method, params: any) {
        if (method === "thread/turns/list") throw Error("Unknown method");
        return {
          thread: {
            id: threadId,
            cwd: "/project",
            turns: params.includeTurns
              ? Array.from({ length: 25 }, (_, index) => ({
                  id: `turn-${index}`,
                  items: [
                    {
                      id: `a-${index}`,
                      type: "agentMessage",
                      text: `old CLI answer ${index}`,
                    },
                  ],
                }))
              : [],
          },
        };
      },
    };
  }, 15);
  const detail = await history.read(host, undefined, threadId);
  assert.equal(detail.items[0].text, "old CLI answer 5");
  assert.equal(detail.items.length, 20);
  assert.ok(detail.nextCursor);
  const older = await history.read(
    host,
    undefined,
    threadId,
    detail.nextCursor!,
  );
  assert.deepEqual(
    older.items.map((item) => item.text),
    Array.from({ length: 5 }, (_, i) => `old CLI answer ${i}`),
  );
  assert.equal(older.nextCursor, null);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(stops, 1);
  await history.summary(host, undefined, threadId);
  assert.equal(starts, 2);
  history.shutdown();
  await Promise.resolve();
  assert.equal(stops, 2);
});

test("opt-in Codex timeline preserves native completion and bounded work without exposing reasoning", async () => {
  const turns = [
    { id: "done", status: "completed", items: [
      { id: "q", type: "userMessage", content: [{ type: "text", text: "Fix the parser" }] },
      { id: "progress", type: "agentMessage", phase: "commentary", text: "Checking the parser" },
      { id: "work", type: "commandExecution", command: "npm test", aggregatedOutput: "x".repeat(20000), status: "completed" },
      { id: "private", type: "reasoning", text: "must never appear" },
      { id: "answer", type: "agentMessage", phase: "final_answer", text: "Fixed" },
    ] },
    { id: "live", status: "inProgress", items: [{ id: "live-text", type: "agentMessage", text: "Still working" }] },
    { id: "failed", status: "failed", items: [{ id: "failed-text", type: "agentMessage", phase: "final_answer", text: "An incomplete result" }] },
    { id: "legacy", items: [{ id: "unknown-text", type: "agentMessage", text: "Unverified" }] },
  ];
  const history = new History(async () => ({ alive: true, stop() {}, async call(method) {
    return method === "thread/read" ? { thread: { id: threadId, status: { type: "idle" } } } : { data: [...turns].reverse() };
  } }));
  try {
    const normal = await history.read(host, undefined, threadId);
    assert.equal(normal.timeline, undefined);
    assert.ok(normal.items.every(item => item.kind !== "command"));
    const detail = await history.read(host, undefined, threadId, undefined, { includeActivity: true });
    assert.deepEqual(detail.timeline!.map(item => item.id), ["q", "progress", "work", "answer", "live-text", "failed-text", "unknown-text"]);
    assert.equal(detail.timeline![2].detail!.length, 4000);
    assert.equal(detail.items.find(item => item.id === "answer")!.turnStatus, "completed");
    assert.equal(detail.items.find(item => item.id === "progress")!.phase, "commentary");
    assert.equal(detail.items.find(item => item.id === "live-text")!.turnStatus, "inProgress");
    assert.equal(detail.items.find(item => item.id === "failed-text")!.turnStatus, "failed");
    assert.equal(detail.items.find(item => item.id === "unknown-text")!.turnStatus, "unknown");
    assert.ok(!JSON.stringify(detail).includes("must never appear"));
  } finally { history.shutdown(); }
});

test("Codex history rejects a mismatched native conversation instead of displaying another session", async () => {
  const history = new History(async () => ({ alive: true, stop() {}, async call() { return { thread: { id: "another-thread" } }; } }));
  try { await assert.rejects(history.read(host, undefined, threadId), /대화가 변경/); }
  finally { history.shutdown(); }
});

test("read-only history leases reuse one host reader and explicit close disposes it before reconnecting", async () => {
  let starts = 0, stops = 0;
  const history = new History(async () => {
    starts++;
    return { alive: true, stop() { stops++; }, async call(method) {
      assert.equal(method, "thread/read");
      return { thread: { id: threadId } };
    } };
  });
  try {
    await history.summary(host, undefined, threadId);
    await history.summary(host, undefined, threadId);
    assert.equal(starts, 1);
    history.close(host.id);
    await Promise.resolve();
    assert.equal(stops, 1);
    await history.summary(host, undefined, threadId);
    assert.equal(starts, 2);
  } finally { history.shutdown(); }
  await Promise.resolve();
  assert.equal(stops, 2);
});
