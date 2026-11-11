import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { RpcClient, RpcResponseSizeError } from "./rpc.js";

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

test("RPC size limit applies to individual frames, and oversize closes only the owned reader", () => {
  const client = new RpcClient();
  client.alive = true;
  let notifications = 0;
  let failure: Error | undefined;
  client.on("notification", () => notifications++);
  client.on("closed", (error) => {
    failure = error;
  });
  const frame =
    JSON.stringify({
      method: "fixture",
      params: "x".repeat(17 * 1024 * 1024),
    }) + "\n";
  client.consume(frame + frame);
  assert.equal(
    notifications,
    2,
    "a batch larger than 32 MiB can contain valid independent frames",
  );
  assert.equal(client.alive, true);
  const prefix = '{"method":"fixture","params":"';
  client.consume(prefix + "x".repeat(20 * 1024 * 1024));
  client.consume("x".repeat(13 * 1024 * 1024));
  assert.ok(failure instanceof RpcResponseSizeError);
  assert.equal(client.alive, false);
  client.consume('"}\n' + frame);
  assert.equal(
    notifications,
    2,
    "late transport output is ignored after closure",
  );
});
