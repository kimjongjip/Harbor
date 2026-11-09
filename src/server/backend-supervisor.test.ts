import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
const { BackendSupervisor } = createRequire(import.meta.url)(
  "../../desktop/backend-supervisor.cjs",
);
class Child extends EventEmitter {
  pid = 1;
  exitCode: number | null = null;
  signalCode: string | null = null;
  crash() {
    this.exitCode = 1;
    this.emit("exit", 1, null);
  }
}
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(condition(), "supervisor reached expected state");
};

test("only a confirmed child exit recovers; duplicate events, live children and shutdown cannot respawn", async () => {
  let starts = 0;
  const events: any[] = [];
  const supervisor = new BackendSupervisor({
    delays: [1, 1, 1],
    start: async () => {
      starts++;
      supervisor.watch(new Child());
    },
    onStatus: () => {},
    onEvent: (...event: any[]) => events.push(event),
  });
  const first = new Child();
  supervisor.watch(first);
  supervisor.activate();
  supervisor.recover();
  assert.equal(starts, 0, "live processes must never be killed/replaced");
  first.crash();
  first.emit("exit", 1, null);
  await until(() => supervisor.status.phase === "ready" && starts === 1);
  assert.equal(events.filter((e) => e[0] === "backend-recovered").length, 1);
  first.emit("exit", 1, null);
  assert.equal(starts, 1, "old child exit cannot restart its replacement");
  supervisor.child.crash();
  supervisor.stop();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(starts, 1, "quit cancels scheduled recovery");
});

test("rapid repeated failures stop after three retries and manual retry can recover", async () => {
  let starts = 0,
    succeed = false;
  const supervisor = new BackendSupervisor({
    delays: [1, 1, 1],
    start: async () => {
      starts++;
      const child = new Child();
      supervisor.watch(child);
      if (!succeed) {
        child.crash();
        throw new Error("fixture crash");
      }
    },
    onStatus: () => {},
    onEvent: () => {},
  });
  const child = new Child();
  supervisor.watch(child);
  supervisor.activate();
  child.crash();
  await until(
    () =>
      starts === 3 && supervisor.status.phase === "failed" && !supervisor.busy,
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(starts, 3);
  succeed = true;
  supervisor.retry();
  await until(() => supervisor.status.phase === "ready");
  assert.equal(starts, 4);
  supervisor.stop();
});

test("unresponsive live child and external backend are never automatically replaced", async () => {
  let starts = 0;
  const supervisor = new BackendSupervisor({
    delays: [1, 1, 1],
    start: async () => {
      starts++;
      supervisor.watch(new Child());
      throw new Error("startup timed out but alive");
    },
    onStatus: () => {},
    onEvent: () => {},
  });
  supervisor.activate();
  assert.equal(starts, 0, "attached external service is not owned");
  const first = new Child();
  supervisor.watch(first);
  first.crash();
  await until(() => supervisor.status.phase === "failed");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(starts, 1);
  supervisor.stop();
});

test("an already healthy external replacement does not leave a stale failed status or become owned", async () => {
  const supervisor = new BackendSupervisor({
    delays: [1],
    start: async () => null,
    onStatus: () => {},
    onEvent: () => {},
  });
  const old = new Child();
  supervisor.watch(old);
  supervisor.activate();
  old.crash();
  await until(() => supervisor.status.phase === "ready");
  assert.equal(supervisor.child, undefined);
  supervisor.stop();
});
