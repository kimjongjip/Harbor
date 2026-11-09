import test from "node:test";
import assert from "node:assert/strict";
import { MobileConversations } from "./mobile-conversation";
import { mobileFixture } from "../test/mobile-fixture";
import type { TerminalInfo } from "../shared/types";
import type { HistoryDetail } from "../shared/history";

for (const provider of ["codex", "claude"] as const)
  test(`${provider} mobile history uses the bound conversation and coalesces reads without resuming`, async () => {
    let current: TerminalInfo | undefined = {
      id: "terminal",
      hostId: "host",
      title: "Fixture",
      cwd: "/fixture",
      exited: false,
      agentKind: provider,
      agentSessionId: "session",
    };
    let calls = 0,
      release!: (value: HistoryDetail) => void;
    const service = new MobileConversations(
      (id) => (id === "terminal" ? current : undefined),
      async (host, agent, session, cursor) => {
        calls++;
        assert.deepEqual(
          [host, agent, session, cursor],
          ["host", provider, "session", "page2"],
        );
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    );
    await assert.rejects(service.read("missing", "session"));
    await assert.rejects(service.read("terminal", "another"));
    assert.equal(calls, 0);
    const page: HistoryDetail = {
      thread: {
        id: "session",
        hostId: "host",
        title: "Fixture",
        cwd: "/private",
        preview: "",
        updatedAt: 1,
        source: provider,
        active: true,
      },
      items: [
        { id: "q", kind: "user", text: "original question", imageCount: 1 },
        { id: "tool", kind: "tool", text: "hidden tool" },
        { id: "a", kind: "assistant", text: "original answer" },
      ],
      nextCursor: "page3",
      notice: "An oversized record was omitted from this history page.",
    };
    const first = service.read("terminal", "session", "page2"),
      second = service.read("terminal", "session", "page2");
    release(page);
    assert.deepEqual(await first, await second);
    assert.equal(calls, 1);
    assert.deepEqual(
      (await first).items.map((item) => item.kind),
      ["user", "assistant"],
    );
    assert.equal(JSON.stringify(await first).includes("/private"), false);
    assert.equal((await first).notice, page.notice);
    const stale = service.read("terminal", "session", "page2");
    current = { ...current, agentSessionId: "replacement" };
    release(page);
    await assert.rejects(stale, /변경/);
  });

test("mobile conversation endpoint requires pairing, validates queries and is read-only", async () => {
  const f = await mobileFixture();
  try {
    const route = `/mobile-api/terminals/${f.id}/conversation?sessionId=native-fixture`;
    assert.equal((await f.http(route)).status, 401);
    const cookie = await f.pair();
    assert.equal(
      (await f.http(route + "&host=another", undefined, { cookie })).status,
      400,
    );
    const response = await f.http(route, undefined, { cookie });
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.deepEqual(
      page.items.map((item: any) => item.kind),
      ["user", "assistant", "user", "assistant", "user", "assistant"],
    );
    assert.ok(page.nextCursor);
    const older = await (
      await f.http(route + "&cursor=" + page.nextCursor, undefined, { cookie })
    ).json();
    assert.ok(older.items[0].id !== page.items[0].id);
    assert.equal(f.writes.length, 0);
    assert.equal((await f.http(route + "&includeActivity=1", undefined, { cookie })).status, 200);
    assert.equal((await f.http(route + "&includeActivity=yes", undefined, { cookie })).status, 400);
  } finally {
    await f.close();
  }
});

test("mobile activity reads are opt-in, preserve native outcome metadata and do not coalesce with Q/A reads", async () => {
  const terminal = { id: "terminal", hostId: "host", agentKind: "claude", agentSessionId: "session" } as TerminalInfo;
  const item = { id: "answer", kind: "assistant" as const, text: "Done", turnId: "turn", phase: "final_answer", turnStatus: "completed" as const };
  const activity = { id: "tool", kind: "command" as const, text: "npm test", detail: "Tests passed", turnId: "turn", turnStatus: "completed" as const };
  const calls: boolean[] = [];
  let mismatch = false;
  const service = new MobileConversations(() => terminal, async (_host, _provider, _session, _cursor, options) => {
    calls.push(!!options?.includeActivity);
    await new Promise(resolve => setImmediate(resolve));
    return { thread: { id: "session", hostId: mismatch ? "other-host" : "host" } as HistoryDetail["thread"], items: [item], timeline: [activity, item], nextCursor: null };
  });
  const [qa, detailed] = await Promise.all([service.read("terminal", "session"), service.read("terminal", "session", undefined, { includeActivity: true })]);
  assert.deepEqual(calls, [false, true]);
  assert.equal(qa.timeline, undefined);
  assert.equal(qa.items[0].phase, "final_answer");
  assert.equal(qa.items[0].turnStatus, "completed");
  assert.equal(detailed.timeline, undefined);
  assert.deepEqual(detailed.activity, [activity]);
  assert.deepEqual(detailed.timelineIds, ["command:tool", "assistant:answer"]);
  mismatch = true;
  await assert.rejects(service.read("terminal", "session"), /조회 중 대화가 변경/);
});
