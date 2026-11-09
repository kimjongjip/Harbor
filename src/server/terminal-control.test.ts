import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { TerminalControl } from "./terminal-control";
import { mobileFixture, origin } from "../test/mobile-fixture";
import { Files } from "./files";
import { EditorFiles, localEditorTransport } from "./editor-files";
import type { HostConfig } from "../shared/types";

test("control expires, transfers explicitly, invalidates on native identity change and never publishes tokens", () => {
  let clock = 100,
    binding = "runtime/session";
  const c = new TerminalControl(
    () => binding,
    () => {},
    () => clock,
  );
  const first = c.change("terminal", "device1", "PC A", {
    clientId: "tab1",
    action: "claim",
  });
  assert.ok(first.token);
  assert.equal(JSON.stringify(c.views()).includes(first.token!), false);
  assert.throws(() => c.local("terminal"));
  assert.throws(() =>
    c.change("terminal", "device2", "PC B", {
      clientId: "tab2",
      action: "claim",
    }),
  );
  const second = c.change("terminal", "device2", "PC B", {
    clientId: "tab2",
    action: "claim",
    takeover: true,
  });
  assert.throws(() => c.assert("terminal", "device1", "tab1", first.token));
  c.assert("terminal", "device2", "tab2", second.token);
  c.change("terminal", "device1", "PC A", {
    clientId: "tab1",
    action: "release",
  });
  assert.equal(c.view("terminal")?.clientId, "tab2");
  binding = "runtime/new-session";
  assert.equal(c.view("terminal"), null);
  assert.throws(() => c.assert("terminal", "device2", "tab2", second.token));
  c.change("terminal", "device2", "PC B", {
    clientId: "tab2",
    action: "claim",
    takeover: true,
  });
  clock += 30_001;
  assert.equal(c.view("terminal"), null);
  c.local("terminal");
  c.change("terminal", "device2", "PC B", {
    clientId: "tab2",
    action: "claim",
    takeover: true,
  });
  c.revoke("device2");
  assert.equal(c.view("terminal"), null);
});

test("legacy input is opt-in and passive local sizing never claims or renews ownership", () => {
  let clock = 100;
  const c = new TerminalControl(
    () => "binding",
    () => {},
    () => clock,
  );
  assert.throws(() => c.assert("terminal", "desktop"));
  assert.equal(c.canResizeLocally("terminal"), true);
  assert.equal(c.view("terminal"), null);
  c.local("terminal");
  const expires = c.view("terminal")!.expiresAt;
  clock += 10000;
  assert.equal(c.canResizeLocally("terminal"), true);
  assert.equal(c.view("terminal")!.expiresAt, expires);
  assert.throws(() =>
    c.assert("terminal", "phone", undefined, undefined, true),
  );
  clock += 30000;
  c.assert("terminal", "phone", undefined, undefined, true);
  c.assert("terminal", "phone", undefined, undefined, true);
  assert.equal(c.view("terminal")?.clientId, "legacy");
  assert.throws(() =>
    c.assert("terminal", "other-phone", undefined, undefined, true),
  );
  assert.equal(c.canResizeLocally("terminal"), false);
  assert.throws(() => c.local("terminal"));
});

function pairDevice(
  f: Awaited<ReturnType<typeof mobileFixture>>,
  kind: "mobile" | "desktop",
) {
  const invite = f.access.pairing(kind);
  const code = new URLSearchParams(new URL(invite.url).hash.slice(1)).get(
    "pair",
  )!;
  const result = f.access.pair(code, kind);
  return { cookie: `harbor_mobile=${result.token}` };
}

