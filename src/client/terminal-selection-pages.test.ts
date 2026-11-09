import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TerminalSelectionPages,
  type SelectionLine,
} from "./terminal-selection-pages";

const line = (text: string, wrapped = false): SelectionLine => ({
  text,
  cells: [...text.padEnd(80)],
  wrapped,
});
const row = (index: number) =>
  `ROW ${String(index).padStart(3, "0")} original answer text`;
const frame = (top: number) => [
  line("FIXED HEADER"),
  ...Array.from({ length: 17 }, (_, i) => line(row(top + i))),
  line("FIXED STATUS"),
  line("FIXED PROMPT"),
];
const selection = () =>
  new TerminalSelectionPages(
    frame(60),
    80,
    { row: 6, column: 0 },
    { row: 14, column: 0 },
    true,
  );
const expected = (start: number, end: number) =>
  Array.from({ length: end - start }, (_, i) => row(start + i)).join("\n") +
  "\n";

test("native scrolling extends the original anchor across multiple pages and reverses without lost/duplicate lines", () => {
  const selected = selection();
  assert.equal(selected.text(), expected(65, 73));
  assert.equal(selected.update(frame(57), -1), "moved");
  selected.moveFocus({ row: 6, column: 0 });
  assert.equal(selected.text(), expected(62, 73));
  assert.equal(selected.update(frame(54), -1), "moved");
  selected.moveFocus({ row: 6, column: 0 });
  assert.equal(selected.text(), expected(59, 73));
  assert.deepEqual(selected.visibleRange(), {
    start: { row: 6, column: 0 },
    end: { row: 17, column: 80 },
  });
  assert.equal(selected.update(frame(57), 1), "moved");
  selected.moveFocus({ row: 6, column: 0 });
  assert.equal(selected.text(), expected(62, 73));
  assert.doesNotMatch(selected.text()!, /FIXED/);
});

test("a released selection remains exactly the same while scrolling away and back", () => {
  const selected = selection(),
    text = selected.text();
  for (let top = 57; top >= 24; top -= 3)
    assert.equal(selected.update(frame(top), -1), "moved");
  assert.equal(selected.visibleRange(), undefined);
  assert.equal(selected.text(), text);
  for (let top = 27; top <= 60; top += 3)
    assert.equal(selected.update(frame(top), 1), "moved");
  assert.equal(selected.text(), text);
  assert.ok(selected.visibleRange());
});

test("selection can cross its original anchor while scrolling down", () => {
  const selected = selection();
  for (let top = 63; top <= 75; top += 3) {
    assert.equal(selected.update(frame(top), 1), "moved");
    selected.moveFocus({ row: 6, column: 0 });
  }
  assert.equal(selected.text(), expected(73, 80));
});

test("changed, unrelated, repeated and incomplete pages never splice invented text into the selection", () => {
  const selected = selection(),
    text = selected.text();
  assert.equal(selected.update(frame(10), -1), "unmatched");
  assert.equal(selected.text(), text);
  const partial = frame(57);
  partial[6] = line("A changed selected row");
  assert.equal(selected.update(partial, -1), "unmatched");
  assert.equal(selected.text(), text);
  const repeated = frame(57).map((l, i) =>
    i > 0 && i < 18 ? line("Repeated identical sentence on every row") : l,
  );
  assert.equal(selected.update(repeated, -1), "unmatched");
  assert.equal(selected.text(), text);
  // A later complete redraw is still compared to the last verified page.
  assert.equal(selected.update(frame(57), -1), "moved");
  selected.moveFocus({ row: 6, column: 0 });
  assert.equal(selected.text(), expected(62, 73));
});

test("stationary prompt selections cannot be reinterpreted as scrolling response text", () => {
  const selected = new TerminalSelectionPages(
    frame(60),
    80,
    { row: 19, column: 0 },
    { row: 19, column: 5 },
    false,
  );
  assert.equal(selected.update(frame(57), -1), "unmatched");
  assert.equal(selected.text(), "FIXED");
});

test("explicit TUI padding and erased cells identify the same page", () => {
  const padded = (top: number) =>
    frame(top).map((entry, index) => ({
      ...entry,
      text: entry.text + " ".repeat(index % 4 ? 12 : 0),
    }));
  const selected = new TerminalSelectionPages(
    padded(60),
    80,
    { row: 6, column: 0 },
    { row: 14, column: 0 },
    true,
  );
  assert.equal(selected.update(frame(57), -1), "moved");
  selected.moveFocus({ row: 6, column: 0 });
  assert.equal(selected.text(), expected(62, 73));
  assert.equal(selected.update(padded(54), -1), "moved");
  selected.moveFocus({ row: 6, column: 0 });
  assert.equal(selected.text(), expected(59, 73));
});

test("a changing footer before the first scroll does not discard unchanged selected text", () => {
  const selected = selection(),
    text = selected.text();
  const changed = frame(60);
  changed[18] = line("WAITING 00:02");
  assert.equal(selected.update(changed, 0), "unchanged");
  assert.equal(selected.text(), text);
  assert.equal(selected.update(frame(57), -1), "moved");
  selected.moveFocus({ row: 6, column: 0 });
  assert.equal(selected.text(), expected(62, 73));
});

test("blank separators cannot extend a moving region into a resized fixed footer", () => {
  const before = [
    line("HEADER"),
    line(""),
    ...Array.from({ length: 10 }, (_, i) => [
      line(row(90 + i)),
      line(""),
    ]).flat(),
    line(""),
    line("FOOTER"),
    line("PROMPT"),
  ];
  const after = [
    line("HEADER"),
    ...Array.from({ length: 10 }, (_, i) => [
      line(row(89 + i)),
      line(""),
    ]).flat(),
    line(""),
    line(""),
    line("FOOTER"),
    line("PROMPT"),
  ];
  const selected = new TerminalSelectionPages(
    before,
    80,
    { row: 4, column: 0 },
    { row: 18, column: 0 },
    true,
  );
  assert.equal(selected.update(after, -1, true), "moved");
  selected.moveFocus({ row: 4, column: 0 });
  assert.doesNotMatch(selected.text()!, /HEADER|FOOTER|PROMPT/);
  assert.ok(selected.text()!.includes(row(97)));
});

test("cell boundaries preserve Korean, emoji, combining characters, wrapped lines and Windows newlines", () => {
  const first = {
    text: "한🙂e\u0301!",
    cells: ["한", "", "🙂", "", "e\u0301", "!"],
    wrapped: false,
  };
  const second = { text: "next", cells: ["n", "e", "x", "t"], wrapped: true };
  const third = { text: "last", cells: ["l", "a", "s", "t"], wrapped: false };
  const selected = new TerminalSelectionPages(
    [first, second, third],
    6,
    { row: 0, column: 2 },
    { row: 2, column: 4 },
    false,
  );
  assert.equal(selected.text("\r\n"), "🙂e\u0301!next\r\nlast");
});
