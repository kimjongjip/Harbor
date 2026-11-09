import test from "node:test";
import assert from "node:assert/strict";
import { SocketWatchdog } from "./socket-watchdog";
import { restoreTerminalReplay, writeTerminal } from "./terminalReplay";

test("a socket that never opens or never supplies replay cannot wait forever", () => {
  let now = 0;
  const stalls: string[] = [];
  const open = new SocketWatchdog({
    now: () => now,
    onStall: (reason) => stalls.push(reason),
  });
  now = 12001;
  open.check();
  open.check();
  assert.deepEqual(stalls, ["open-timeout"]);
  const replay = new SocketWatchdog({
    now: () => now,
    expectsReplay: true,
    onStall: (reason) => stalls.push(reason),
  });
  replay.opened();
  now += 30001;
  replay.message();
  replay.check();
  assert.deepEqual(
    stalls,
    ["open-timeout", "replay-timeout"],
    "unrelated heartbeat messages cannot hide missing replay",
  );
});

test("ready but half-open connections recover while healthy idle and legacy connections remain open", () => {
  let now = 0;
  const stalls: string[] = [];
  const watch = new SocketWatchdog({
    now: () => now,
    expectsReplay: true,
    heartbeat: true,
    onStall: (reason) => stalls.push(reason),
  });
  const legacy = new SocketWatchdog({
    now: () => now,
    onStall: (reason) => stalls.push(reason),
  });
  try {
    watch.opened();
    watch.ready();
    legacy.opened();
    for (let i = 0; i < 12; i++) {
      now += 15000;
      watch.message();
      watch.check();
      legacy.check();
    }
    assert.deepEqual(stalls, []);
    now += 45001;
    watch.check();
    legacy.check();
    assert.deepEqual(stalls, ["heartbeat-timeout"]);
    legacy.dispose();
    now += 1e8;
    legacy.check();
    assert.deepEqual(stalls, ["heartbeat-timeout"]);
  } finally {
    watch.dispose();
    legacy.dispose();
  }
});

test("abandoning a view releases stalled xterm replay and ignores a late write callback", async () => {
  const abort = new AbortController();
  let callback: (() => void) | undefined;
  let resets = 0;
  const terminal = {
    write: (_data: string, done: () => void) => {
      callback = done;
    },
    reset: () => resets++,
    resize() {},
  };
  const replay = restoreTerminalReplay(
    terminal as any,
    "snapshot",
    undefined,
    () => !abort.signal.aborted,
    undefined,
    abort.signal,
  );
  abort.abort();
  await assert.rejects(replay, /view changed/);
  callback?.();
  assert.equal(resets, 0);
  await assert.rejects(
    writeTerminal(terminal as any, "new", abort.signal),
    /view changed/,
  );
});
