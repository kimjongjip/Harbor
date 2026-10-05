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
