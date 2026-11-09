import test from "node:test";
import assert from "node:assert/strict";
import type { MessageItem } from "../shared/types";
import {
  conversationTurns,
  mergeTimeline,
  expandTimeline,
} from "./conversation-turns";

const item = (
  id: string,
  kind: MessageItem["kind"],
  extra: Partial<MessageItem> = {},
): MessageItem => ({ id, kind, text: id, ...extra });

test("compact history restores Q/A and work order without duplicating message objects", () => {
  const q = item("q", "user"),
    a = item("a", "assistant", {
      turnStatus: "completed",
      phase: "final_answer",
    }),
    work = item("w", "command");
  const items = [q, a];
  const result = expandTimeline({
    items,
    activity: [work],
    timelineIds: [
      "user:q",
      "command:w",
      "assistant:a",
      "assistant:a",
      "unknown:gone",
    ],
  });
  assert.deepEqual(result, [q, work, a]);
  assert.equal(result[0], q);
  assert.equal(result[2], a);
  assert.equal(expandTimeline({ items }), items);
  assert.deepEqual(expandTimeline({ items, timelineIds: ["user:q"] }), items);
});

test("new tool work after a previously verified answer cannot be folded as a completed turn", () => {
  const turns = conversationTurns([
    item("q", "user", { turnId: "t" }),
    item("a", "assistant", {
      turnId: "t",
      phase: "final_answer",
      turnStatus: "completed",
    }),
    item("w", "tool", { turnId: "t", turnStatus: "unknown" }),
  ]);
  assert.equal(turns[0].complete, false);
  assert.equal(turns[0].finalIds.size, 0);
});

