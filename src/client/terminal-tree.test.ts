import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeTree,
  paneIds,
  placeInTree,
  presetTree,
  reconcileTree,
  resizeTree,
  splitJunctions,
  treeRects,
} from "./terminal-tree.js";

test("one pane fills the workspace; hidden tabs never automatically occupy new panes", () => {
  const one = reconcileTree(
    { tree: null, focusedId: "" },
    ["a", "b", "c"],
    "a",
  );
  assert.deepEqual(paneIds(one.tree), ["a"]);
  assert.deepEqual(treeRects(one.tree, 1200, 800).panes.a, {
    x: 0,
    y: 0,
    width: 1200,
    height: 800,
  });
  const selected = reconcileTree(one, ["a", "b", "c"], "b");
  assert.deepEqual(paneIds(selected.tree), ["b"]);
  const replaced = placeInTree(selected, "c", "b", "center");
  assert.deepEqual(paneIds(replaced.tree), ["c"]);
});
test("outer bottom drop creates a wide third pane below two columns", () => {
  const two = placeInTree(presetTree(["a"], "a"), "b", "a", "right");
  const three = placeInTree(two, "c", "b", "bottom", "workspace");
  const r = treeRects(three.tree, 1200, 800).panes;
  assert.equal(r.a.y, r.b.y);
  assert.equal(r.a.width, r.b.width);
  assert.equal(r.c.width, 1200);
  assert.ok(r.c.y > r.a.y + r.a.height);
  const nested = placeInTree(three, "d", "b", "top", "pane");
  const n = treeRects(nested.tree, 1200, 800).panes;
  assert.equal(n.c.width, 1200);
  assert.equal(n.a.height, r.a.height);
  assert.equal(n.d.x, n.b.x);
  assert.ok(n.d.y < n.b.y);
});
test("moving or swapping visible sessions never duplicates them and closing collapses empty splits", () => {
  const start = presetTree(["a", "b", "c"], "a");
  const swap = placeInTree(start, "a", "b", "center");
  assert.deepEqual(paneIds(swap.tree), ["b", "a", "c"]);
  const moved = placeInTree(swap, "c", "b", "left");
  assert.deepEqual(paneIds(moved.tree), ["c", "b", "a"]);
  assert.equal(new Set(paneIds(moved.tree)).size, 3);
  const closed = reconcileTree(moved, ["a", "b", "hidden"], "b");
  assert.deepEqual(paneIds(closed.tree), ["b", "a"]);
  const single = reconcileTree(closed, ["a", "hidden"], "a");
  assert.deepEqual(treeRects(single.tree, 900, 700).panes.a, {
    x: 0,
    y: 0,
    width: 900,
    height: 700,
  });
});
test("junction resizes both axes, restores persisted geometry, and bounds narrow panes", () => {
  const start = presetTree(["a", "b", "c", "d"], "d");
  const geometry = treeRects(start.tree, 1200, 900);
  const junction = splitJunctions(geometry.dividers)[0];
  assert.equal(junction.ids.length, 3);
  const resized = {
    ...start,
    tree: resizeTree(
      start.tree,
      Object.fromEntries(junction.ids.map((id) => [id, 0.65])),
    ),
  };
  const restored = decodeTree(JSON.parse(JSON.stringify(resized)))!;
  assert.deepEqual(
    treeRects(restored.tree, 1200, 900),
    treeRects(resized.tree, 1200, 900),
  );
  const r = treeRects(restored.tree, 1200, 900).panes;
  assert.ok(r.a.width > r.b.width);
  assert.ok(r.a.height > r.c.height);
  assert.equal(r.a.width, r.c.width);
  for (const rect of Object.values(treeRects(restored.tree, 100, 80).panes)) {
    assert.ok(rect.width >= 0 && rect.height >= 0);
  }
});
test("malformed persisted trees collapse safely and workspace moves preserve other panes", () => {
  const tree = presetTree(["a", "b"], "a");
  assert.ok(tree.tree?.kind === "split");
  const malformed = decodeTree({
    ...tree,
    tree: { ...tree.tree, second: tree.tree.first },
  })!;
  assert.deepEqual(paneIds(malformed.tree), ["a"]);
  const moved = placeInTree(
    presetTree(["a", "b", "c"], "a"),
    "b",
    "a",
    "bottom",
    "workspace",
  );
  assert.deepEqual(paneIds(moved.tree), ["a", "c", "b"]);
  assert.equal(treeRects(moved.tree, 1000, 700).panes.b.width, 1000);
});
