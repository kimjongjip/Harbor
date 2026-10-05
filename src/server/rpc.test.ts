import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { RpcClient } from "./rpc.js";

test("JSONL RPC handles split frames, Korean text, out-of-order responses, requests and child exit", async (t) => {
  const client = new RpcClient();
  t.after(() => client.stop());
  const initialized = await client.start(process.execPath, [
    fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url)),
  ]);
  assert.equal(initialized.userAgent, "fixture");
  const [slow, fast] = await Promise.all([
    client.call("echo", { text: "slow", delay: 25 }),
    client.call("echo", { text: "빠른 응답", delay: 1 }),
  ]);
  assert.equal(slow, "slow");
  assert.equal(fast, "빠른 응답");
  const notifications: any[] = [],
    requests: any[] = [];
  client.on("notification", (m) => notifications.push(m));
  client.on("request", (m) => requests.push(m));
  await client.call("events");
  assert.equal(notifications[0].params.delta, "한글");
  assert.equal(requests[0].id, "approval");
  await assert.rejects(client.call("fail"), /expected failure/);
  await assert.rejects(client.call("never-reply", {}, 20), /응답 시간이 초과/);
  const pending = client.call("never-reply");
  const exit = client.call("exit");
  const outcomes = await Promise.allSettled([pending, exit]);
  assert.ok(outcomes.every((o) => o.status === "rejected"));
  assert.equal(client.alive, false);
});
