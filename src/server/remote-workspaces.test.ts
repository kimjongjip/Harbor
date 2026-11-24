import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { createServer, request } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import type { Client, ClientChannel } from "ssh2";
import { RemoteWorkspaces } from "./remote-workspaces.js";
import { workspaceInstall, workspaceShell } from "./workspace-install.js";
import { WorkspaceAccess, issueWorkspaceLink } from "./workspace-access.js";
import { workspaceCanSwitch } from "./workspace-update.js";
import { relayChatRequest } from "./workspace-chat.js";
import type { HostConfig } from "../shared/types.js";
import { join as pathJoin, resolve } from "node:path";
import { build } from "esbuild";

test(
  "built Harbor workspace requires a ticket on its private socket and lists its durable host",
  { timeout: 35000 },
  async (t) => {
    const fixture = await mkdtemp(resolve(".cache", "durable-workspace-boot-"));
    const data = pathJoin(fixture, "data"),
      dist = pathJoin(fixture, "dist"),
      key = randomBytes(32).toString("hex");
    const socket =
      process.platform === "win32"
        ? "\\\\.\\pipe\\harbor-durable-" + randomBytes(10).toString("hex")
        : pathJoin(
            tmpdir(),
            "harbor-work-" + randomBytes(8).toString("hex") + ".sock",
          );
    await mkdir(pathJoin(dist, "client"), { recursive: true });
    await mkdir(data);
    await writeFile(
      pathJoin(dist, "client", "index.html"),
      "<!doctype html><title>fixture</title>",
    );
    await writeFile(pathJoin(data, "workspace.key"), key, { mode: 0o600 });
    await build({
      entryPoints: ["src/server/index.ts"],
      outfile: pathJoin(dist, "server.mjs"),
      bundle: true,
      platform: "node",
      packages: "external",
      format: "esm",
      logLevel: "silent",
    });
    const child = spawn(process.execPath, [pathJoin(dist, "server.mjs")], {
      cwd: fixture,
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        USERPROFILE: fixture,
        HOME: fixture,
        CODEX_HOME: pathJoin(fixture, "codex"),
        HARBOR_WORKSPACE_SOCKET: socket,
        HARBOR_DATA_DIR: data,
        HARBOR_DEFAULT_CWD: fixture,
        HARBOR_AUTO_CONNECT: "0",
      },
    });
    const stopped = once(child, "exit");
    t.after(async () => {
      if (child.exitCode === null) child.kill();
      await stopped;
      await rm(fixture, { recursive: true, force: true });
    });
    for (
      let i = 0;
      i < 130 && !existsSync(pathJoin(data, "server.json"));
      i++
    ) {
      if (child.exitCode !== null)
        throw Error("Fixture server exited " + child.exitCode);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(
      JSON.parse(await readFile(pathJoin(data, "server.json"), "utf8")).socket,
      socket,
    );
    const hostname = "harbor-" + "a".repeat(24) + ".localhost:58320";
    const go = (
      path: string,
      method = "GET",
      headers: Record<string, string> = {},
    ) =>
      new Promise<{ code: number; data: string; cookie?: string }>(
        (done, fail) => {
          const q = request(
            {
              socketPath: socket,
              path,
              method,
              agent: false,
              headers: { host: hostname, ...headers },
            },
            (res) => {
              let body = "";
              res.setEncoding("utf8");
              res.on("data", (d) => (body += d));
              res.on("end", () =>
                done({
                  code: res.statusCode!,
                  data: body,
                  cookie: res.headers["set-cookie"]?.[0].split(";")[0],
                }),
              );
            },
          );
          q.on("error", fail);
          q.end();
        },
      );
    assert.equal((await go("/api/bootstrap")).code, 403);
    const login = await go("/_workspace/login", "POST", {
      "x-harbor-link": issueWorkspaceLink(key, hostname),
    });
    assert.equal(login.code, 204);
    const boot = await go("/api/bootstrap", "GET", { cookie: login.cookie! });
    assert.equal(boot.code, 200);
    const view = JSON.parse(boot.data);
    assert.equal(view.localCwd, fixture);
    assert.ok(
      view.state.hosts.some(
        (h: HostConfig) => h.id === "local" && h.defaultCwd === fixture,
      ),
    );
  },
);

