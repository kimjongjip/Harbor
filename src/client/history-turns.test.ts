import test from "node:test";
import assert from "node:assert/strict";
import type { MessageItem } from "../shared/types";
import {
  newestHistoryTurns,
  prependOlderHistory,
  recentHistoryQuestion,
  historySnippet,
} from "./history-turns";

const message = (
  id: string,
  kind: MessageItem["kind"],
  turnId?: string,
): MessageItem => ({ id, kind, text: id, turnId });

test("recent history reverses whole turns while retaining question and all answers", () => {
  const items = [
    message("q1", "user"),
    message("a1", "assistant"),
    message("q2", "user"),
    message("a2-plan", "assistant"),
    message("a2-final", "assistant"),
  ];
  assert.deepEqual(
    newestHistoryTurns(items).map((turn) => turn.items.map((item) => item.id)),
    [
      ["q2", "a2-plan", "a2-final"],
      ["q1", "a1"],
    ],
  );
  assert.equal(recentHistoryQuestion(items), "q2");
  assert.equal(recentHistoryQuestion([]), "");
});

test("native turn identity keeps multimodal question parts together and separates partial turns", () => {
  const items = [
    message("q1", "user", "one"),
    message("image1", "user", "one"),
    message("a1", "assistant", "one"),
    message("partial-a2", "assistant", "two"),
  ];
  assert.deepEqual(
    newestHistoryTurns(items).map((turn) => turn.items.map((item) => item.id)),
    [["partial-a2"], ["q1", "image1", "a1"]],
  );
});

test("older pages complete a partial turn without moving or overwriting newer duplicate messages", () => {
  const current = [
    message("a2", "assistant"),
    message("q3", "user"),
    message("a3", "assistant"),
  ];
  const older = [
    message("q1", "user"),
    message("a1", "assistant"),
    message("q2", "user"),
    { ...message("a3", "assistant"), text: "stale partial" },
  ];
  const merged = prependOlderHistory(current, older);
  assert.deepEqual(
    newestHistoryTurns(merged).map((turn) => ({
      id: turn.id,
      items: turn.items.map((item) => item.id),
    })),
    [
      { id: "a3", items: ["q3", "a3"] },
      { id: "a2", items: ["q2", "a2"] },
      { id: "a1", items: ["q1", "a1"] },
    ],
  );
  assert.equal(merged.at(-1)?.text, "a3");
  assert.deepEqual(
    current.map((item) => item.id),
    ["a2", "q3", "a3"],
  );
});

test("snippets collapse line breaks without exposing a full long prompt in the list", () => {
  assert.equal(historySnippet("  첫 질문\n\n다음 줄 "), "첫 질문 다음 줄");
  assert.equal(historySnippet("1234567890", 5), "12345…");
});
