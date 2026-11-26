const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

// Exercise the capture listeners independently of a mounted React tab.
function fixture() {
  const listeners = new Map(),
    calls = [];
  let bridge, arm;
  class Element {
    closest() {
      return { dataset: { terminalTab: "fixture" } };
    }
  }
  const ipcRenderer = {
    invoke(name, ...args) {
      calls.push([name, ...args]);
      if (name === "harbor:tab-drag-start")
        return new Promise((resolve) => {
          arm = resolve;
        });
      return Promise.resolve(true);
    },
    send: (...args) => calls.push(args),
  };
  vm.runInNewContext(
    fs.readFileSync(require.resolve("./preload.cjs"), "utf8"),
    {
      require: () => ({
        ipcRenderer,
        contextBridge: {
          exposeInMainWorld: (_, v) => {
            bridge = v;
          },
        },
      }),
      document: { addEventListener: (name, fn) => listeners.set(name, fn) },
      Element,
      process: { platform: "win32" },
    },
  );
  return {
    bridge,
    calls,
    arm: () => arm("test-token"),
    event: (name, args = {}) =>
      listeners.get(name)({ target: new Element(), isTrusted: true, ...args }),
  };
}
test("a desktop move with no renderer drop target finishes once, even if native arming finishes after dragend", async () => {
  const f = fixture();
  f.event("dragstart");
  const token = f.bridge.startTabDrag("fixture");
  f.event("dragend", {
    screenX: 0,
    screenY: 0,
    buttons: 0,
    dataTransfer: { dropEffect: "move" },
  });
  f.arm();
  await new Promise(setImmediate);
  assert.equal(f.calls.filter((c) => c[0] === "harbor:tab-drag-end").length, 1);
  assert.equal(await f.bridge.endTabDrag(await token), true);
  assert.equal(f.calls.length, 2);
});
test("Escape before arming cancels the token; synthetic drag events cannot start a transfer", async () => {
  const f = fixture();
  f.event("dragstart", { isTrusted: false });
  assert.equal(await f.bridge.startTabDrag("fixture"), null);
  f.event("dragstart");
  f.event("keydown", { key: "Escape" });
  f.event("dragend", { buttons: 1, screenX: 0, screenY: 0 });
  f.arm();
  await new Promise(setImmediate);
  assert.deepEqual(
    f.calls.map((c) => c[0]),
    ["harbor:tab-drag-start", "harbor:tab-drag-cancel", "harbor:tab-drag-end"],
  );
  assert.equal(f.calls[2][2].cancelled, true);
});
