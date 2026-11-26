import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { Terminal } = createRequire(import.meta.url)(
  "@xterm/xterm",
) as typeof import("@xterm/xterm");
import { visibleClaudeClock, watchClaudeClock } from "./claude-clock-recovery";
import { writeTerminal } from "./terminalReplay";

test("an unchanged Claude timer requests only a read-only replay and repairs only a verified mismatch", async (t) => {
  const term = new Terminal({ cols: 70, rows: 10, allowProposedApi: true });
  const clock = "· Grooving… (2m 1s · ↓ 3.0k tokens)";
  await writeTerminal(term, clock);
  assert.equal(visibleClaudeClock(term)?.working, true);
  const requests: unknown[] = [],
    replies = [clock, "✻ Baked for 3m 9s · done 2:55 PM"];
  let recovered = 0,
    now = 0,
    tick = () => {};
  t.mock.method(performance, "now", () => now);
  t.mock.method(globalThis, "setInterval", (f: () => void) => {
    tick = f;
    return 1;
  });
  const globals = Object.getOwnPropertyDescriptors(globalThis);
  class Probe {
    onopen?: () => void;
    onclose?: () => void;
    onmessage?: (e: { data: string }) => void;
    constructor() {
      queueMicrotask(() => this.onopen?.());
    }
    send(value: string) {
      requests.push(JSON.parse(value));
      this.onmessage?.({
        data: JSON.stringify({
          type: "terminal-data",
          id: "fixture",
          data: replies.shift(),
          replay: { cols: 70, rows: 10, resizes: [] },
        }),
      });
    }
    close() {
      this.onclose?.();
    }
  }
  Object.defineProperty(globalThis, "document", {
    value: { hidden: false },
    configurable: true,
  });
  Object.defineProperty(globalThis, "WebSocket", {
    value: Probe,
    configurable: true,
  });
  const stop = watchClaudeClock(
    term,
    "fixture",
    () => true,
    () => "unused",
    () => new Terminal({ allowProposedApi: true }),
    () => recovered++,
  );
  try {
    tick();
    now = 13000;
    tick();
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(recovered, 0);
    now += 31000;
    tick();
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(recovered, 1);
    now += 31000;
    tick();
    assert.deepEqual(
      requests,
      [1, 2].map(() => ({
        type: "subscribe",
        sessions: [],
        terminals: ["fixture"],
        state: false,
      })),
    );
  } finally {
    stop();
    term.dispose();
    for (const key of ["WebSocket", "document"]) {
      if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
