import test from "node:test";
import assert from "node:assert/strict";
import {
  readManagedTabs,
  writeManagedTabs,
} from "./ide/managed-tab-storage.js";

test("managed tab restoration is scoped and stores only known metadata", () => {
  const values = new Map<string, string>();
  const initial = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => values.set(k, v),
      removeItem: (k: string) => values.delete(k),
    },
  });
  try {
    const codex = {
      key: "first",
      provider: "codex" as const,
      nativeId: "thread-a",
      draft: "private draft",
      cwd: "/private",
    };
    const claude = {
      key: "second",
      provider: "claude" as const,
      parentKey: "first",
      effort: "high" as const,
    };
    writeManagedTabs("window-a/compiler", {
      selected: "second",
      tabs: [codex, claude, codex],
    });
    assert.deepEqual(readManagedTabs("window-a/compiler"), {
      selected: "second",
      tabs: [{ key: "first", provider: "codex", nativeId: "thread-a" }, claude],
    });
    assert.equal(readManagedTabs("window-b/compiler"), undefined);
    assert.equal([...values.values()].join("").includes("private"), false);
    const [key] = values.keys();
    values.set(key, "{");
    assert.equal(readManagedTabs("window-a/compiler"), undefined);
    writeManagedTabs("window-a/compiler", {
      selected: "missing",
      tabs: [claude],
    });
    assert.equal(readManagedTabs("window-a/compiler")?.selected, "second");
    const opted={key:"draft",provider:"codex" as const,autoAccept:true as const};
    writeManagedTabs("window-a/compiler",{selected:"draft",tabs:[opted,{...opted,key:"bound",conversationId:"chat-1"},{...opted,key:"native",nativeId:"q1"},{...opted,key:"review",reviewOnly:true},{...opted,key:"ro",permission:"read-only"}]});
    assert.deepEqual(readManagedTabs("window-a/compiler")!.tabs.map(t=>t.autoAccept),[true,undefined,undefined,undefined,undefined]);
    assert.equal(readManagedTabs("window-b/compiler"),undefined);
    writeManagedTabs("window-a/compiler", { selected: "", tabs: [] });
    assert.equal(values.size, 0);
  } finally {
    if (initial) Object.defineProperty(globalThis, "localStorage", initial);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