const host: HostConfig = {
  id: "remote-a",
  name: "A",
  kind: "ssh",
  address: "fixture",
  port: 22,
  mode: "auto",
  username: "fixture",
  identityFile: "",
  codexPath: "codex",
  defaultCwd: "~",
  color: "#fff",
  createdAt: 1,
};

test("remote account keeps one workspace across desktop client shutdown; ticket, websocket and relay keep separate scopes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harbor-durable-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32).toString("hex"),
    access = new WorkspaceAccess(key);
  const app = express();
  app.use(access.middleware);
  app.use(express.json());
  app.get(
    "/_workspace/chat/conversations/00000000-0000-4000-a000-000000000001/usage",
    (_req, res) => {
      res
        .type("html")
        .send(
          '<!doctype html><div id="root"></div><script src="/assets/application.js"></script>',
        );
    },
  );
  app.get(
    "/_workspace/chat/conversations/00000000-0000-4000-a000-000000000002/usage",
    (_req, res) => res.sendStatus(403),
  );
  let accepted = 0;
  app.get("/api/bootstrap", (_req, res) => res.json({ accepted }));
  app.post("/_workspace/chat/conversations", (_req, res) => {
    assert.match(res.locals.workspaceActor, /^mobile-/);
    res.json({ accepted: ++accepted });
  });
  const service = createServer(app),
    wss = new WebSocketServer({ noServer: true });
  service.on("upgrade", (req, socket, head) => {
    if (!access.authorized(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send("same-session");
      ws.close();
    });
  });
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  const remotePort = (service.address() as AddressInfo).port;
  t.after(() => {
    wss.close();
    service.close();
    service.closeAllConnections();
  });
  let sshCount = 0;
  const ssh = async () => {
    sshCount++;
    const client = new EventEmitter() as Client;
    client.end = () => client;
    client.exec = ((
      command: string,
      cb: (err: Error | null, c: ClientChannel) => void,
    ) => {
      assert.ok(command.includes("/bin/bash -lc"));
      const ch = new PassThrough({ autoDestroy: false }) as any;
      ch.stderr = new PassThrough();
      cb(null, ch);
      queueMicrotask(() => {
        ch.emit(
          "data",
          Buffer.from(
            "/run/user/1000/harbor-workspace/http.sock\n" +
              key +
              "\n" +
              Math.floor(Date.now() / 1000) +
              "\nactive\n",
          ),
        );
        ch.emit("exit", 0);
        ch.emit("close", 0);
      });
      return client;
    }) as Client["exec"];
    client.openssh_forwardOutStreamLocal = ((path: string, cb: Function) => {
      assert.equal(path, "/run/user/1000/harbor-workspace/http.sock");
      const socket = connect(remotePort, "127.0.0.1", () => cb(null, socket));
      return client;
    }) as Client["openssh_forwardOutStreamLocal"];
    return client;
  };
  const local = new RemoteWorkspaces(directory, directory, ssh);
  t.after(() => local.close());
  const first = new URL((await local.open(host, undefined, false)).url);
  const signedRead = (id: string) =>
    local.chat(
      host,
      undefined,
      "host-" + "a".repeat(32),
      "GET",
      "/conversations/" + id + "/usage",
      undefined,
      undefined,
      () => {},
    );
  assert.equal(
    (await signedRead("00000000-0000-4000-a000-000000000001")).unsupportedUsage,
    true,
  );
  const denied = await signedRead("00000000-0000-4000-a000-000000000002");
  assert.equal(denied.status, 403);
  assert.equal(denied.unsupportedUsage, undefined);
  app.get(
    "/_workspace/chat/conversations/00000000-0000-4000-a000-000000000003/usage",
    (_req, res) =>
      res
        .status(404)
        .type("html")
        .send(
          "<!DOCTYPE html><html><title>Error</title><pre>NotFoundError: Not Found<br></pre></html>",
        ),
  );
  assert.equal(
    (await signedRead("00000000-0000-4000-a000-000000000003")).unsupportedUsage,
    true,
  );
  const http = (
    url: URL,
    path: string,
    method = "GET",
    headers: Record<string, string> = {},
  ) =>
    new Promise<{ status: number; cookie?: string }>((done, fail) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: url.port,
          path,
          method,
          headers: { host: url.host, ...headers },
        },
        (res) => {
          res.resume();
          res.on("end", () =>
            done({
              status: res.statusCode!,
              cookie: res.headers["set-cookie"]?.[0].split(";")[0],
            }),
          );
        },
      );
      req.on("error", fail);
      req.end();
    });
  assert.equal((await http(first, "/api/bootstrap")).status, 403);
  const login = await http(first, "/_workspace/login", "POST", {
    "x-harbor-link": first.hash.slice(1),
  });
  assert.equal(login.status, 204);
  assert.equal(
    (
      await http(first, "/_workspace/login", "POST", {
        "x-harbor-link": first.hash.slice(1),
      })
    ).status,
    403,
  );
  assert.equal(
    (await http(first, "/api/bootstrap", "GET", { cookie: login.cookie! }))
      .status,
    200,
  );
  assert.equal(
    (
      await http(first, "/api/bootstrap", "GET", {
        cookie: login.cookie!,
        origin: "https://other.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await http(first, "/_workspace/chat/conversations", "POST", {
        cookie: login.cookie!,
      })
    ).status,
    403,
  );
  const ws = new WebSocket("ws://127.0.0.1:" + first.port + "/ws", {
    headers: { host: first.host, cookie: login.cookie!, origin: first.origin },
  });
  assert.equal(String((await once(ws, "message"))[0]), "same-session");
  await once(ws, "close");
  const actor = "mobile-" + "a".repeat(32);
  assert.deepEqual(
    await local.chat(
      host,
      undefined,
      actor,
      "POST",
      "/conversations",
      { hostId: "local" },
      undefined,
      () => {},
    ),
    { status: 200, value: { accepted: 1 } },
  );
  local.close();
  const restored = new RemoteWorkspaces(directory, directory, ssh);
  t.after(() => restored.close());
  assert.ok(restored.enabled(host));
  assert.equal(restored.enabled({ ...host, username: "different" }), false);
  const next = new URL((await restored.open(host, undefined, false)).url);
  assert.equal(next.host, first.host);
  assert.equal(sshCount, 2);
  assert.equal(accepted, 1);
});

