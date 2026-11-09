import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { brotliDecompressSync } from "node:zlib";
import { WebSocket } from "ws";
import { mobileFixture, origin } from "../test/mobile-fixture";

test("mobile public code is compressed and cacheable; HTML and authenticated APIs remain no-store", async () => {
  const f = await mobileFixture();
  try {
    const html = await f.http("/mobile/");
    assert.equal(html.headers.get("cache-control"), "no-store");
    const paths = [
      ...(await html.text()).matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g),
    ].map((m) => m[1]);
    let totalRaw = 0;
    let totalTransferred = 0;
    for (const path of paths) {
      const raw = Buffer.from(await (await f.http(path)).arrayBuffer());
      const response = await f.http(path, undefined, {
        "accept-encoding": "br, gzip",
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      const compressed = raw.length >= 1024;
      assert.equal(
        response.headers.get("content-encoding"),
        compressed ? "br" : null,
      );
      assert.match(response.headers.get("cache-control")!, /immutable/);
      assert.match(response.headers.get("vary")!, /Accept-Encoding/);
      assert.deepEqual(compressed ? brotliDecompressSync(bytes) : bytes, raw);
      totalRaw += raw.length;
      totalTransferred += bytes.length;
      // Tiny shared icon/components have proportionally more format overhead.
      // Keep the strong ratio for large assets and measure the whole entrypoint.
      assert.ok(
        !compressed ||
          bytes.length < raw.length * (raw.length >= 16 * 1024 ? 0.55 : 1),
        `${path}: ${bytes.length}/${raw.length}`,
      );
      assert.equal(
        (
          await f.http(path, undefined, {
            "if-none-match": response.headers.get("etag")!,
          })
        ).status,
        304,
      );
    }
    assert.ok(totalRaw > 0);
    assert.ok(
      totalTransferred < totalRaw * 0.55,
      `initial assets: ${totalTransferred}/${totalRaw}`,
    );
    const cookie = await f.pair();
    const state = await f.http("/mobile-api/state", undefined, {
      cookie,
      "accept-encoding": "br, gzip",
    });
    assert.equal(state.headers.get("cache-control"), "no-store");
    assert.equal(state.headers.get("content-encoding"), null);
    assert.equal(
      (await f.http("/mobile/sw.js")).headers.get("cache-control"),
      "no-store",
    );
  } finally {
    await f.close();
  }
});
test(
  "compressed transport supersedes a slow subscription and tags only the newest snapshot/output",
  { timeout: 10000 },
  async () => {
    const f = await mobileFixture();
    try {
      const cookie = await f.pair(),
        oldId = randomUUID(),
        newId = randomUUID();
      let release!: () => void,
        count = 0;
      const real = f.operations.snapshot;
      f.operations.snapshot = async (id) => {
        const snap = await real(id);
        if (++count === 1) {
          await new Promise<void>((r) => (release = r));
          throw new Error("obsolete failure");
        }
        return snap;
      };
      const ws = new WebSocket(f.url.replace("http:", "ws:") + "/mobile-ws", {
        headers: { host: new URL(origin).host, origin, cookie },
      });
      const events: any[] = [];
      ws.on("message", (d) => events.push(JSON.parse(String(d))));
      await once(ws, "open");
      assert.match(ws.extensions, /permessage-deflate/);
      ws.send(
        JSON.stringify({ type: "subscribe", id: f.id, subscriptionId: oldId }),
      );
      while (!release) await new Promise((r) => setTimeout(r, 5));
      ws.send(
        JSON.stringify({ type: "subscribe", id: f.id, subscriptionId: newId }),
      );
      while (!events.some((e) => e.type === "snapshot"))
        await new Promise((r) => setTimeout(r, 5));
      release();
      f.gateway.output(f.id, "new output".repeat(1000));
      while (!events.some((e) => e.type === "data"))
        await new Promise((r) => setTimeout(r, 5));
      assert.ok(
        events
          .filter((e) => ["snapshot", "data"].includes(e.type))
          .every((e) => e.subscriptionId === newId),
      );
      assert.ok(!events.some((e) => e.type === "error"));
      assert.equal(f.writes.length, 0);
      ws.terminate();
    } finally {
      await f.close();
    }
  },
);
