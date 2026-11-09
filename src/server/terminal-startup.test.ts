import { test } from "node:test";
import assert from "node:assert/strict";
import { Terminals } from "./terminals.js";
import { TerminalScreen } from "./terminal-screen.js";
import type { TerminalInfo } from "../shared/types.js";

test("only untouched startup shells can be dismissed; typing and connected agents preserve terminals", () => {
  const terminals = new Terminals();
  const killed: string[] = [],
    written: string[] = [];
  const add = (id: string, extra: Partial<TerminalInfo> = {}) => {
    const info = {
      id,
      hostId: "fixture",
      cwd: "/home/fixture",
      title: id,
      program: "shell",
      exited: false,
      ...extra,
    };
    (terminals as any).entries.set(id, {
      info,
      buffer: new TerminalScreen(),
      process: {
        kill: () => killed.push(id),
        write: (data: string) => written.push(data),
        resize() {},
      },
    });
  };
  try {
    add("unused", { startupPlaceholder: true });
    assert.equal(terminals.dismissStartup("unused"), true);
    add("typed", { startupPlaceholder: true });
    terminals.write("typed", "x");
    assert.equal(terminals.dismissStartup("typed"), false);
    assert.deepEqual(written, ["x"]);
    add("existing");
    assert.equal(terminals.dismissStartup("existing"), false);
    add("agent", { startupPlaceholder: true, agentConnected: true });
    assert.equal(terminals.dismissStartup("agent"), false);
    assert.deepEqual(killed, ["unused"]);
    assert.equal(terminals.list().length, 3);
  } finally {
    terminals.shutdown();
  }
});

test("remote research cannot silently launch an unmanaged terminal when forwarding is disabled", async () => {
  const terminals = new Terminals();
  let closed = false,
    launched = false;
  terminals.configureBridge({
    port: 1,
    issue: () => ({ token: "fixture", path: "/fixture" }),
    revoke() {},
  });
  const connection = {
    forwardIn: (_address: string, _port: number, cb: Function) =>
      cb(new Error("Forwarding disabled")),
    exec: () => {
      launched = true;
    },
    end: () => {
      closed = true;
    },
  };
  await assert.rejects(
    (terminals as any).remote(
      { kind: "ssh", id: "fixture-ssh" },
      { id: "fixture-terminal", cwd: "~", program: "codex" },
      connection,
      undefined,
      undefined,
      { cwd: "/srv/project", effort: "low" },
    ),
    /TCP forwarding/,
  );
  assert.equal(launched, false);
  assert.equal(closed, true);
  assert.equal(terminals.list().length, 0);
});