test("only a completed native final answer closes its turn; progress and tool text stay associated", () => {
  const result = conversationTurns([
    item("q", "user", { turnId: "turn" }),
    item("thinking", "assistant", {
      turnId: "turn",
      phase: "commentary",
      turnStatus: "completed",
    }),
    item("command", "command", { turnId: "turn", turnStatus: "completed" }),
    item("final", "assistant", {
      turnId: "turn",
      phase: "final_answer",
      turnStatus: "completed",
    }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].complete, true);
  assert.deepEqual([...result[0].finalIds], ["final"]);
  assert.deepEqual(
    result[0].items.map((entry) => entry.id),
    ["q", "thinking", "command", "final"],
  );
});

test("unknown, in-progress, failed and interrupted native turns do not become complete by their phase alone", () => {
  for (const turnStatus of [
    undefined,
    "unknown",
    "inProgress",
    "failed",
    "interrupted",
  ] as const) {
    const [turn] = conversationTurns([
      item("unconfirmed", "assistant", { phase: "final_answer", turnStatus }),
    ]);
    assert.equal(turn.complete, false, String(turnStatus));
    assert.equal(turn.finalIds.size, 0);
  }
  const [commentaryOnly] = conversationTurns([
    item("commentary", "assistant", {
      phase: "commentary",
      turnStatus: "completed",
    }),
  ]);
  assert.equal(commentaryOnly.complete, false);
});

test("legacy completion uses only the reader-verified final item and active or failed native status vetoes it", () => {
  const messages = [
    item("q", "user"),
    item("final", "assistant", { text: "Confirmed answer" }),
  ];
  assert.equal(conversationTurns(messages, "final")[0].complete, true);
  for (const completedItemId of [
    undefined,
    "different-item",
    "Confirmed answer",
  ]) {
    assert.equal(
      conversationTurns(messages, completedItemId)[0].complete,
      false,
    );
  }
  for (const turnStatus of ["inProgress", "failed", "interrupted"] as const) {
    assert.equal(
      conversationTurns(
        [item("final", "assistant", { text: "Confirmed answer", turnStatus })],
        "final",
      )[0].complete,
      false,
      turnStatus,
    );
  }
  assert.equal(
    conversationTurns(
      [item("tool", "command", { text: "Confirmed answer" })],
      "tool",
    )[0].complete,
    false,
  );
});

test("native turn IDs group multiple question parts and separate new turns even when pages start with an answer", () => {
  const native = conversationTurns([
    item("partial-old", "assistant", { turnId: "old" }),
    item("q", "user", { turnId: "new" }),
    item("image", "user", { turnId: "new", imageCount: 1 }),
    item("a", "assistant", { turnId: "new" }),
  ]);
  assert.deepEqual(
    native.map((turn) => turn.items.map((message) => message.id)),
    [["partial-old"], ["q", "image", "a"]],
  );
  const legacy = conversationTurns([
    item("partial", "assistant"),
    item("q1", "user"),
    item("a1", "assistant"),
    item("q2", "user"),
    item("a2", "assistant"),
  ]);
  assert.deepEqual(
    legacy.map((turn) => turn.items.map((message) => message.id)),
    [["partial"], ["q1", "a1"], ["q2", "a2"]],
  );
});

test("older pages preserve newer complete text and its position while refreshing updates in place", () => {
  const current = [
    item("q2", "user"),
    item("a2", "assistant", { text: "Complete answer" }),
  ];
  const older = [
    item("q1", "user"),
    item("a1", "assistant"),
    item("a2", "assistant", { text: "Stale partial" }),
  ];
  const merged = mergeTimeline(current, older, true);
  assert.deepEqual(
    merged.map((message) => message.id),
    ["q1", "a1", "q2", "a2"],
  );
  assert.equal(merged.at(-1)?.text, "Complete answer");
  const refreshed = mergeTimeline(
    merged,
    [item("a2", "assistant", { text: "Updated final" }), item("q3", "user")],
    false,
  );
  assert.deepEqual(
    refreshed.map((message) => message.id),
    ["q1", "a1", "q2", "a2", "q3"],
  );
  assert.equal(refreshed[3].text, "Updated final");
  assert.equal(current[1].text, "Complete answer");
});

test("overlapping incoming records render once and different message kinds retain their identity", () => {
  const repeated = [
    item("same", "assistant", { text: "Partial" }),
    item("same", "assistant", { text: "Final" }),
    item("same", "user"),
  ];
  for (const older of [true, false]) {
    const merged = mergeTimeline([], repeated, older);
    assert.equal(merged.length, 2);
    assert.deepEqual(
      merged.map((message) => message.kind),
      ["assistant", "user"],
    );
    assert.equal(merged[0].text, "Final");
  }
});

test("a refreshed active native turn cannot stay completed because an older final message remains", () => {
  for (const turnStatus of ["inProgress", "failed", "interrupted"] as const) {
    const [turn] = conversationTurns([
      item("previous-final", "assistant", {
        turnId: "same-turn",
        phase: "final_answer",
        turnStatus: "completed",
      }),
      item("latest-work", "command", { turnId: "same-turn", turnStatus }),
    ]);
    assert.equal(turn.complete, false, turnStatus);
    assert.equal(turn.finalIds.size, 0);
  }
});

test("refresh inserts newly discovered work in native order and retains unchanged message objects", () => {
  const question = item("q", "user"),
    answer = item("a", "assistant", { text: "Answer" });
  const refreshed = mergeTimeline(
    [question, answer],
    [{ ...question }, item("work", "command"), { ...answer }],
    false,
  );
  assert.deepEqual(
    refreshed.map((message) => message.id),
    ["q", "work", "a"],
  );
  assert.equal(refreshed[0], question);
  assert.equal(refreshed[2], answer);
});

test("verified earlier Stop proof stays tied to the same message text when a new prompt starts", () => {
  const verified = new Map([["a1", "Completed first answer"]]);
  const turns = conversationTurns(
    [
      item("q1", "user"),
      item("a1", "assistant", { text: "Completed first answer" }),
      item("q2", "user"),
      item("a2", "assistant", { text: "Next partial answer" }),
    ],
    verified,
  );
  assert.deepEqual(
    turns.map((turn) => turn.complete),
    [true, false],
  );
  assert.equal(
    conversationTurns(
      [item("a1", "assistant", { text: "Changed first answer" })],
      verified,
    )[0].complete,
    false,
  );
});