test("paired desktop cannot use legacy input or write IDE files without its current control token", async () => {
  const f = await mobileFixture();
  const files = new Files(() => undefined);
  try {
    const root = path.join(f.directory, "project");
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "test.txt"), "initial");
    files.resolvePath = async (_host, filename, cwd) => {
      assert.equal(filename, "~");
      assert.equal(cwd, "~");
      return root;
    };
    f.state.terminals[0].cwd = root;
    const host = {
      id: "fixture",
      kind: "local",
      defaultCwd: root,
    } as HostConfig;
    let beforeCommit: (() => Promise<void>) | undefined;
    const io = localEditorTransport();
    f.operations.editor = new EditorFiles({
      files,
      host: () => host,
      terminal: (id) => f.state.terminals.find((t) => t.id === id),
      transport: async () => ({
        ...io,
        replace: (filename, bytes, mode, check) =>
          io.replace(filename, bytes, mode, async () => {
            await beforeCommit?.();
            await check();
          }),
      }),
    });
    await f.gateway.stop();
    await f.gateway.start();
    const desktop = pairDevice(f, "desktop"),
      phone = pairDevice(f, "mobile");
    const id = f.id,
      runtimeId = f.state.runtimeId,
      sessionId = f.state.terminals[0].agentSessionId;
    const route = `/desktop-api/editor/${id}/file`;
    assert.equal(
      (await f.http(`${route}?path=test.txt`, undefined, phone)).status,
      403,
    );
    const initialResponse = await f.http(
      `${route}?path=test.txt`,
      undefined,
      desktop,
    );
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json();
    const body = {
      path: initial.path,
      content: "new",
      expectedVersion: initial.version,
      binding: initial.binding,
    };
    assert.equal((await f.http(route, body, desktop, "PUT")).status, 403);
    assert.equal(
      (
        await f.http(
          "/mobile-api/input",
          {
            requestId: randomUUID(),
            runtimeId,
            sessionId,
            terminalId: id,
            text: "not allowed",
          },
          desktop,
        )
      ).status,
      409,
    );
    const clientId = randomUUID();
    const claimed = await (
      await f.http(
        `/mobile-api/terminals/${id}/control`,
        { action: "claim", clientId, runtimeId, sessionId },
        desktop,
      )
    ).json();
    const headers = {
      ...desktop,
      "X-Harbor-Client": clientId,
      "X-Harbor-Control": claimed.token,
    };
    let release!: () => void, entered!: () => void;
    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    beforeCommit = () => {
      entered();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const saving = f.http(route, body, headers, "PUT");
    await preparing;
    f.gateway.controls.change(id, "local", "Host", {
      clientId: "local",
      action: "claim",
      takeover: true,
    });
    release();
    const rejected = await saving;
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).code, "CONTROL_REQUIRED");
    assert.equal(await fs.readFile(initial.path, "utf8"), "initial");
    assert.deepEqual(await fs.readdir(root), ["test.txt"]);
  } finally {
    files.shutdown();
    await f.close();
  }
});

test("pending desktop editor reads cannot return file contents after device revocation", async () => {
  const f = await mobileFixture();
  const files = new Files(() => undefined);
  try {
    const root = path.join(f.directory, "project");
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "test.txt"), "private fixture content");
    files.resolvePath = async (_host, filename, cwd) => {
      assert.equal(filename, "~");
      assert.equal(cwd, "~");
      return root;
    };
    f.state.terminals[0].cwd = root;
    const host = {
      id: "fixture",
      kind: "local",
      defaultCwd: root,
    } as HostConfig;
    const io = localEditorTransport();
    let release!: () => void, entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.operations.editor = new EditorFiles({
      files,
      host: () => host,
      terminal: (id) => f.state.terminals.find((t) => t.id === id),
      transport: async () => ({
        ...io,
        read: async (name, limit) => {
          const bytes = await io.read(name, limit);
          entered();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return bytes;
        },
      }),
    });
    await f.gateway.stop();
    await f.gateway.start();
    const desktop = pairDevice(f, "desktop");
    const request = f.http(
      `/desktop-api/editor/${f.id}/file?path=test.txt`,
      undefined,
      desktop,
    );
    await reading;
    f.gateway.revoke(f.access.authenticate(desktop.cookie)!.id);
    release();
    const response = await request;
    assert.equal(response.status, 401);
    assert.equal(
      (await response.text()).includes("private fixture content"),
      false,
    );
  } finally {
    files.shutdown();
    await f.close();
  }
});

