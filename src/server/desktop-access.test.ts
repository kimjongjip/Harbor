import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { desktopWorkbenchFixture } from "../test/desktop-workbench-fixture";
import { origin } from "../test/mobile-fixture";

test("full workbench requires a paired PC, keeps the host token private and rejects cross-origin writes", async () => {
  const f = await desktopWorkbenchFixture();
  try {
    const phone = await f.pair("mobile"),
      pc = await f.pair();
    assert.equal((await f.http("/api/bootstrap")).status, 401);
    assert.equal(
      (
        await f.http("/api/bootstrap", undefined, {
          "x-harbor-token": "desktop",
          "x-harbor-device": pc.id,
        })
      ).status,
      401,
    );
    assert.equal(
      (await f.http("/api/bootstrap", undefined, { cookie: phone.cookie }))
        .status,
      403,
    );
    const response = await f.http("/api/bootstrap", undefined, {
      cookie: pc.cookie,
    });
    assert.equal(response.status, 200);
    const bootstrap = await response.json();
    assert.equal(bootstrap.token, "desktop");
    assert.equal(bootstrap.workspace.activeId, f.second.id);
    assert.equal(bootstrap.state.hosts[0].name, "Shared server");
    assert.equal(response.headers.get("cache-control"), "no-store");
    for (const path of [
      "/api/mobile",
      "/api/Mobile",
      "/api/mobile/pair",
      "/api/diagnostics/view-connection",
    ])
      assert.equal(
        (
          await f.http(
            path,
            {},
            { cookie: pc.cookie, "x-harbor-token": "desktop" },
          )
        ).status,
        403,
      );
    assert.equal(
      (await f.http("/api/terminals", {}, { cookie: pc.cookie })).status,
      403,
    );
    assert.equal(
      (
        await f.http(
          "/api/terminals",
          {},
          {
            cookie: pc.cookie,
            "x-harbor-token": "desktop",
            origin: "https://outside.invalid",
          },
        )
      ).status,
      403,
    );
    const mobile = await f.http("/mobile-api/state", undefined, {
      cookie: phone.cookie,
    });
    assert.equal(mobile.status, 200);
    assert.equal((await mobile.json()).viewer.kind, "mobile");
  } finally {
    await f.close();
  }
});

test("PC terminal input and IDE writes require the device's current lease; revoke closes sockets and pending reads", async () => {
  const f = await desktopWorkbenchFixture();
  let ws: WebSocket | undefined;
  try {
    const a = await f.pair(),
      b = await f.pair(),
      clientId = randomUUID();
    const headers = { cookie: a.cookie, "x-harbor-token": "desktop" };
    const claim = await (
      await f.http(
        `/api/terminals/${f.id}/control`,
        { action: "claim", clientId },
        headers,
      )
    ).json();
    ws = new WebSocket(f.url.replace("http:", "ws:") + "/ws?token=desktop", {
      headers: { cookie: a.cookie, host: new URL(origin).host, origin },
    });
    await once(ws, "open");
    const send = async (value: unknown) => {
      const event = once(ws!, "message");
      ws!.send(JSON.stringify(value));
      return JSON.parse(String((await event)[0]));
    };
    await send({ type: "subscribe", terminals: [f.id] });
    assert.equal(
      (
        await send({
          type: "terminal-input",
          id: f.id,
          data: "forbidden",
          clientId,
        })
      ).type,
      "error",
    );
    const accepted = await send({
      type: "terminal-input",
      id: f.id,
      data: "accepted",
      clientId,
      controlToken: claim.token,
    });
    assert.equal(accepted.type, "terminal-data");
    assert.deepEqual(f.inputs, ["accepted"]);
    const file = await (
      await f.http(
        `/api/editor/${f.id}/file?path=${encodeURIComponent(f.directory + "/note.md")}`,
        undefined,
        headers,
      )
    ).json();
    const body = {
      path: file.path,
      content: "# Written remotely\n",
      expectedVersion: file.version,
      binding: file.binding,
      encoding: file.encoding,
    };
    const writeHeaders = {
      ...headers,
      "X-Harbor-Client": clientId,
      "X-Harbor-Leases": JSON.stringify({ [f.id]: claim.token }),
    };
    assert.notEqual(
      (await f.http(`/api/editor/${f.id}/file`, body, headers, "PUT")).status,
      200,
    );
    assert.equal(
      (await f.http(`/api/editor/${f.id}/file`, body, writeHeaders, "PUT"))
        .status,
      200,
    );
    await f.http(
      `/api/terminals/${f.id}/control`,
      { action: "claim", clientId: randomUUID(), takeover: true },
      { cookie: b.cookie, "x-harbor-token": "desktop" },
    );
    assert.equal(
      (
        await send({
          type: "terminal-input",
          id: f.id,
          data: "stale",
          clientId,
          controlToken: claim.token,
        })
      ).type,
      "error",
    );
    assert.deepEqual(f.inputs, ["accepted"]);
    assert.throws(() => f.gateway.controls.local(f.id));
    const pending = f.http("/api/deferred", undefined, headers);
    while (!f.deferred()) await new Promise((r) => setTimeout(r, 5));
    const closed = once(ws, "close");
    f.gateway.revoke(a.id);
    f.deferred()!();
    const result = await pending;
    assert.equal(result.status, 401);
    assert.ok(!(await result.text()).includes("pending document"));
    assert.equal((await closed)[0], 4001);
    assert.equal(
      (await f.http("/api/bootstrap", undefined, headers)).status,
      401,
    );
  } finally {
    ws?.terminate();
    await f.close();
  }
});
