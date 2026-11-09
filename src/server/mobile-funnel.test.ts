import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { WebSocket } from "ws";
import { mobileFixture, origin } from "../test/mobile-fixture";
import { MobileAccess } from "./mobile-access";

const publicHeaders = { "tailscale-funnel-request": "true" };
test(
  "Funnel requires explicit mode, registered devices and same-origin HTTP/WS; reverting closes public streams",
  { timeout: 15000 },
  async () => {
    const f = await mobileFixture();
    try {
      const cookie = await f.pair();
      assert.equal(
        (
          await f.http("/mobile-api/state", undefined, {
            ...publicHeaders,
            cookie,
          })
        ).status,
        403,
      );
      await f.gateway.configure(true, origin, f.access.config.port, "funnel");
      assert.equal(
        (await f.http("/mobile-api/state", undefined, publicHeaders)).status,
        401,
      );
      assert.equal(
        (
          await f.http("/mobile-api/state", undefined, {
            ...publicHeaders,
            cookie: "harbor_mobile=bad",
          })
        ).status,
        401,
      );
      const headers = { ...publicHeaders, cookie };
      assert.equal(
        (await f.http("/mobile-api/state", undefined, headers)).status,
        200,
      );
      for (const path of [
        "/api/bootstrap",
        "/api/mobile/network",
        "/bridge/mcp",
      ])
        assert.equal((await f.http(path, undefined, headers)).status, 404);
      assert.equal(
        (
          await f.http("/mobile-api/push", null, {
            ...headers,
            origin: "https://evil.example",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await f.http("/mobile-api/push", null, {
            ...headers,
            "x-harbor-mobile": "",
          })
        ).status,
        403,
      );
      const wsUrl = f.url.replace("http:", "ws:") + "/mobile-ws";
      for (const invalid of [
        { cookie: "harbor_mobile=bad" },
        { origin: "https://evil.example" },
      ]) {
        const rejected = new WebSocket(wsUrl, {
          headers: {
            host: new URL(origin).host,
            origin,
            ...headers,
            ...invalid,
          },
        });
        const [error] = await once(rejected, "error");
        assert.match(error.message, /socket hang up|ECONNRESET/);
        assert.notEqual(rejected.readyState, WebSocket.OPEN);
      }
      const ws = new WebSocket(wsUrl, {
        headers: { host: new URL(origin).host, origin, ...headers },
      });
      const events: any[] = [];
      ws.on("message", (data) => events.push(JSON.parse(String(data))));
      await once(ws, "open");
      ws.send(JSON.stringify({ type: "subscribe", id: f.id }));
      while (!events.some((e) => e.type === "snapshot"))
        await new Promise((r) => setTimeout(r, 5));
      f.gateway.output(f.id, "FUNNEL STREAM");
      while (!events.some((e) => e.type === "data"))
        await new Promise((r) => setTimeout(r, 5));
      assert.equal(f.writes.length, 0);
      const closed = once(ws, "close");
      await f.gateway.configure(true, origin, f.access.config.port, "private");
      await closed;
      assert.equal(
        (await f.http("/mobile-api/state", undefined, headers)).status,
        403,
      );
      assert.equal(
        (await f.http("/mobile-api/state", undefined, { cookie })).status,
        200,
      );
      await f.gateway.configure(true, origin, f.access.config.port, "funnel");
      f.gateway.revoke(f.access.view().devices[0].id);
      assert.equal(
        (await f.http("/mobile-api/state", undefined, headers)).status,
        401,
      );
    } finally {
      await f.close();
    }
  },
);
test("public pairing remains one-time, valid invite survives junk attempts, old configs stay private", async () => {
  const f = await mobileFixture();
  try {
    await f.gateway.configure(true, origin, f.access.config.port, "funnel");
    const invite = f.access.pairing(),
      code = new URLSearchParams(new URL(invite.url).hash.slice(1)).get("pair");
    for (let i = 0; i < 12; i++)
      assert.equal(
        (
          await f.http(
            "/mobile-api/pair",
            { code: "bad", name: "invalid" },
            publicHeaders,
          )
        ).status,
        400,
      );
    const pair = await f.http(
      "/mobile-api/pair",
      { code, name: "public phone" },
      publicHeaders,
    );
    assert.equal(pair.status, 200);
    assert.equal(
      (await f.http("/mobile-api/pair", { code, name: "again" }, publicHeaders))
        .status,
      400,
    );
    const cookie = pair.headers.get("set-cookie")!;
    const config = JSON.parse(
      await readFile(f.directory + "/mobile-access.json", "utf8"),
    );
    assert.equal(new MobileAccess(f.directory).config.mode, "funnel");
    delete config.mode;
    await writeFile(
      f.directory + "/mobile-access.json",
      JSON.stringify(config),
    );
    const legacy = new MobileAccess(f.directory);
    assert.equal(legacy.config.mode, "private");
    assert.ok(legacy.authenticate(cookie));
    await writeFile(
      f.directory + "/mobile-access.json",
      JSON.stringify({ ...config, mode: "unknown" }),
    );
    assert.equal(new MobileAccess(f.directory).config.enabled, false);
  } finally {
    await f.close();
  }
});
