import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import express from "express";
import type { Client } from "ssh2";
import type { HostConfig } from "../shared/types.js";
import { LoopbackPorts, loopbackPortRouter } from "./loopback-ports.js";

test("SSH forwarding opens only a PC loopback socket to remote loopback, authenticates the route and closes unused forwards", async (t) => {
  const host = {
    id: "fixture",
    kind: "ssh",
    address: "fixture.invalid",
    port: 22,
    username: "fixture",
  } as HostConfig;
  const target = createServer((_, res) => res.end("synthetic service")).listen(
    0,
    "127.0.0.1",
  );
  await once(target, "listening");
  t.after(() => target.close());
  const targetPort = (target.address() as AddressInfo).port;
  let sessions = 0;
  const ports = new LoopbackPorts(
    () => host,
    async () => {
      sessions++;
      const ssh = Object.assign(new EventEmitter(), {
        end() {},
        forwardOut(
          _from: string,
          _p: number,
          address: string,
          port: number,
          cb: Function,
        ) {
          assert.equal(address, "127.0.0.1");
          assert.equal(port, targetPort);
          const socket = connect(port, address, () => cb(null, socket));
          socket.once("error", error=>cb(error));
        },
      });
      return ssh as unknown as Client;
    },
    350,
  );
  t.after(() => ports.closeAll());
  const app = express();
  app.use(express.json());
  app.use(
    "/hosts/:hostId/ports",
    loopbackPortRouter(
      ports,
      (req) => req.get("X-Founder") === "fixture",
      async () => undefined,
    ),
  );
  const http = app.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(() => http.close());
  const url =
    "http://127.0.0.1:" +
    (http.address() as AddressInfo).port +
    "/hosts/fixture/ports";
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ remotePort: targetPort }),
      })
    ).status,
    403,
  );
  assert.equal(sessions, 0);
  const f = await ports.open(host.id, targetPort);
  assert.deepEqual(await ports.open(host.id, targetPort), f);
  assert.equal(sessions, 1);
  assert.equal(
    await (
      await fetch("http://127.0.0.1:" + f.localPort, {
        headers: { connection: "close" },
      })
    ).text(),
    "synthetic service",
  );
  host.username = "another-fixture";
  assert.deepEqual(ports.list(host.id), []);
  await assert.rejects(() => fetch("http://127.0.0.1:" + f.localPort));
  const again = await ports.open(host.id, targetPort);
  ports.close(host.id, again.id);
  assert.deepEqual(ports.list(host.id), []);
  await ports.open(host.id, targetPort);
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(ports.list(host.id), []);
});