test("conversation reads recheck device access and native identity after asynchronous history work", async () => {
  const f = await mobileFixture();
  try {
    const headers = pairDevice(f, "mobile");
    let release!: () => void, entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.operations.conversation = async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        sessionId: "native-fixture",
        provider: "codex",
        items: [
          { id: "secret", kind: "assistant", text: "private fixture history" },
        ],
        nextCursor: null,
      };
    };
    const request = f.http(
      `/mobile-api/terminals/${f.id}/conversation?sessionId=native-fixture`,
      undefined,
      headers,
    );
    await reading;
    f.gateway.revoke(f.access.authenticate(headers.cookie)!.id);
    release();
    const response = await request;
    assert.equal(response.status, 401);
    assert.equal(
      (await response.text()).includes("private fixture history"),
      false,
    );
    const newHeaders = pairDevice(f, "mobile");
    f.state.terminals[0].exited = true;
    assert.equal(
      (
        await f.http(
          `/mobile-api/terminals/${f.id}/answers`,
          undefined,
          newHeaders,
        )
      ).status,
      404,
    );
  } finally {
    await f.close();
  }
});

test("WebSocket discards a pending snapshot when the native conversation changes", async () => {
  const f = await mobileFixture();
  let socket: WebSocket | undefined;
  try {
    const headers = pairDevice(f, "mobile");
    let release!: () => void, entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = f.operations.snapshot;
    f.operations.snapshot = async (id) => {
      const snapshot = await original(id);
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return snapshot;
    };
    socket = new WebSocket(f.url.replace("http:", "ws:") + "/mobile-ws", {
      headers: { host: new URL(origin).host, origin, ...headers },
    });
    const events: any[] = [];
    socket.on("message", (data) => events.push(JSON.parse(String(data))));
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "subscribe", id: f.id }));
    await reading;
    f.state.terminals[0].agentSessionId = "replacement-native";
    f.gateway.output(f.id, "must be discarded");
    release();
    for (let n = 0; n < 100 && !events.some((e) => e.type === "error"); n++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(events.some((e) => e.type === "error"));
    assert.equal(
      events.some((e) => e.type === "snapshot" || e.type === "data"),
      false,
    );
  } finally {
    socket?.terminate();
    await f.close();
  }
});

test("desktop annotations capture selection and comment without submitting terminal input", async () => {
  const f = await mobileFixture();
  try {
    const desktop = pairDevice(f, "desktop"),
      mobile = pairDevice(f, "mobile");
    const captured: unknown[] = [];
    f.operations.annotate = (id, text, comment) => {
      captured.push({ id, text, comment });
      return { reference: "[#1 annotation]" };
    };
    const clientId = randomUUID(),
      identity = {
        runtimeId: f.state.runtimeId,
        sessionId: f.state.terminals[0].agentSessionId,
        clientId,
      };
    const claim = await (
      await f.http(
        `/mobile-api/terminals/${f.id}/control`,
        { ...identity, action: "claim" },
        desktop,
      )
    ).json();
    const body = {
      ...identity,
      controlToken: claim.token,
      text: "src/test.ts:1-2\nconst value = 1;",
      comment: "이 값을 설명해줘",
    };
    const route = `/desktop-api/terminals/${f.id}/annotation`;
    assert.equal((await f.http(route, body, mobile)).status, 403);
    assert.deepEqual(await (await f.http(route, body, desktop)).json(), {
      reference: "[#1 annotation]",
    });
    assert.deepEqual(captured, [
      { id: f.id, text: body.text, comment: body.comment },
    ]);
    assert.deepEqual(f.writes, []);
    assert.equal(
      (await f.http(route, { ...body, text: "x".repeat(16001) }, desktop))
        .status,
      400,
    );
    f.state.terminals[0].agentSessionId = "changed";
    assert.equal((await f.http(route, body, desktop)).status, 409);
    assert.equal(captured.length, 1);
  } finally {
    await f.close();
  }
});

