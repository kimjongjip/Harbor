import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { mobileFixture, origin } from "../test/mobile-fixture";
const tick = () => new Promise((r) => setTimeout(r, 5));
test(
  "speculative snapshots are authenticated, identity checked and never replace the active stream",
  { timeout: 10000 },
  async () => {
    const f = await mobileFixture();
    let ws: WebSocket | undefined;
    try {
      const cookie = await f.pair();
      const second = {
        ...f.state.terminals[0],
        id: randomUUID(),
        agentSessionId: "second",
      };
      f.state.terminals.push(second);
      const path = (
        id = second.id,
        sessionId = second.agentSessionId,
        runtimeId = f.state.runtimeId,
      ) =>
        `/mobile-api/terminals/${id}/preview?${new URLSearchParams({ sessionId, runtimeId })}`;
      assert.equal((await f.http(path())).status, 401);
      assert.equal(
        (await f.http(path(second.id, "obsolete"), undefined, { cookie }))
          .status,
        409,
      );
      assert.equal(
        (
          await f.http(path(second.id, "second", randomUUID()), undefined, {
            cookie,
          })
        ).status,
        409,
      );
      ws = new WebSocket(f.url.replace("http:", "ws:") + "/mobile-ws", {
        headers: { host: new URL(origin).host, origin, cookie },
      });
      const events: any[] = [];
      ws.on("message", (data) => events.push(JSON.parse(String(data))));
      await once(ws, "open");
      ws.send(
        JSON.stringify({
          type: "subscribe",
          id: f.id,
          subscriptionId: randomUUID(),
        }),
      );
      while (!events.some((e) => e.type === "snapshot")) await tick();
      const response = await f.http(path(), undefined, { cookie });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal((await response.json()).terminalId, second.id);
      f.gateway.output(f.id, "ORIGINAL STREAM");
      f.gateway.output(second.id, "MUST NOT SUBSCRIBE");
      while (!events.some((e) => e.type === "data")) await tick();
      assert.equal(events.filter((e) => e.type === "data").length, 1);
      assert.equal(
        events.find((e) => e.type === "data").data,
        "ORIGINAL STREAM",
      );
      assert.deepEqual(f.writes, []);
    } finally {
      ws?.terminate();
      await f.close();
    }
  },
);
test(
  "preview concurrency is bounded and late results recheck native identity and revocation",
  { timeout: 10000 },
  async () => {
    const f = await mobileFixture();
    let release: (() => void) | undefined;
    try {
      const cookie = await f.pair(),
        path = `/mobile-api/terminals/${f.id}/preview?${new URLSearchParams({ runtimeId: f.state.runtimeId, sessionId: "native-fixture" })}`;
      const original = f.operations.snapshot;
      f.operations.snapshot = async (id) => {
        await new Promise<void>((r) => (release = r));
        return original(id);
      };
      const pending = f.http(path, undefined, { cookie });
      while (!release) await tick();
      assert.equal((await f.http(path, undefined, { cookie })).status, 429);
      f.state.terminals[0].agentSessionId = "replacement";
      release();
      assert.equal((await pending).status, 409);
      f.state.terminals[0].agentSessionId = "native-fixture";
      release = undefined;
      const revoked = f.http(path, undefined, { cookie });
      while (!release) await tick();
      f.gateway.revoke(f.access.view().devices[0].id);
      (release as () => void)();
      assert.equal((await revoked).status, 401);
      assert.deepEqual(f.writes, []);
    } finally {
      if (release) release();
      await f.close();
    }
  },
);