test("installer parses as bash without placing a workspace key in its arguments", () => {
  const bash =
    process.platform === "win32"
      ? "C:/Program Files/Git/bin/bash.exe"
      : "/bin/bash";
  if (!existsSync(bash)) return;
  const script = workspaceInstall("c".repeat(64), "2.0.0");
  for (const source of [script, workspaceShell(script)]) {
    const check = spawnSync(bash, ["-n"], { input: source, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
  }
  const run = spawnSync(
    bash,
    ["-c", workspaceShell("printf '%s' 'synthetic handshake'")],
    { encoding: "utf8" },
  );
  assert.equal(run.stdout, "synthetic handshake");
  assert.throws(() => workspaceInstall("bad", "2.0.0"));
});

test("dependency failure in a private installation staging directory preserves the selected release and account data", async (t) => {
  const bash =
    process.platform === "win32"
      ? "C:/Program Files/Git/bin/bash.exe"
      : "/bin/bash";
  if (!existsSync(bash)) return t.skip("requires Bash");
  const home = await mkdtemp(join(tmpdir(), "harbor-install-fixture-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const manifests = join(home, "dist", "worker-manifest"),
    root = join(home, ".local", "share", "harbor-workspace");
  await mkdir(manifests, { recursive: true });
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(join(root, "current"), "previous-release");
  await writeFile(join(root, "data", "state.json"), "session-record");
  await writeFile(join(manifests, "package.json"), "{}");
  await writeFile(join(manifests, "package-lock.json"), "{}");
  const archive = spawnSync("tar", ["-czf", "-", "-C", home, "dist"]);
  assert.equal(archive.status, 0);
  const sha = createHash("sha256").update(archive.stdout).digest("hex");
  const profile = [
    'export HOME="$PWD" XDG_RUNTIME_DIR="$PWD"',
    "uname(){ echo Linux; }",
    "loginctl(){ echo yes; }",
    "systemctl(){ return 0; }",
    "flock(){ return 0; }",
    "npm(){ echo fixture-install-failure >&2; return 71; }",
  ].join("\n");
  const result = spawnSync(
    bash,
    ["-c", profile + "\n" + workspaceInstall(sha, "2.0.0")],
    { cwd: home, input: archive.stdout },
  );
  assert.equal(result.status, 71, result.stderr.toString());
  assert.match(result.stderr.toString(), /fixture-install-failure/);
  assert.equal(
    await readFile(join(root, "current"), "utf8"),
    "previous-release",
  );
  assert.equal(
    await readFile(join(root, "data", "state.json"), "utf8"),
    "session-record",
  );
});

test("staged update waits for a detached process in the service cgroup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harbor-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = join(root, "old"),
    next = join(root, "new"),
    groups = join(root, "groups");
  const group = join(groups, "user.slice", "harbor-workspace.service"),
    member = join(root, "membership");
  for (const d of [current, next, group]) await mkdir(d, { recursive: true });
  await writeFile(join(next, ".harbor-release"), "fixture");
  await writeFile(member, "0::/user.slice/harbor-workspace.service\n");
  await writeFile(join(group, "cgroup.procs"), "100\n101\n");
  assert.equal(workspaceCanSwitch(next, current, groups, member, 100), false);
  await writeFile(join(group, "cgroup.procs"), "100\n");
  assert.equal(workspaceCanSwitch(next, current, groups, member, 100), true);
  assert.equal(workspaceCanSwitch(next, next, groups, member, 100), false);
  await mkdir(join(group, "nested-jobs"));
  assert.equal(workspaceCanSwitch(next, current, groups, member, 100), false);
});

test("chat relay keeps requested host and approved routes separate from administrative APIs", () => {
  const policyPath = "/conversations/12345678-1234-4321-a123-123456789abc/auto-accept";
  const policy = { runtimeId: "fixture-runtime", enabled: true };
  assert.deepEqual(
    relayChatRequest(host.id, { method: "POST", path: policyPath, query: {}, body: policy }),
    { path: policyPath, body: policy },
  );
  for (const path of [
    policyPath,
    "/api/bootstrap",
    "/conversations/../../bootstrap",
    "/hosts/other/history",
    "/conversations/" + "a".repeat(36) + "/approvals/%2f..",
  ]) {
    assert.throws(() =>
      relayChatRequest(host.id, {
        method: "GET",
        path,
        query: {},
        body: undefined,
      }),
    );
  }
  assert.throws(() =>
    relayChatRequest(host.id, {
      method: "POST",
      path: "/conversations",
      query: {},
      body: { hostId: "other" },
    }),
  );
  assert.deepEqual(
    relayChatRequest(host.id, {
      method: "POST",
      path: "/conversations",
      query: {},
      body: { hostId: host.id, provider: "claude" },
    }),
    { path: "/conversations", body: { hostId: "local", provider: "claude" } },
  );
});
