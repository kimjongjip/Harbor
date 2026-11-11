import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { RpcClient, RpcResponseSizeError } from "./rpc.js";
import { History } from "./history.js";
import { serializeHistoryDetailForRead } from "./history-response.js";
import type { HostConfig } from "../shared/types.js";

const host: HostConfig = {
  id: "fixture",
  kind: "local",
  name: "Fixture",
  address: "",
  username: "",
  port: 22,
  identityFile: "",
  codexPath: "synthetic",
  defaultCwd: "/fixture",
  mode: "isolated",
  color: "#123456",
  createdAt: 0,
};
const threadId = "fixture-thread";

test("large full turns retry through the real RPC transport with smaller pages and intact cursors", async () => {
  let starts = 0;
  const calls: { method: string; params: any }[] = [];
  const history = new History(async () => {
    starts++;
    const client = new RpcClient();
    await client.start(process.execPath, [
      fileURLToPath(
        new URL("./fixtures/fake-codex-history-large.mjs", import.meta.url),
      ),
    ]);
    return {
      get alive() {
        return client.alive;
      },
      stop() {
        client.stop();
      },
      call(method, params, timeout) {
        calls.push({ method, params });
        return client.call(method, params, timeout);
      },
    };
  });
  try {
    const first = await history.read(host, undefined, threadId, undefined, {
      includeActivity: true,
    });
    assert.equal(starts, 2, "only the failed history reader is replaced");
    assert.deepEqual(
      calls
        .filter((c) => c.method === "thread/turns/list")
        .map((c) => c.params.limit),
      [4, 2],
    );
    assert.deepEqual(
      first.items.map((i) => i.text),
      ["Question 4", "Answer 4", "Question 5", "Answer 5"],
    );
    assert.equal(first.nextCursor, "2");
    assert.equal(first.items.at(-1)?.turnStatus, "completed");
    assert.equal(first.timeline?.filter((i) => i.kind === "tool").length, 2);
    assert.ok(
      JSON.stringify(serializeHistoryDetailForRead(first)).length < 20000,
    );
    const older = await history.read(
      host,
      undefined,
      threadId,
      first.nextCursor!,
      { includeActivity: true },
    );
    assert.deepEqual(
      older.items.map((i) => i.text),
      ["Question 2", "Answer 2", "Question 3", "Answer 3"],
    );
    assert.equal(older.nextCursor, "4");
    const oldest = await history.read(
      host,
      undefined,
      threadId,
      older.nextCursor!,
    );
    assert.deepEqual(
      oldest.items.map((i) => i.text),
      ["Question 0", "Answer 0", "Question 1", "Answer 1"],
    );
    assert.equal(oldest.nextCursor, null);
    assert.ok(
      calls.every(
        (c) => c.method === "thread/read" || c.method === "thread/turns/list",
      ),
    );
    assert.ok(
      calls
        .filter((c) => c.method === "thread/read")
        .every((c) => c.params.includeTurns === false),
    );
    assert.equal(
      starts,
      2,
      "subsequent polls/pages reuse the learned page size and reader",
    );
  } finally {
    history.shutdown();
  }
});

test("one oversized turn keeps original questions/final answers and recovers full work on the next turn", async () => {
  let latest = "huge",
    fullReads = 0,
    starts = 0;
  const history = new History(async () => {
    starts++;
    return {
      alive: true,
      stop() {},
      async call(method, params: any) {
        if (method === "thread/read")
          return { thread: { id: threadId, cwd: "/fixture" } };
        assert.equal(method, "thread/turns/list");
        assert.equal(params.cursor, "same-opaque-cursor");
        if (params.itemsView === "full") {
          fullReads++;
          if (latest === "huge") throw new RpcResponseSizeError();
        }
        return {
          data: [
            {
              id: latest,
              status: "completed",
              items: [
                {
                  id: latest + "-q",
                  type: "userMessage",
                  content: [{ type: "text", text: "Saved question" }],
                },
                ...(params.itemsView === "full"
                  ? [
                      {
                        id: "work",
                        type: "commandExecution",
                        command: "npm test",
                        aggregatedOutput: "passed",
                        status: "completed",
                      },
                    ]
                  : []),
                {
                  id: latest + "-a",
                  type: "agentMessage",
                  phase: "final_answer",
                  text: "Saved final answer",
                },
              ],
            },
          ],
          nextCursor: "older",
        };
      },
    };
  });
  try {
    const read = () =>
      history.read(host, undefined, threadId, "same-opaque-cursor", {
        includeActivity: true,
      });
    const first = await read();
    assert.equal(
      fullReads,
      3,
      "4, 2, then 1 before bounded native summary fallback",
    );
    assert.equal(starts, 4);
    assert.deepEqual(
      first.items.map((i) => i.text),
      ["Saved question", "Saved final answer"],
    );
    assert.match(first.notice!, /작업 출력이 매우 큰/);
    assert.equal(first.nextCursor, "older");
    assert.equal(first.items.at(-1)?.turnStatus, "completed");
    await read();
    assert.equal(
      fullReads,
      3,
      "polling the same oversized turn must not download it again",
    );
    latest = "next";
    const next = await read();
    assert.equal(fullReads, 4);
    assert.equal(next.notice, undefined);
    assert.equal(
      next.timeline?.find((i) => i.kind === "command")?.detail,
      "passed",
    );
  } finally {
    history.shutdown();
  }
});

test("ordinary history errors are not retried or misreported as large records", async () => {
  let starts = 0;
  const history = new History(async () => {
    starts++;
    return {
      alive: true,
      stop() {},
      async call() {
        throw Error("permission denied");
      },
    };
  });
  try {
    await assert.rejects(
      history.read(host, undefined, threadId),
      /permission denied/,
    );
    assert.equal(starts, 1);
  } finally {
    history.shutdown();
  }
});
