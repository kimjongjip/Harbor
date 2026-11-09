import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import webpush from "web-push";
import { WebSocket } from "ws";
import { mobileFixture, origin } from "../test/mobile-fixture";
import { MobileAccess, mobileOrigin } from "./mobile-access";

test("mobile corrupt config fails closed and expired pairing cannot register", async (t) => {
  const f = await mobileFixture();
  try {
    const link = f.access.pairing(),
      code = new URLSearchParams(new URL(link.url).hash.slice(1)).get("pair")!;
    const now = Date.now();
    const clock = t.mock.method(Date, "now", () => now + 11 * 60000);
    assert.throws(() => f.access.pair(code, "expired"));
    clock.mock.restore();
    await writeFile(f.directory + "/mobile-access.json", "invalid");
    const loaded = new MobileAccess(f.directory);
    assert.equal(loaded.config.enabled, false);
    assert.ok(loaded.loadError);
    assert.equal(loaded.authenticate("harbor_mobile=x"), undefined);
  } finally {
    await f.close();
  }
});
test("mobile push uses explicit subscriptions, generic content and clears expired endpoints", async (t) => {
  const f = await mobileFixture();
  try {
    await f.pair();
    const device = f.access.view().devices[0];
    f.access.publicKey();
    const payloads: string[] = [];
    const sender = t.mock.method(
      webpush,
      "sendNotification",
      async (_sub: unknown, payload: unknown) => {
        payloads.push(String(payload));
        return { statusCode: 201, body: "", headers: {} };
      },
    );
    assert.deepEqual(await f.access.notify("Harbor", "generic"), {
      sent: 0,
      failed: 0,
    });
    f.access.setPush(device.id, {
      endpoint: "https://web.push.apple.com/fixture",
      keys: { p256dh: "a".repeat(87), auth: "a".repeat(22) },
    });
    assert.deepEqual(await f.access.notify("Harbor", "generic", f.id), {
      sent: 1,
      failed: 0,
    });
    assert.equal(JSON.parse(payloads[0]).url, `/mobile/?terminal=${f.id}`);
    sender.mock.mockImplementation(async () => {
      throw Object.assign(new Error("expired"), { statusCode: 410 });
    });
    assert.deepEqual(await f.access.notify("Harbor", "generic"), {
      sent: 0,
      failed: 1,
    });
    assert.equal(f.access.view().devices[0].notifications, false);
  } finally {
    await f.close();
  }
});

