import test from "node:test";
import assert from "node:assert/strict";
import { HistoryActivities, activityBudget } from "./history-activity.js";
import { historyItem } from "./history-items.js";
import type { HostConfig, MessageItem } from "../shared/types.js";
const host = { id: "activity-fixture", kind: "ssh", address: "fixture.invalid", username: "fixture", port: 22, codexPath: "codex" } as HostConfig;
const item: MessageItem = { id: "command-1", kind: "command", text: "npm test", detail: "한😀 output\n".repeat(10000) };

test("exact work output is stable, chunked without broken Unicode and scoped to host/provider/session", () => {
  const store = new HistoryActivities();
  const preview = store.preview(host, "codex", "thread", item, activityBudget());
  assert.equal(preview.activityRef, store.preview(host, "codex", "thread", item, activityBudget()).activityRef);
  const full = item.text + "\n" + item.detail;
  let result = "", offset = 0, calls = 0;
  while (true) {
    const page = store.read(host, "codex", "thread", preview.activityRef!, offset);
    assert.equal(page.offset, offset);
    assert.equal(page.total, full.length);
    assert.ok(page.text.length <= 65536);
    assert.ok(!/[\uD800-\uDBFF]$/.test(page.text));
    result += page.text; calls++;
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  assert.ok(calls > 1);
  assert.equal(result, full);
  for (const [target, provider, session] of [
    [{ ...host, id: "another" }, "codex", "thread"],
    [{ ...host, address: "other.invalid" }, "codex", "thread"],
    [host, "claude", "thread"], [host, "codex", "other-thread"],
  ] as const) assert.throws(() => store.read(target, provider, session, preview.activityRef!), /다시 불러/);
  for (const offset of [-1, 0.5, Infinity, full.length + 1])
    assert.throws(() => store.read(host, "codex", "thread", preview.activityRef!, offset), /잘못된/);
  const changed = store.preview(host, "codex", "thread", { ...item, detail: item.detail + "changed" }, activityBudget());
  assert.notEqual(changed.activityRef, preview.activityRef);
});

test("cache expiration and LRU are explicit reload errors and oversized output never removes an activity row", () => {
  let now = 0;
  const store = new HistoryActivities(12000, 1000, () => now);
  const a = { ...item, detail: "x".repeat(5000) };
  const first = store.preview(host, "claude", "session", a, activityBudget());
  assert.ok(first.activityRef);
  now = 1001;
  assert.throws(() => store.read(host, "claude", "session", first.activityRef!), /새로고침/);
  const restored = store.preview(host, "claude", "session", a, activityBudget());
  assert.equal(restored.activityRef, first.activityRef);
  store.preview(host, "claude", "session", { ...a, id: "other" }, activityBudget());
  assert.throws(() => store.read(host, "claude", "session", restored.activityRef!), /새로고침/);
  const huge = store.preview(host, "claude", "session", item, activityBudget());
  assert.equal(huge.id, item.id);
  assert.equal(huge.activityTruncated, true);
  assert.equal(huge.activityRef, undefined);
});

test("history projection reads saved tool text but excludes private reasoning, image bytes and unknown argument fields", () => {
  assert.equal(historyItem({ id: "private", type: "reasoning", text: "hidden" }), null);
  const publicItem = historyItem({ id: "mcp", type: "mcpToolCall", server: "fixture", tool: "read", arguments: { path: "/fixture", token: "secret-token" }, result: { content: [{ type: "text", text: "public text" }, { type: "image", data: "secret-image" }] } })!;
  assert.equal(publicItem.detail, "path: /fixture\npublic text");
  assert.ok(!JSON.stringify(publicItem).includes("secret-"));
  assert.ok(!JSON.stringify(historyItem({ id: "unknown", type: "collabAgentToolCall" })).includes("undefined"));
});
