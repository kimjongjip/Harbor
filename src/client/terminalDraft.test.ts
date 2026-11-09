import { test } from "node:test";
import assert from "node:assert/strict";
import { insertTerminalDraft, registerTerminalDraft } from "./terminalDraft";

test("a draft targets only the mounted terminal, without submitting or falling through to another editor", () => {
  const received: string[] = [];
  const remove = registerTerminalDraft("draft-target", (draft) =>
    received.push(draft.text),
  );
  try {
    assert.throws(
      () =>
        insertTerminalDraft({
          terminalId: "missing",
          sessionId: "native",
          text: "Plan request",
        }),
      /입력칸/,
    );
    insertTerminalDraft({
      terminalId: "draft-target",
      sessionId: "native",
      text: "Plan request",
    });
    assert.deepEqual(received, ["Plan request"]);
    for (const text of ["submit\r", "submit\n", "\x1b[2J", "x".repeat(4001)])
      assert.throws(
        () =>
          insertTerminalDraft({
            terminalId: "draft-target",
            sessionId: "native",
            text,
          }),
        /올바르지/,
      );
    assert.equal(received.length, 1);
  } finally {
    remove();
  }
  assert.throws(
    () =>
      insertTerminalDraft({
        terminalId: "draft-target",
        sessionId: "native",
        text: "Plan request",
      }),
    /입력칸/,
  );
});

test("a closing old view cannot unregister the replacement terminal's editor", () => {
  let received = 0;
  const old = registerTerminalDraft("replaced-view", () => {
    throw Error("Obsolete view used");
  });
  const current = registerTerminalDraft("replaced-view", () => received++);
  old();
  try {
    insertTerminalDraft({
      terminalId: "replaced-view",
      sessionId: "native",
      text: "Plan request",
    });
    assert.equal(received, 1);
  } finally {
    current();
  }
});
