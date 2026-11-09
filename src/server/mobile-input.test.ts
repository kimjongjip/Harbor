import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { mobileFixture } from "../test/mobile-fixture";

type Fixture = Awaited<ReturnType<typeof mobileFixture>>;
const windows = { skip: process.platform !== "win32" };
const pasted = "\x1b[200~한글 입력\n두 번째 줄\x1b[201~";

async function sender(f: Fixture, legacy = false) {
  const cookie = await f.pair();
  const deviceId = f.access.view().devices.at(-1)!.id;
  const clientId = randomUUID();
  const controlToken = legacy
    ? undefined
    : f.gateway.controls.change(f.id, deviceId, "test phone", {
        clientId,
        action: "claim",
      }).token;
  const input = {
    requestId: randomUUID(),
    runtimeId: f.state.runtimeId,
    terminalId: f.id,
    sessionId: "native-fixture",
    text: "한글 입력\n두 번째 줄",
    submit: true,
    ...(legacy ? {} : { clientId, controlToken }),
  };
  return { cookie, deviceId, clientId, input };
}

function firstWrite(f: Fixture, action?: () => void) {
  const write = f.operations.write;
  let resolve!: () => void;
  const written = new Promise<void>((done) => { resolve = done; });
  f.operations.write = (id, data) => {
    write(id, data);
    if (f.writes.length === 1) {
      action?.();
      resolve();
    }
  };
  return written;
}

test("Windows mobile paste waits for native processing; duplicate waits and never replays", windows, async () => {
  const f = await mobileFixture();
  try {
    const { cookie, input } = await sender(f);
    const written = firstWrite(f);
    let originalDone = false, duplicateDone = false;
    const original = f.http("/mobile-api/input", input, { cookie }).then((r) => {
      originalDone = true;
      return r;
    });
    await written;
    const duplicate = f.http("/mobile-api/input", input, { cookie }).then((r) => {
      duplicateDone = true;
      return r;
    });
    await delay(30);
    assert.deepEqual(f.writes, [pasted]);
    assert.equal(originalDone, false);
    assert.equal(duplicateDone, false, "duplicate must not acknowledge partial input");
    const conflict = await f.http("/mobile-api/input", {
      ...input, requestId: randomUUID(), text: "must not interleave",
    }, { cookie });
    assert.equal(conflict.status, 409);
    const responses = await Promise.all([original, duplicate]);
    assert.deepEqual(responses.map((r) => r.status), [200, 200]);
    assert.equal((await responses[1].json()).duplicate, true);
    assert.deepEqual(f.writes, [pasted, "\r"]);
  } finally { await f.close(); }
});

const changes: Array<[string, (f: Fixture, s: Awaited<ReturnType<typeof sender>>) => void]> = [
  ["revoked device", (f, s) => f.gateway.revoke(s.deviceId)],
  ["expired device", (f) => { f.access.config.devices[0].expiresAt = 1; }],
  ["runtime changed", (f) => { f.state.runtimeId = randomUUID(); }],
  ["native conversation changed", (f) => { f.state.terminals[0].agentSessionId = "replacement"; }],
  ["host changed", (f) => { f.state.terminals[0].hostId = "replacement"; }],
  ["terminal exited", (f) => { f.state.terminals[0].exited = true; }],
  ["lease released", (f, s) => { f.gateway.controls.change(f.id, s.deviceId, "test", { clientId: s.clientId, action: "release" }); }],
  ["lease taken by PC", (f) => { f.gateway.controls.change(f.id, "local", "PC", { clientId: "local", action: "claim", takeover: true }); }],
  ["same client reclaims lease with a new token", (f, s) => {
    f.gateway.controls.change(f.id, s.deviceId, "phone", { clientId: s.clientId, action: "release" });
    f.gateway.controls.change(f.id, s.deviceId, "phone", { clientId: s.clientId, action: "claim" });
  }],
];
for (const [name, mutate] of changes) {
  test(`Windows delayed submit stops when ${name}`, windows, async () => {
    const f = await mobileFixture();
    try {
      const s = await sender(f);
      firstWrite(f, () => mutate(f, s));
      const response = await f.http("/mobile-api/input", s.input, { cookie: s.cookie });
      assert.ok(response.status >= 400, await response.text());
      assert.deepEqual(f.writes, [pasted], "must leave pasted draft unsubmitted");
    } finally { await f.close(); }
  });
}

