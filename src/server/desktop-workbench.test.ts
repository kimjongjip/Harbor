import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { WebSocket } from "ws";

async function port() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const value = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return value;
}

test(
  "built backend exposes the real workbench to paired PCs without publishing host credentials or local administration",
  { timeout: 60000 },
  async () => {
    const parent = resolve(".cache/desktop-backend-tests");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, "run-")),
      localPort = await port(),
      mobilePort = await port();
    const origin = "https://workbench.fixture.ts.net",
      local = `http://127.0.0.1:${localPort}`;
    const env = {
      ...process.env,
      HARBOR_DATA_DIR: directory,
      HARBOR_PORT: String(localPort),
      HARBOR_AUTO_CONNECT: "0",
    };
    const child = spawn(process.execPath, [resolve("dist/server.mjs")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let log = "";
    child.stdout.on("data", (b) => {
      log += b;
    });
    child.stderr.on("data", (b) => {
      log += b;
    });
    let ws: WebSocket | undefined;
    try {
      let bootstrap: any;
      for (let n = 0; n < 150; n++) {
        if (child.exitCode !== null)
          throw new Error(`Fixture backend exited: ${log}`);
        try {
          bootstrap = await (await fetch(local + "/api/bootstrap")).json();
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      assert.ok(bootstrap?.token, log);
      const localCall = (path: string, body: unknown, method = "POST") =>
        fetch(local + path, {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-Harbor-Token": bootstrap.token,
          },
          body: JSON.stringify(body),
        });
      assert.equal(
        (
          await localCall(
            "/api/mobile",
            { enabled: true, origin, port: mobilePort },
            "PUT",
          )
        ).status,
        200,
      );
      async function remote(
        path: string,
        cookie = "",
        body?: unknown,
        method = "POST",
      ) {
        return new Promise<{ status: number; data: any; cookie?: string }>(
          (ok, fail) => {
            const req = request(
              `http://127.0.0.1:${mobilePort}${path}`,
              {
                method: body === undefined ? "GET" : method,
                headers: {
                  host: new URL(origin).host,
                  origin,
                  cookie,
                  "Content-Type": "application/json",
                  "X-Harbor-Token": "desktop",
                  "X-Harbor-Mobile": "1",
                },
              },
              (res) => {
                let text = "";
                res.setEncoding("utf8");
                res.on("data", (b) => {
                  text += b;
                });
                res.on("end", () =>
                  ok({
                    status: res.statusCode!,
                    data: JSON.parse(text),
                    cookie: res.headers["set-cookie"]?.[0].split(";")[0],
                  }),
                );
              },
            );
            req.on("error", fail);
            req.end(body === undefined ? undefined : JSON.stringify(body));
          },
        );
      }
      const invite = await (
        await localCall("/api/mobile/pair", { kind: "desktop" })
      ).json();
      const code = new URLSearchParams(new URL(invite.url).hash.slice(1)).get(
        "pair",
      );
      const paired = await remote("/mobile-api/pair", "", {
        code,
        name: "Test PC",
      });
      assert.equal(paired.status, 200);
      const cookie = paired.cookie!;
      assert.equal((await remote("/api/bootstrap")).status, 401);
      const page = await remote("/api/bootstrap", cookie);
      assert.equal(page.status, 200);
      assert.equal(page.data.token, "desktop");
      assert.notEqual(page.data.token, bootstrap.token);
      assert.ok(!JSON.stringify(page.data).includes(bootstrap.token));
      assert.deepEqual(
        page.data.state.terminals,
        [],
        "connecting must not start an AI or terminal",
      );
      assert.equal((await remote("/api/mobile", cookie)).status, 403);
      const snapshot = {
        activeId: "",
        page: "terminals",
        workspaceView: "ide",
        sidebar: "files",
        sidebarVisible: true,
        preferences: { "harbor.theme": "midnight" },
      };
      assert.equal(
        (await localCall("/api/desktop/workspace", snapshot, "PUT")).status,
        200,
      );
      assert.deepEqual(
        (await remote("/api/bootstrap", cookie)).data.workspace,
        snapshot,
      );
      assert.equal(
        (await remote("/api/desktop/workspace", cookie, snapshot, "PUT"))
          .status,
        403,
      );
      const added = await remote("/api/hosts", cookie, {
        name: "Paired PC server",
        kind: "local",
      });
      assert.equal(added.status, 200);
      const filename = join(directory, "example.txt");
      await writeFile(filename, "Shared file preview");
      const preview = await remote(
        `/api/hosts/local/files/preview?path=${encodeURIComponent(filename)}`,
        cookie,
      );
      assert.equal(preview.status, 200);
      assert.match(JSON.stringify(preview.data), /Shared file preview/);
      ws = new WebSocket(`ws://127.0.0.1:${mobilePort}/ws?token=desktop`, {
        headers: { host: new URL(origin).host, origin, cookie },
      });
      const initial = once(ws, "message");
      await once(ws, "open");
      assert.equal(JSON.parse(String((await initial)[0])).type, "state");
      const device = (await (await fetch(local + "/api/mobile")).json())
        .devices[0];
      const closed = once(ws, "close");
      assert.equal(
        (
          await fetch(local + "/api/mobile/devices/" + device.id, {
            method: "DELETE",
            headers: { "X-Harbor-Token": bootstrap.token },
          })
        ).status,
        200,
      );
      assert.equal((await closed)[0], 4001);
      assert.equal((await remote("/api/bootstrap", cookie)).status, 401);
    } finally {
      ws?.terminate();
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      const path = relative(parent, directory);
      if (!path || path.startsWith(".."))
        throw new Error("Unsafe fixture path");
      await rm(directory, { recursive: true, force: true });
    }
  },
);
