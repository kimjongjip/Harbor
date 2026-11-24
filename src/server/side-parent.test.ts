import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { SideParentReaders } from "./side-parent";
import type { IdeChatConversation } from "../shared/ide-chat";

test("side reader sees new parent tool output on demand and cannot retarget or read after release", async (t) => {
  const readers = new SideParentReaders(),
    app = express();
  app.use("/bridge/side-parent", readers.router);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const parent = {
    status: "running",
    items: [{ kind: "command", text: "npm test", detail: "starting" }],
  } as IdeChatConversation;
  const access = readers.issue(
    (server.address() as AddressInfo).port,
    async () => parent,
  );
  const ask = (token: string) =>
    fetch(access.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + token,
      },
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "read_parent", arguments: { search: "test" } },
      }),
    });
  assert.equal((await ask("bad")).status, 403);
  assert.match(
    (await (await ask(access.token)).json()).result.content[0].text,
    /starting/,
  );
  parent.items[0].detail = "failed at assertion 7";
  assert.match(
    (await (await ask(access.token)).json()).result.content[0].text,
    /failed at assertion 7/,
  );
  access.release();
  assert.equal((await ask(access.token)).status, 403);
});
