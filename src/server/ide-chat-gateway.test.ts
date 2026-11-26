import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { IdeChats } from "./ide-chat";
import { IdeLiveChats } from "./ide-chat-live";
import type { HostConfig } from "../shared/types";
import { mobileFixture } from "../test/mobile-fixture";

test("managed desktop chat uses paired authorization without touching terminal input", async () => {
  const f = await mobileFixture();
  const sent: string[] = [];
  let resolveCwd: () => Promise<string> = async () => "/fixture";
  const chats = new IdeChats({
    runtimeId: f.state.runtimeId,
    hub: {} as never,
    host: (id) => {
      assert.equal(id, "fixture");
      return { id, kind: "local", defaultCwd: "/fixture" } as HostConfig;
    },
    password: () => undefined,
    resolveCwd: () => resolveCwd(),
    historyList: async () => ({ data: [], nextCursor: null }),
    historyRead: async () => {
      throw new Error("No synthetic history");
    },
    nativeActive: () => false,
    claude: (turn) => {
      sent.push(turn.text);
      turn.events.native(turn.nativeId);
      turn.events.item({
        id: randomUUID(),
        kind: "assistant",
        text: "Synthetic reply",
      });
      return { done: Promise.resolve(), interrupt: async () => {}, close() {} };
    },
  });
  try {
    f.operations.ideChat = chats;
    await f.gateway.stop();
    await f.gateway.start();
    const phone = await f.pair();
    const invite = f.access.pairing("desktop");
    const code = new URLSearchParams(new URL(invite.url).hash.slice(1)).get(
      "pair",
    );
    const pairing = await f.http("/mobile-api/pair", {
      code,
      name: "Synthetic desktop",
    });
    const cookie = pairing.headers.get("set-cookie")!.split(";")[0];
    const endpoint = "/desktop-api/ide-chat/conversations";
    const create = () => ({
      hostId: "fixture",
      provider: "claude",
      requestId: randomUUID(),
    });
    assert.equal((await f.http(endpoint, create())).status, 401);
    assert.equal(
      (await f.http(endpoint, create(), { cookie: phone })).status,
      403,
    );
    assert.equal(
      (
        await f.http(endpoint, create(), {
          cookie,
          origin: "https://foreign.invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (await f.http(endpoint, create(), { cookie, "x-harbor-mobile": "" }))
        .status,
      403,
    );
    assert.equal(
      (await f.http(endpoint, { ...create(), hostId: "missing" }, { cookie }))
        .status,
      404,
    );
    const response = await f.http(endpoint, create(), { cookie });
    assert.equal(response.status, 200);
    const conversation = await response.json();
    const message = {
      runtimeId: f.state.runtimeId,
      requestId: randomUUID(),
      text: "Direct managed message",
    };
    const path = `${endpoint}/${conversation.id}/messages`;
    assert.equal((await f.http(path, message, { cookie })).status, 200);
    const retry = await f.http(path, message, { cookie });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).duplicate, true);
    assert.deepEqual(sent, [message.text]);
    assert.deepEqual(f.writes, []);
    assert.equal(f.gateway.controls.view(f.id), null);
    assert.equal(
      (
        await f.http(
          path,
          { ...message, requestId: randomUUID(), runtimeId: "stale" },
          { cookie },
        )
      ).status,
      409,
    );

    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    resolveCwd = () =>
      new Promise<string>((resolve) => {
        release = () => resolve("/fixture");
        entered();
      });
    const pending = f.http(endpoint, create(), { cookie });
    await started;
    const device = f.access.authenticate(cookie)!;
    f.gateway.revoke(device.id);
    release();
    assert.equal(
      (await pending).status,
      401,
      "revocation is rechecked after asynchronous preparation",
    );
    assert.deepEqual(sent, [message.text]);
  } finally {
    chats.close();
    await f.close();
  }
});

test("paired IDE attaches an open CLI for reading and queues only with the bound terminal control", async () => {
  const f = await mobileFixture();
  const queued: string[] = [];
  const host = {
    id: "fixture",
    kind: "local",
    defaultCwd: "/fixture",
  } as HostConfig;
  f.state.terminals[0].agentConnected = true;
  f.state.terminals[0].agentState = "working";
  const live = new IdeLiveChats({
    terminals: () => f.state.terminals,
    terminal: (id) => f.state.terminals.find((item) => item.id === id),
    readHistory: async (hostId, provider, nativeId) => ({
      thread: {
        id: nativeId,
        hostId,
        provider,
        title: "Open CLI",
        cwd: "/fixture",
        preview: "",
        updatedAt: 1,
        source: "cli",
        active: true,
      },
      items: [
        { id: "old-question", kind: "user", text: "Earlier user question" },
        { id: "old-answer", kind: "assistant", text: "Earlier native answer" },
      ],
      nextCursor: null,
    }),
    codex: {
      available: () => true,
      currentSession: () => f.state.terminals[0].agentSessionId,
      submitUser: async (_id, input, beforeEnqueue) => {
        await beforeEnqueue?.();
        queued.push(input.text);
        return "queued";
      },
    },
    claude: {
      available: () => false,
      send: async () => {
        throw new Error("Unexpected Claude channel call");
      },
    },
  });
  const chats = new IdeChats({
    runtimeId: f.state.runtimeId,
    hub: {} as never,
    host: () => host,
    password: () => undefined,
    resolveCwd: async () => {
      throw new Error("Live attach must not initialize another engine");
    },
    historyList: async () => ({ data: [], nextCursor: null }),
    historyRead: async () => {
      throw new Error("Managed reader must not resume live CLI");
    },
    nativeActive: () => true,
    live,
  });
  try {
    f.operations.ideChat = chats;
    await f.gateway.stop();
    await f.gateway.start();
    const invite = f.access.pairing("desktop");
    const code = new URLSearchParams(new URL(invite.url).hash.slice(1)).get(
      "pair",
    );
    const pairing = await f.http("/mobile-api/pair", {
      code,
      name: "Live desktop",
    });
    const cookie = pairing.headers.get("set-cookie")!.split(";")[0];
    const base = "/desktop-api/ide-chat/conversations";
    const attached = await f.http(
      base,
      {
        hostId: host.id,
        provider: "codex",
        resumeId: "native-fixture",
        requestId: randomUUID(),
      },
      { cookie },
    );
    assert.equal(attached.status, 200, await attached.clone().text());
    const conversation = await attached.json();
    assert.equal(conversation.live.terminalId, f.id);
    assert.equal(conversation.live.canSend, true);
    assert.ok(
      conversation.items.some(
        (item: { text: string }) => item.text === "Earlier native answer",
      ),
    );
    assert.equal(
      f.gateway.controls.view(f.id),
      null,
      "reading never takes terminal control",
    );
    const path = `${base}/${conversation.id}/messages`;
    const message = {
      runtimeId: f.state.runtimeId,
      requestId: randomUUID(),
      text: "Continue in the same CLI",
    };
    assert.equal((await f.http(path, message, { cookie })).status, 409);
    assert.deepEqual(queued, []);
    const clientId = randomUUID();
    const claim = await f.http(
      `/mobile-api/terminals/${f.id}/control`,
      {
        runtimeId: f.state.runtimeId,
        sessionId: "native-fixture",
        clientId,
        action: "claim",
      },
      { cookie },
    );
    const { token } = await claim.json();
    const headers = {
      cookie,
      "x-harbor-client": clientId,
      "x-harbor-control": token,
      "x-harbor-terminal": f.id,
    };
    const sent = await f.http(path, message, headers);
    assert.equal(sent.status, 200, await sent.clone().text());
    assert.equal((await sent.json()).status, "queued");
    assert.equal((await f.http(path, message, headers)).status, 200);
    assert.deepEqual(queued, [message.text]);
    assert.deepEqual(f.writes, []);
    f.state.terminals[0].agentSessionId = "replacement-native";
    const stale = await f.http(
      path,
      { ...message, requestId: randomUUID() },
      headers,
    );
    assert.equal(stale.status, 409);
    assert.deepEqual(queued, [message.text]);
  } finally {
    chats.close();
    await f.close();
  }
});
