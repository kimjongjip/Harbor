import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import express from "express";
import { workspaceChatRouter } from "./workspace-chat.js";
import type { RemoteWorkspaces } from "./remote-workspaces.js";
import type { HostConfig } from "../shared/types.js";

test("older-worker usage verifies a signed conversation binding per actor, rejects stale or mismatched records", async (t) => {
  const id = randomUUID(),
    v = {
      id,
      nativeId: randomUUID(),
      runtimeId: randomUUID(),
      contentRevision: 3,
      cwd: "/fixture/project",
      hostId: "local",
      provider: "codex",
      items: ["private transcript"],
    };
  let firstStatus = 404,
    missing = true,
    confirmation = 200,
    invalidHost = false,
    access = true;
  let reads = 0;
  const revisions: Array<string | undefined> = [];
  const host = {
    id: "target",
    kind: "ssh",
    address: "example.invalid",
    username: "fixture",
    identityFile: "",
    port: 22,
  } as HostConfig;
  const api = {
    enabled: () => true,
    chat: async (
      _host: unknown,
      _pw: unknown,
      _actor: string,
      m: string,
      path: string,
      _b: unknown,
      _term: unknown,
      guard: () => void,
      opts?: { revision: string },
    ) => {
      guard();
      assert.equal(m, "GET");
      if (path.endsWith("/usage"))
        return {
          status: firstStatus,
          value: { error: "worker response" },
          unsupportedUsage: missing,
        };
      assert.equal(path, "/conversations/" + id);
      revisions.push(opts?.revision);
      if (confirmation !== 200)
        return { status: confirmation, value: { error: "binding expired" } };
      if (opts?.revision && !invalidHost)
        return { status: 200, value: { unchanged: true } };
      return {
        status: 200,
        value: { ...v, hostId: invalidHost ? "other" : "local" },
      };
    },
  } as unknown as RemoteWorkspaces;
  const app = express();
  app.use(
    "/:hostId",
    workspaceChatRouter(
      api,
      () => host,
      async () => undefined,
      (req) => {
        if (!access) throw Object.assign(Error("revoked"), { status: 403 });
        return { kind: "mobile", id: req.get("x-device") || "a" };
      },
      async (verified, binding) => {
        assert.equal(verified.id, host.id);
        assert.equal(binding.nativeId, v.nativeId);
        assert.equal("items" in binding, false);
        reads++;
        return { usage: null, work: null };
      },
    ),
  );
  app.use(
    (
      error: Error & { status?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => res.status(error.status || 500).json({ error: error.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const get = (device = "a") =>
    fetch(
      "http://127.0.0.1:" +
        (server.address() as AddressInfo).port +
        "/target/conversations/" +
        id +
        "/usage?nativeId=forged",
      { headers: { "x-device": device } },
    );
  assert.equal((await get()).status, 200);
  assert.equal((await get()).status, 200);
  assert.equal((await get("b")).status, 200);
  assert.deepEqual(revisions, [undefined, v.runtimeId + ":3", undefined]);
  access = false;
  assert.equal((await get()).status, 403);
  access = true;
  invalidHost = true;
  assert.equal((await get()).status, 409);
  invalidHost = false;
  confirmation = 404;
  assert.equal((await get()).status, 404);
  confirmation = 200;
  firstStatus = 403;
  missing = false;
  assert.equal((await get()).status, 403);
  firstStatus = 404;
  assert.equal((await get()).status, 404);
  assert.equal(reads, 3);
});
