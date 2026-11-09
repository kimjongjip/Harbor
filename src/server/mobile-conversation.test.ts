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
  } finally {
    await f.close();
  }
});
