const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { WorkspaceTabs } = require("./workspace-tabs.cjs");
test("moving, ordering, restoring and closing windows preserves one owner per terminal", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-window-test-"));
  t.after(() => {
    fs.unlinkSync(path.join(dir, "window-tabs.json"));
    fs.rmdirSync(dir);
  });
  let w = new WorkspaceTabs(dir);
  const [a, b, c, d] = Array.from({ length: 4 }, () => randomUUID());
  const secondary = w.add(),
    third = w.add();
  assert.deepEqual(w.snapshot(secondary).own, []);
  assert.equal(w.move(b, secondary, null, [a, b, c]), true);
  assert.equal(w.move(d, third, null, [a, b, c, d]), true);
  assert.equal(w.move(c, secondary, b, [a, b, c]), true);
  assert.equal(w.owner(d), third);
  w = new WorkspaceTabs(dir);
  assert.deepEqual(w.snapshot(secondary).own, [c, b]);
  assert.equal(w.move(a, secondary, b, [a, b, c, d]), true);
  assert.deepEqual(w.snapshot(secondary).own, [c, a, b]);
  assert.equal(w.move(randomUUID(), third, null, [a, b, c, d]), false);
  w.close(third);
  assert.equal(w.owner(d), "main");
  w.close("main");
  assert.equal(w.home, secondary);
  w = new WorkspaceTabs(dir);
  assert.deepEqual(w.snapshot(secondary).own, [c, a, b, d]);
  assert.equal(w.owner(randomUUID()), secondary);
});