test("mobile pairing is one-time, hashed at rest, expiring, origin restricted and revocable", async () => {
  const f = await mobileFixture();
  try {
    assert.equal((await f.http("/mobile-api/state")).status, 401);
    assert.equal((await f.http("/api/bootstrap")).status, 404);
    assert.equal((await f.http("/bridge/mcp")).status, 404);
    assert.equal(
      (await f.http("/mobile-api/state", undefined, { host: "evil.example" }))
        .status,
      403,
    );
    assert.equal(
      (
        await f.http("/mobile-api/state", undefined, {
          "tailscale-funnel-request": "true",
        })
      ).status,
      403,
    );
    const link = f.access.pairing(),
      code = new URLSearchParams(new URL(link.url).hash.slice(1)).get("pair");
    assert.equal(
      (
        await f.http(
          "/mobile-api/pair",
          { code, name: "phone" },
          { origin: "https://evil.example" },
        )
      ).status,
      403,
    );
    const paired = await f.http("/mobile-api/pair", { code, name: "phone" });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
    assert.equal(
      (await f.http("/mobile-api/pair", { code, name: "second" })).status,
      400,
    );
    assert.equal(
      (await f.http("/mobile-api/state", undefined, { cookie })).status,
      200,
    );
    assert.equal(
      (await f.http("/mobile-api/push", null, { cookie, origin: "" })).status,
      403,
    );
    assert.equal(
      (await f.http("/mobile-api/push", null, { cookie })).status,
      200,
    );
    const disk = await readFile(f.directory + "/mobile-access.json", "utf8");
    assert.ok(!disk.includes(cookie.split("=")[1].split(";")[0]));
    assert.ok(!JSON.stringify(f.access.view()).includes("hash"));
    const reloaded = new MobileAccess(f.directory);
    assert.ok(reloaded.authenticate(cookie));
    f.access.config.devices[0].expiresAt = Date.now() - 1;
    assert.equal(f.access.authenticate(cookie), undefined);
    assert.throws(() => mobileOrigin("https://example.org"));
    assert.throws(() => mobileOrigin(origin + "/path"));
  } finally {
    await f.close();
  }
});
test("mobile input is bound to runtime and native conversation; duplicates and control injection do not replay", async () => {
  const f = await mobileFixture();
  try {
    const cookie = await f.pair(),
      input = {
        requestId: randomUUID(),
        runtimeId: f.state.runtimeId,
        terminalId: f.id,
        sessionId: "native-fixture",
        text: "hello\nworld",
        submit: true,
      };
    assert.equal(
      (await f.http("/mobile-api/input", input, { cookie })).status,
      200,
    );
    assert.equal(
      (await f.http("/mobile-api/input", input, { cookie })).status,
      200,
    );
    const writesPerSubmit = process.platform === "win32" ? 2 : 1;
    assert.equal(f.writes.length, writesPerSubmit);
    assert.equal(f.writes.join(""), "\x1b[200~hello\nworld\x1b[201~\r");
    for (const changed of [
      { text: "different" },
      { runtimeId: randomUUID() },
      { sessionId: "other" },
    ])
      assert.equal(
        (
          await f.http(
            "/mobile-api/input",
            { ...input, ...changed },
            { cookie },
          )
        ).status,
        400,
      );
    assert.equal(
      (
        await f.http(
          "/mobile-api/input",
          { ...input, requestId: randomUUID(), bracketed: false },
          { cookie },
        )
      ).status,
      400,
    );
    const escaped = {
      ...input,
      requestId: randomUUID(),
      text: "plain\x03\x1b[201~",
    };
    assert.equal(
      (await f.http("/mobile-api/input", escaped, { cookie })).status,
      200,
    );
    assert.ok(!f.writes[writesPerSubmit].includes("\x03"));
    f.operations.write = () => {
      throw new Error("write failed");
    };
    const uncertain = { ...input, requestId: randomUUID() };
    assert.equal(
      (await f.http("/mobile-api/input", uncertain, { cookie })).status,
      400,
    );
    assert.equal(
      (await f.http("/mobile-api/input", uncertain, { cookie })).status,
      400,
    );
    const invalidPush = {
      endpoint: "https://localhost/push",
      keys: { auth: "a".repeat(22), p256dh: "a".repeat(87) },
    };
    assert.equal(
      (await f.http("/mobile-api/push", invalidPush, { cookie })).status,
      400,
    );
  } finally {
    await f.close();
  }
});
test("snapshot precedes live output, phone cannot resize or write over websocket, revocation closes stream", async () => {
  const f = await mobileFixture();
  try {
    const cookie = await f.pair();
    let resolveSnapshot!: () => void;
    const real = f.operations.snapshot;
    f.operations.snapshot = async (id) => {
      const snapshot = await real(id);
      await new Promise<void>((r) => {
        resolveSnapshot = r;
      });
      return snapshot;
    };
    const ws = new WebSocket(f.url.replace("http:", "ws:") + "/mobile-ws", {
      headers: { host: new URL(origin).host, origin, cookie },
    });
    const events: any[] = [];
    ws.on("message", (data) => events.push(JSON.parse(String(data))));
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "subscribe", id: f.id }));
    while (!resolveSnapshot) await new Promise((r) => setTimeout(r, 5));
    f.gateway.output(f.id, "AFTER SNAPSHOT");
    resolveSnapshot();
    while (!events.some((e) => e.type === "data"))
      await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(
      events
        .filter((e) => ["snapshot", "data"].includes(e.type))
        .map((e) => e.type),
      ["snapshot", "data"],
    );
    ws.send(JSON.stringify({ type: "resize", id: f.id, cols: 20, rows: 8 }));
    while (!events.some((e) => e.type === "error"))
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(f.writes.length, 0);
    assert.equal((await f.screen.snapshot()).replay.cols, 100);
    const closed = once(ws, "close");
    f.gateway.revoke(f.access.view().devices[0].id);
    assert.equal((await closed)[0], 4001);
    assert.equal(
      (await f.http("/mobile-api/state", undefined, { cookie })).status,
      401,
    );
  } finally {
    await f.close();
  }
});
