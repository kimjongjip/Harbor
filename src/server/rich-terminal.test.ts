import test from "node:test";
import assert from "node:assert/strict";
import { RichTerminals } from "./rich-terminal.js";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve, join, sep } from "node:path";
const input = {
  requestId: "answer-1",
  sessionId: "session-1",
  text: "한글과 $a^2+b^2=c^2$",
  columns: 80,
  viewportRows: 30,
  renderer: "rows-v2" as const,
};
test("legacy first-row reservations return native text without creating another blank placeholder", async () => {
  const store = new RichTerminals(20);
  const { renderer, ...legacy } = input;
  assert.deepEqual(await store.request("legacy", legacy), { enabled: false });
  assert.equal(store.list("legacy")[0].placement, "card");
  assert.equal(store.list("legacy")[0].text, legacy.text);
});
test("completed native blocks wait for layout and reuse a stable reservation", async () => {
  const store = new RichTerminals(100);
  store.once("block", (id, block) =>
    store.acknowledge(id, block.id, {
      sessionId: input.sessionId,
      columns: 80,
      available: true,
      rows: 12,
    }),
  );
  const reply = await store.request("t1", input);
  assert.equal(reply.enabled, true);
  assert.deepEqual(await store.request("t1", input), reply);
  assert.equal(store.list("t1")[0].text, input.text);
  if (reply.enabled) assert.equal(reply.rows, 12);
  store.dispose();
});

test("upgraded row reservations never reuse the legacy card layout of the same answer", async () => {
  const store = new RichTerminals(100);
  const { renderer, ...legacy } = input;
  await store.request("terminal", legacy);
  const old = store.list("terminal")[0];
  store.acknowledge("terminal", old.id, {
    sessionId: input.sessionId,
    columns: 80,
    rows: 50,
    available: true,
  });
  const pending = store.request("terminal", input);
  const modern = store
    .list("terminal")
    .find((block) => block.renderer === "rows-v2")!;
  assert.ok(modern);
  assert.notEqual(modern.id, old.id);
  assert.equal(modern.placement, undefined);
  store.acknowledge("terminal", modern.id, {
    sessionId: input.sessionId,
    columns: 80,
    rows: 12,
    available: true,
  });
  const reply = await pending;
  assert.equal(reply.enabled && reply.rows, 12);
  store.dispose();
});
test("no renderer leaves the native answer unchanged; session replacement resolves stale work", async () => {
  const store = new RichTerminals(20);
  assert.deepEqual(await store.request("t1", input), { enabled: false });
  const pending = store.request("t1", input);
  const next = store.request("t1", { ...input, sessionId: "session-2" });
  assert.deepEqual(await pending, { enabled: false });
  assert.equal(store.list("t1").length, 1);
  assert.equal(store.list("t1")[0].sessionId, "session-2");
  await next;
  store.dispose();
});

test("Codex cards retain canonical completed text without a native row reservation", () => {
  const store = new RichTerminals(20);
  const events: unknown[] = [];
  store.on("block", (...event) => events.push(event));
  store.publishCard("codex", input);
  store.publishCard("codex", input);
  assert.equal(events.length, 1);
  const block = store.list("codex")[0];
  assert.equal(block.placement, "card");
  assert.equal(block.text, input.text);
  store.publishCard("codex", { ...input, sessionId: "new-thread" });
  assert.equal(store.list("codex").length, 1);
  assert.equal(store.list("codex")[0].sessionId, "new-thread");
  store.dispose();
});

test("later image or document font changes cannot grow over native input rows", async () => {
  const store = new RichTerminals(100);
  const pending = store.request("terminal", input);
  const block = store.list("terminal")[0];
  store.acknowledge("terminal", block.id, {
    sessionId: input.sessionId,
    columns: 80,
    rows: 10,
    available: true,
  });
  await pending;
  store.acknowledge("terminal", block.id, {
    sessionId: input.sessionId,
    columns: 80,
    rows: 30,
    available: true,
  });
  assert.equal(store.list("terminal")[0].rows, 10);
  store.dispose();
});
test("layout cannot cross terminal, conversation, or viewport; changed contents receive new identity", async () => {
  const store = new RichTerminals(20);
  const pending = store.request("t1", input);
  const block = store.list("t1")[0];
  assert.throws(() =>
    store.acknowledge("other", block.id, {
      sessionId: "session-1",
      columns: 80,
      available: true,
      rows: 1,
    }),
  );
  assert.throws(() =>
    store.acknowledge("t1", block.id, {
      sessionId: "session-2",
      columns: 80,
      available: true,
      rows: 1,
    }),
  );
  assert.throws(() =>
    store.acknowledge("t1", block.id, {
      sessionId: "session-1",
      columns: 70,
      available: true,
      rows: 1,
    }),
  );
  const revised = store.request("t1", { ...input, text: "different" });
  assert.notEqual(store.list("t1")[0].id, block.id);
  await Promise.all([pending, revised]);
  store.dispose();
});
test("backend restart retains the source and marker of a still-running native reservation", async () => {
  const root = resolve(".cache/rich-restart-tests");
  mkdirSync(root, { recursive: true });
  const folder = mkdtempSync(join(root, "run-")),
    file = join(folder, "answers.json");
  try {
    const first = new RichTerminals(100, file);
    first.once("block", (id, block) =>
      first.acknowledge(id, block.id, {
        sessionId: input.sessionId,
        columns: 80,
        rows: 10,
        available: true,
      }),
    );
    const reservation = await first.request("terminal", input);
    first.dispose();
    const second = new RichTerminals(100, file);
    const loaded = second.list("terminal")[0];
    assert.equal(loaded.text, input.text);
    assert.equal(loaded.state, "pending");
    assert.equal(reservation.enabled && reservation.marker, loaded.marker);
    second.acknowledge("terminal", loaded.id, {
      sessionId: input.sessionId,
      columns: 80,
      rows: 10,
      available: true,
    });
    assert.deepEqual(await second.request("terminal", input), reservation);
    second.clear("terminal");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), []);
    second.dispose();
  } finally {
    assert.ok(resolve(folder).startsWith(root + sep));
    rmSync(folder, { recursive: true });
  }
});
