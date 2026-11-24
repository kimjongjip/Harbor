import test from "node:test";
import assert from "node:assert/strict";
import { AntigravitySettings } from "./antigravity-settings";

test("scoped native settings are offered once, require a registered idle adapter and verify its actual readback", async () => {
  const nativeId = "aaaaaaaa-bbbb-4ccc-8888-000000000001",
    id = "one";
  let state: "idle" | "busy" | undefined = "idle",
    allowed = true,
    wakes = 0;
  const channel = new AntigravitySettings(
    (t, n) => (t === id && n === nativeId ? state : undefined),
    () => {
      wakes++;
    },
  );
  const guard = async () => {
    if (!allowed) throw Error("fixture revoked");
  };
  await assert.rejects(() =>
    channel.configure(id, nativeId, { model: "gemini-test" }, guard),
  );
  await channel.receive(id, { op: "register", nativeId, model:"previous-model",effort:"high" });
  assert.deepEqual(channel.observed(id,nativeId),{model:"previous-model",effort:"high"});
  assert.equal(channel.observed(id,"unrelated"),undefined);
  const pending = channel.configure(
    id,
    nativeId,
    { model: "gemini-test", effort: "low" },
    guard,
  );
  await Promise.resolve();
  assert.equal(wakes, 1);
  assert.equal(channel.pending(id, nativeId), true);
  await assert.rejects(() =>
    channel.receive("another", { op: "claim", nativeId }),
  );
  const offer = await channel.receive(id, { op: "claim", nativeId });
  assert.ok(offer && "id" in offer && offer.id);
  assert.deepEqual(await channel.receive(id, { op: "claim", nativeId }), {});
  await channel.receive(id, {
    op: "ack",
    nativeId,
    id: offer.id,
    model: "gemini-test",
    effort: "low",
  });
  assert.deepEqual(await pending, { model: "gemini-test", effort: "low" });
  state = "busy";
  await assert.rejects(() =>
    channel.configure(id, nativeId, { effort: "high" }, guard),
  );
  state = "idle";
  const changed = channel.configure(id, nativeId, { effort: "low" }, guard);
  await Promise.resolve();
  const offer2 = await channel.receive(id, { op: "claim", nativeId });
  assert.ok("id" in offer2 && offer2.id);
  await channel.receive(id, {
    op: "ack",
    nativeId,
    id: offer2.id,
    model: "gemini-test",
    effort: "high",
  });
  await assert.rejects(changed, /다릅니다/);
  const revoked = channel.configure(id, nativeId, { effort: "low" }, guard);
  await Promise.resolve();
  allowed = false;
  assert.deepEqual(await channel.receive(id, { op: "claim", nativeId }), {});
  await assert.rejects(revoked, /fixture revoked/);
  allowed = true;
  const stopped = channel.configure(id, nativeId, { effort: "high" }, guard);
  await Promise.resolve();
  channel.revoke(id);
  await assert.rejects(stopped, /연결/);
  assert.equal(channel.registered(id, nativeId), false);
});
