import test from "node:test";
import assert from "node:assert/strict";
import webpush from "web-push";
import { setTimeout as delay } from "node:timers/promises";
import { mobileFixture } from "../test/mobile-fixture";
const subscription = (suffix = "fixture") => ({
  endpoint: `https://web.push.apple.com/${suffix}`,
  keys: { p256dh: "a".repeat(87), auth: "a".repeat(22) },
});
test("real completion pushes once without relying on working state; settings and test stay device scoped", async (t) => {
  const f = await mobileFixture();
  try {
    const a = await f.pair(),
      b = await f.pair(),
      sent: { endpoint: string; payload: any; options: any }[] = [];
    t.mock.method(
      webpush,
      "sendNotification",
      async (sub: any, payload: any, options: any) => {
        sent.push({
          endpoint: sub.endpoint,
          payload: JSON.parse(payload),
          options,
        });
        return { statusCode: 201, body: "", headers: {} };
      },
    );
    assert.equal(
      (
        await (
          await f.http("/mobile-api/push", undefined, { cookie: a })
        ).json()
      ).enabled,
      false,
    );
    await f.http("/mobile-api/push", subscription("a"), { cookie: a });
    await f.http("/mobile-api/push", subscription("b"), { cookie: b });
    f.gateway.completions.completed(f.id, "native-fixture", "fast-turn");
    f.gateway.completions.completed(f.id, "native-fixture", "fast-turn");
    await delay(10);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].payload.url, `/mobile/?terminal=${f.id}`);
    assert.equal(sent[0].payload.tag, sent[1].payload.tag);
    assert.match(sent[0].payload.tag, /^harbor-[a-f0-9]{32}$/);
    assert.doesNotMatch(
      JSON.stringify(sent),
      /native-fixture|fast-turn|검토 방향/,
    );
    assert.equal(sent[0].options.TTL, 3600);
    assert.equal(
      (
        await (
          await f.http("/mobile-api/push", undefined, { cookie: a })
        ).json()
      ).delivery.state,
      "sent",
    );
    f.state.terminals[0].agentState = "working";
    f.gateway.changed();
    await delay(120);
    f.state.terminals[0].agentState = "idle";
    f.gateway.changed();
    await delay(120);
    assert.equal(sent.length, 2, "idle alone is not completion");
    const result = await (
      await f.http("/mobile-api/push/test", {}, { cookie: a })
    ).json();
    assert.equal(result.sent, 1);
    assert.equal(sent.at(-1)?.endpoint, subscription("a").endpoint);
    await f.http("/mobile-api/push", null, { cookie: a });
    f.gateway.completions.completed(f.id, "native-fixture", "next-turn");
    await delay(10);
    assert.equal(sent.length, 4);
    assert.equal(sent.at(-1)?.endpoint, subscription("b").endpoint);
  } finally {
    await f.close();
  }
});
test("late expired push cannot delete a replacement subscription or resurrect a revoked device", async (t) => {
  const f = await mobileFixture();
  try {
    await f.pair();
    const id = f.access.view().devices[0].id;
    f.access.publicKey();
    f.access.setPush(id, subscription("old"));
    let fail!: () => void;
    t.mock.method(
      webpush,
      "sendNotification",
      () =>
        new Promise(
          (_resolve, reject) =>
            (fail = () =>
              reject(Object.assign(new Error("expired"), { statusCode: 410 }))),
        ),
    );
    const pending = f.access.notify("Harbor", "generic");
    f.access.setPush(id, subscription("new"));
    fail();
    await pending;
    assert.equal(
      f.access.config.devices[0].push?.endpoint,
      subscription("new").endpoint,
    );
    assert.equal(f.access.pushView(id).delivery, undefined);
    const revoked = f.access.notify("Harbor", "generic");
    f.access.revoke(id);
    fail();
    await revoked;
    assert.equal(f.access.view().devices.length, 0);
  } finally {
    await f.close();
  }
});
