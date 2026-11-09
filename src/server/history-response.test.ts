import test from "node:test";
import assert from "node:assert/strict";
import type { MessageItem } from "../shared/types.js";
import { serializeHistoryDetailForRead } from "./history-response.js";

test("compact history keeps ordered kind:id references and one copy of questions/answers/notices", () => {
  const user: MessageItem = { id: "same:id", kind: "user", text: "Question", imageCount: 1 };
  const assistant: MessageItem = { id: "same:id", kind: "assistant", text: "Final answer", phase: "final_answer", turnStatus: "completed" };
  const notice: MessageItem = { id: "notice", kind: "notice", text: "Compacted" };
  const work: MessageItem = { id: "command", kind: "command", text: "npm test", detail: "Tests passed" };
  const source = { items: [user, assistant, notice], timeline: [user, work, assistant, notice], nextCursor: "older" };
  const wire = serializeHistoryDetailForRead(source);
  assert.deepEqual(wire.items, source.items);
  assert.deepEqual(wire.activity, [work]);
  assert.deepEqual(wire.timelineIds, ["user:same:id", "command:command", "assistant:same:id", "notice:notice"]);
  assert.equal((wire as any).timeline, undefined);
  const lookup = new Map([...wire.items, ...wire.activity!].map(item => [`${item.kind}:${item.id}`, item]));
  assert.deepEqual(wire.timelineIds!.map(key => lookup.get(key)), source.timeline);
  assert.equal(source.timeline.length, 4, "internal timeline is not mutated");
  assert.equal(wire.nextCursor, "older");
});

test("large Q/A history is serialized once with no plaintext truncation", () => {
  const text = "q".repeat(8 * 1024 * 1024);
  const answer: MessageItem = { id: "large-answer", kind: "assistant", text, turnStatus: "completed", phase: "final_answer" };
  const input = { items: [answer], timeline: [answer], nextCursor: null };
  const wire = serializeHistoryDetailForRead(input);
  const encoded = JSON.stringify(wire);
  assert.equal(wire.items[0].text.length, text.length);
  assert.equal(JSON.parse(encoded).items[0].text, text);
  assert.ok(encoded.length < text.length + 500);
  assert.ok(JSON.stringify(input).length > 2 * text.length);
});

test("ordinary Q/A responses keep their existing shape without activity opt-in", () => {
  const source = { items: [{ id: "q", kind: "user" as const, text: "Question" }], nextCursor: null };
  assert.deepEqual(serializeHistoryDetailForRead(source), source);
});
