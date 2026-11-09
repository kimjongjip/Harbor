import test from "node:test";
import assert from "node:assert/strict";
import { mergeConversation } from "./mobile/MobileConversation";
import { trimNativeRow } from "./mobile/terminal-flow";
const question = (id: string) => ({ id, kind: "user" as const, text: id });
const answer = (id: string, text = id) => ({
  id,
  kind: "assistant" as const,
  text,
});
test("conversation page overlap keeps questions and answers ordered and updates an existing answer", () => {
  const latest = [question("q2"), answer("a2"), question("q3"), answer("a3")];
  const earlier = mergeConversation(
    latest,
    [question("q1"), answer("a1"), question("q2"), answer("a2")],
    true,
  );
  assert.deepEqual(
    earlier.map((i) => i.id),
    ["q1", "a1", "q2", "a2", "q3", "a3"],
  );
  const updated = mergeConversation(
    earlier,
    [
      question("q3"),
      answer("a3", "complete answer"),
      question("q4"),
      answer("a4"),
    ],
    false,
  );
  assert.deepEqual(
    updated.map((i) => i.id),
    ["q1", "a1", "q2", "a2", "q3", "a3", "q4", "a4"],
  );
  assert.equal(updated[5].text, "complete answer");
  assert.deepEqual(
    mergeConversation(updated, latest, true).map((i) => i.id),
    updated.map((i) => i.id),
  );
  assert.equal(
    mergeConversation(updated, latest, true).find((item) => item.id === "a3")
      ?.text,
    "complete answer",
    "older native partial records cannot overwrite a newer completed reply",
  );
});
test("phone native rows trim only right-hand empty cells and keep original styles and indentation", () => {
  const row = [
    { text: "  한글 ", style: { color: "red" } },
    { text: "    ", style: {} },
  ];
  assert.deepEqual(trimNativeRow(row), [
    { text: "  한글", style: { color: "red" } },
  ]);
  assert.equal(row[0].text, "  한글 ");
  assert.deepEqual(trimNativeRow([{ text: " ", style: {} }]), []);
});
