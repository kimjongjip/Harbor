import assert from "node:assert/strict";
import test from "node:test";
import { reconcileTerminalPanes, placeTerminalPane } from "./terminal-panes.js";

test("dropping tabs swaps visible panes and preserves partners when placing hidden history", () => {
  const previous = { ids: ["a", "b", "c"], focusedId: "a" };
  assert.deepEqual(placeTerminalPane(previous, "a", 2, 3).ids, ["c", "b", "a"]);
  assert.deepEqual(placeTerminalPane(previous, "history", 1, 3).ids, [
    "a",
    "history",
    "c",
  ]);
  assert.deepEqual(placeTerminalPane(previous, "d", 3, 4).ids, [
    "a",
    "b",
    "c",
    "d",
  ]);
  assert.deepEqual(previous.ids, ["a", "b", "c"]);
});

test("changing sessions replaces the focused split, preserving its current partner", () => {
  const available = ["remote-first", "remote-second", "local"];
  let panes = {
    ids: ["remote-first", "remote-second"],
    focusedId: "remote-first",
  };
  panes = reconcileTerminalPanes(panes, available, "local", 2);
  assert.deepEqual(panes.ids, ["local", "remote-second"]);
  panes = reconcileTerminalPanes(panes, available, "remote-second", 2);
  assert.deepEqual(panes.ids, ["local", "remote-second"]);
  panes = reconcileTerminalPanes(panes, available, "remote-first", 2);
  assert.deepEqual(panes.ids, ["local", "remote-first"]);
});
test("detaching, closing or resizing never duplicates slots or retains unavailable sessions", () => {
  const previous = { ids: ["a", "b", "c", "d"], focusedId: "d" };
  const small = reconcileTerminalPanes(previous, ["a", "b", "c", "d"], "d", 2);
  assert.deepEqual(small, { ids: ["a", "d"], focusedId: "d" });
  const detached = reconcileTerminalPanes(small, ["a", "b", "c"], "d", 2);
  assert.deepEqual(detached, { ids: ["a", "b"], focusedId: "a" });
  assert.deepEqual(reconcileTerminalPanes(detached, [], "d", 2), {
    ids: [],
    focusedId: "",
  });
});