test("legacy mobile delayed submit cannot reclaim a released lease", windows, async () => {
  const f = await mobileFixture();
  try {
    const s = await sender(f, true);
    firstWrite(f, () => {
      f.gateway.controls.change(f.id, s.deviceId, "phone", { clientId: "legacy", action: "release" });
    });
    const response = await f.http("/mobile-api/input", s.input, { cookie: s.cookie });
    assert.equal(response.status, 409);
    assert.deepEqual(f.writes, [pasted]);
    assert.equal(f.gateway.controls.view(f.id), null);
  } finally { await f.close(); }
});

test("legacy mobile lease reclaimed by the same device does not authorize pending Enter", windows, async () => {
  const f = await mobileFixture();
  try {
    const s = await sender(f, true);
    firstWrite(f, () => {
      f.gateway.controls.change(f.id, s.deviceId, "phone", { clientId: "legacy", action: "release" });
      f.gateway.controls.change(f.id, s.deviceId, "phone", { clientId: "legacy", action: "claim" });
    });
    const response = await f.http("/mobile-api/input", s.input, { cookie: s.cookie });
    assert.equal(response.status, 409);
    assert.deepEqual(f.writes, [pasted]);
  } finally { await f.close(); }
});

test("gateway shutdown cancels pending Enter even if server starts again", windows, async () => {
  const f = await mobileFixture();
  try {
    const s = await sender(f, true);
    const written = firstWrite(f);
    const response = f.http("/mobile-api/input", s.input, { cookie: s.cookie }).catch(() => null);
    await written;
    await f.gateway.stop();
    await f.gateway.start();
    await delay(250);
    await response;
    assert.deepEqual(f.writes, [pasted]);
    const duplicate = await f.http("/mobile-api/input", s.input, { cookie: s.cookie });
    assert.equal(duplicate.status, 400);
    assert.deepEqual(f.writes, [pasted]);
  } finally { await f.close(); }
});

test("failed submit preserves uncertain receipt and duplicate does not send again", windows, async () => {
  const f = await mobileFixture();
  try {
    const { cookie, input } = await sender(f);
    let attempts = 0;
    const write = f.operations.write;
    f.operations.write = (id, data) => {
      attempts++;
      if (data === "\r") throw new Error("fixture submit failed");
      write(id, data);
    };
    const response = await f.http("/mobile-api/input", input, { cookie });
    assert.equal(response.status, 400);
    assert.equal((await f.http("/mobile-api/input", input, { cookie })).status, 400);
    assert.equal(attempts, 2);
    assert.deepEqual(f.writes, [pasted]);
  } finally { await f.close(); }
});

test("SSH sends once; input-only and special keys remain immediate", async () => {
  const f = await mobileFixture();
  try {
    const { cookie, input } = await sender(f);
    f.state.hosts[0].kind = "ssh";
    assert.equal((await f.http("/mobile-api/input", input, { cookie })).status, 200);
    assert.deepEqual(f.writes, [pasted + "\r"]);
    f.state.hosts[0].kind = "local";
    assert.equal((await f.http("/mobile-api/input", {
      ...input, requestId: randomUUID(), submit: false,
    }, { cookie })).status, 200);
    assert.equal((await f.http("/mobile-api/input", {
      ...input, requestId: randomUUID(), text: undefined, key: "Escape",
    }, { cookie })).status, 200);
    assert.deepEqual(f.writes, [pasted + "\r", pasted, "\x1b"]);
  } finally { await f.close(); }
});

test("Windows Claude also submits once after a separate paste", windows, async () => {
  const f = await mobileFixture();
  try {
    f.state.terminals[0].agentKind = "claude";
    const { cookie, input } = await sender(f);
    assert.equal((await f.http("/mobile-api/input", input, { cookie })).status, 200);
    assert.deepEqual(f.writes, [pasted, "\r"]);
  } finally { await f.close(); }
});
