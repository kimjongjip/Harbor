import test from "node:test";
import assert from "node:assert/strict";
import {
  readManagedTabDraft,
  writeManagedTabDraft,
} from "./ide/managed-tab-drafts";

test("all open tab drafts survive the thirteenth edit, independently per window and host", () => {
  const rows = new Map<string, string>();
  const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => rows.get(k) ?? null,
      setItem: (k: string, v: string) => rows.set(k, v),
      removeItem: (k: string) => rows.delete(k),
    },
  });
  try {
    for (let i = 0; i < 100; i++)
      writeManagedTabDraft("windowA/compiler", "tab" + i, "prompt" + i);
    assert.equal(readManagedTabDraft("windowA/compiler", "tab0"), "prompt0");
    assert.equal(readManagedTabDraft("windowA/compiler", "tab99"), "prompt99");
    assert.equal(readManagedTabDraft("windowB/compiler", "tab0"), undefined);
    assert.equal(readManagedTabDraft("windowA/local", "tab0"), undefined);
    writeManagedTabDraft("windowA/compiler", "tab40", "");
    assert.equal(readManagedTabDraft("windowA/compiler", "tab40"), undefined);
    assert.equal(rows.size, 99);
  } finally {
    if (saved) Object.defineProperty(globalThis, "localStorage", saved);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
