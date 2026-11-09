import test from "node:test";
import assert from "node:assert/strict";
import { richFragments } from "./terminal-rich-layout";
import type { RichTerminalBlock } from "../shared/rich-terminal";
const block: RichTerminalBlock = {
  id: "0123456789abcdef0123",
  marker: "~HBR:0123456789abcdef0123~",
  requestId: "fixture",
  sessionId: "native",
  text: "source",
  columns: 100,
  viewportRows: 30,
  createdAt: 1,
  state: "ready",
  rows: 100,
  renderer: "rows-v2",
};
const marker = (row: number) => `  ~HBR:${block.id}:${row}~`;
test("a long answer is located when its first row is outside the native viewport", () => {
  const result = richFragments(
    [marker(63), marker(64), marker(65), "native input"],
    [block],
  );
  assert.deepEqual(result.get(block.id), [
    {
      firstRow: 0,
      rowOffset: 63,
      rows: 3,
      column: 2,
    },
  ]);
});
test("Claude's floating scroll hint does not expose the last reservation marker", () => {
  const result = richFragments(
    [
      marker(63),
      marker(64).trimStart() + "                 Jump to bottom (ctrl+End) ↓",
      "native input",
    ],
    [block],
  );
  assert.deepEqual(result.get(block.id), [
    {
      firstRow: 0,
      rowOffset: 63,
      rows: 2,
      column: 0,
    },
  ]);
});
test("native input and unrelated rows are never covered by an answer allocation", () => {
  const result = richFragments(
    ["native prompt", marker(98), marker(99), "Ask Claude", "recap"],
    [block],
  );
  assert.deepEqual(result.get(block.id), [
    {
      firstRow: 1,
      rowOffset: 98,
      rows: 2,
      column: 2,
    },
  ]);
  assert.equal(
    richFragments(["native prompt", "compacted while idle"], [block]).size,
    0,
  );
});
test("legacy, unknown, malformed and out-of-allocation markers cannot reserve overlay space", () => {
  for (const lines of [
    [block.marker],
    [marker(100)],
    [marker(-1)],
    ["~HBR:ffffffffffffffffffff:1~"],
    [marker(1) + " unrelated text"],
  ])
    assert.equal(richFragments(lines, [block]).size, 0);
  assert.equal(
    richFragments([marker(1)], [{ ...block, renderer: undefined }]).size,
    0,
  );
});
test("separate runs are clipped independently instead of painting across a native status row", () => {
  const result = richFragments(
    [marker(1), "native status", marker(2), marker(3)],
    [block],
  );
  assert.deepEqual(result.get(block.id), [
    {
      firstRow: 0,
      rowOffset: 1,
      rows: 1,
      column: 2,
    },
    {
      firstRow: 2,
      rowOffset: 2,
      rows: 2,
      column: 2,
    },
  ]);
});

test("all reservation fragments remain visible around wrapped native output", () => {
  const mixed = marker(44).padEnd(80) + "native suffix";
  const lines = [
    marker(39),
    marker(40),
    marker(41),
    marker(42),
    marker(43),
    mixed,
    "wrapped native continuation",
    marker(45),
    marker(46),
    marker(47),
    "NATIVE INPUT >",
  ];
  const result = richFragments(lines, [block]);
  assert.deepEqual(result.get(block.id), [
    { firstRow: 0, rowOffset: 39, rows: 5, column: 2 },
    { firstRow: 5, rowOffset: 44, rows: 1, column: 2, columns: 78 },
    { firstRow: 7, rowOffset: 45, rows: 3, column: 2 },
  ]);
  assert.equal(
    result.get(block.id)!.reduce((sum, fragment) => sum + fragment.rows, 0),
    9,
  );
});

test("a quoted marker with an arbitrary prefix is ordinary terminal text", () => {
  assert.equal(richFragments(["Example: " + marker(1)], [block]).size, 0);
});