test("paired desktop reuses live process, separates device capabilities and enforces ownership on input/resize/approval", async () => {
  const f = await mobileFixture();
  try {
    async function pair(kind: "mobile" | "desktop") {
      const invite = f.access.pairing(kind);
      assert.ok(invite.url.includes(`/${kind}/`));
      const code = new URLSearchParams(new URL(invite.url).hash.slice(1)).get(
        "pair",
      );
      const r = await f.http("/mobile-api/pair", { code, name: kind });
      assert.equal(r.status, 200);
      return { cookie: r.headers.get("set-cookie")!.split(";")[0] };
    }
    const mobile = await pair("mobile"),
      desktop = await pair("desktop");
    const s = f.operations.state(),
      id = s.terminals[0].id,
      sessionId = s.terminals[0].agentSessionId,
      clientId = randomUUID();
    s.terminals.push({ ...s.terminals[0], id: randomUUID(), exited: true });
    s.labs.push({
      id: "private-lab",
      title: "private",
      goal: "private",
    } as any);
    const state = await (
      await f.http("/mobile-api/state", undefined, desktop)
    ).json();
    assert.equal(state.viewer.kind, "desktop");
    assert.equal(state.terminals.length, 1);
    assert.deepEqual(state.labs, []);
    const identity = { clientId, runtimeId: s.runtimeId, sessionId };
    assert.equal(
      (
        await f.http(
          `/desktop-api/terminals/${id}/resize`,
          { ...identity, controlToken: randomUUID(), cols: 90, rows: 30 },
          mobile,
        )
      ).status,
      403,
    );
    const claim = await (
      await f.http(
        `/mobile-api/terminals/${id}/control`,
        { ...identity, action: "claim" },
        desktop,
      )
    ).json();
    assert.ok(claim.token);
    const body = {
      ...identity,
      requestId: randomUUID(),
      terminalId: id,
      controlToken: claim.token,
      raw: "hello\r",
    };
    assert.equal(
      (await f.http("/mobile-api/input", body, desktop)).status,
      200,
    );
    assert.deepEqual(f.writes, ["hello\r"]);
    assert.equal(
      (await f.http("/mobile-api/input", body, desktop)).status,
      200,
    );
    assert.equal(f.writes.length, 1);
    assert.equal(
      (
        await f.http(
          "/mobile-api/input",
          {
            requestId: randomUUID(),
            runtimeId: s.runtimeId,
            terminalId: id,
            sessionId,
            text: "conflict",
          },
          mobile,
        )
      ).status,
      409,
    );
    const foreign = { ...identity, clientId: randomUUID() };
    assert.equal(
      (
        await f.http(
          `/mobile-api/terminals/${id}/control`,
          { ...foreign, action: "claim" },
          mobile,
        )
      ).status,
      409,
    );
    const transfer = await (
      await f.http(
        `/mobile-api/terminals/${id}/control`,
        { ...foreign, action: "claim", takeover: true },
        mobile,
      )
    ).json();
    assert.ok(transfer.token);
    assert.equal(
      (
        await f.http(
          "/mobile-api/input",
          { ...body, requestId: randomUUID() },
          desktop,
        )
      ).status,
      409,
    );
    const rid = s.requests[0].id;
    assert.equal(
      (
        await f.http(
          `/mobile-api/requests/${rid}/answer`,
          {
            text: "answer",
            clientId: foreign.clientId,
            controlToken: transfer.token,
          },
          mobile,
        )
      ).status,
      200,
    );
    s.terminals[0].agentSessionId = "new-native";
    assert.equal(
      (
        await f.http(
          `/mobile-api/terminals/${id}/control`,
          { ...foreign, action: "renew" },
          mobile,
        )
      ).status,
      409,
    );
  } finally {
    await f.close();
  }
});
