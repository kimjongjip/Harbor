import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { History } from "./history.js";
import { listFolderHistory } from "./folder-history.js";
import { workspaceChatRouter } from "./workspace-chat.js";
import type { RemoteWorkspaces } from "./remote-workspaces.js";
import type { HistoryThread } from "../shared/history.js";
import type { HostConfig } from "../shared/types.js";

const host = {
  id: "fixture",
  kind: "ssh",
  address: "fixture.invalid",
  username: "fixture",
  port: 22,
} as HostConfig;
for (const windows of [false, true]) {
  test(`folder-first Codex metadata stays ordered across all pages (${windows ? "Windows" : "SSH"})`, async (t) => {
    const account = windows ? { ...host, kind: "local" as const } : host;
    const cwd = windows ? "C:\\Project" : "/repo";
    const rows = Array.from({ length: 224 }, (_, n) => ({
      id: "thread-" + n,
      name: n % 4 ? "needle" : "other",
      preview: "",
      updatedAt: 400 - n,
      cwd:
        n % 3 === 0
          ? windows
            ? n % 2
              ? "\\\\?\\C:\\PROJECT"
              : "c:/Project/"
            : cwd
          : cwd + "-other",
      source: "cli",
    }));
    const requests: {
      cwd?: string;
      searchTerm?: string;
      cursor: string | null;
    }[] = [];
    const native = new History(async () => ({
      alive: true,
      stop() {},
      async call(method, p: any) {
        assert.equal(method, "thread/list");
        assert.equal(p.useStateDbOnly, undefined, "folder and global cursors must keep the original index source");
        requests.push(p);
        const nativeKey = (path: string) =>
          windows
            ? path
                .replace(/^\\\\\?\\/, "")
                .replace(/[\\/]+$/, "")
                .replaceAll("/", "\\")
                .toLowerCase()
            : path;
        const matching = rows.filter(
          (r) =>
            (!p.cwd || nativeKey(r.cwd) === nativeKey(p.cwd)) &&
            (!p.searchTerm || r.name === p.searchTerm),
        );
        const start = Number(p.cursor || 0);
        return {
          data: matching.slice(start, start + p.limit),
          nextCursor:
            start + p.limit < matching.length ? String(start + p.limit) : null,
        };
      },
    }));
    t.after(() => native.shutdown());
    const overlay: HistoryThread = {
      id: "thread-177",
      provider: "codex",
      hostId: account.id,
      title: "needle (open)",
      cwd,
      preview: "",
      updatedAt: 328500,
      active: true,
      source: "Harbor IDE",
    };
    const seen: HistoryThread[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await native.list(account, undefined, {
        cwd: cwd + "/",
        search: "needle",
        cursor,
        managed: [overlay],
      });
      assert.equal(r.preferredCwd, cwd + "/");
      if (!pages && r.nextCursor)
        await assert.rejects(
          native.list(account, undefined, {
            cwd: cwd + "-elsewhere",
            cursor: r.nextCursor,
          }),
          /작업 폴더/,
        );
      pages++;
      assert.ok(pages < 12);
      seen.push(...r.data);
      cursor = r.nextCursor || undefined;
    } while (cursor);
    const expected = (folder: boolean) =>
      rows
        .filter((r, n) => r.name === "needle" && (n % 3 === 0) === folder)
        .map((r) => ({
          id: r.id,
          time: r.id === overlay.id ? overlay.updatedAt : r.updatedAt * 1000,
        }))
        .sort((a, b) => b.time - a.time)
        .map((r) => r.id);
    assert.deepEqual(
      seen.filter((t) => t.historyScope === "folder").map((t) => t.id),
      expected(true),
    );
    assert.deepEqual(
      seen.filter((t) => t.historyScope === "global").map((t) => t.id),
      expected(false),
    );
    assert.deepEqual(
      seen.map((t) => t.id),
      [...expected(true), ...expected(false)],
    );
    assert.ok(requests.every((r) => r.searchTerm === "needle"));
    assert.equal(requests[0].cwd, windows ? cwd + "\\" : cwd);
    assert.ok(pages >= 2);
  });
}

test("an empty folder goes straight to the first global page of a large account", async () => {
  const rows = Array.from({ length: 950 }, (_, n): HistoryThread => ({
    id: String(n),
    hostId: host.id,
    title: "saved",
    cwd: "C:\\Other",
    source: "cli",
    preview: "",
    active: false,
    updatedAt: 100000 - n,
  }));
  let calls = 0;
  const result = await listFolderHistory(
    { ...host, kind: "local" },
    { cwd: "C:\\Empty" },
    async (cursor, cwd) => {
      calls++;
      if (cwd) return { data: [], nextCursor: null };
      assert.equal(cursor, null);
      return { data: rows.slice(0, 50), nextCursor: "50" };
    },
  );
  assert.equal(calls, 2);
  assert.equal(result.data.length, 50);
  assert.ok(result.data.every((row) => row.historyScope === "global"));
  assert.ok(result.nextCursor);
});

test("legacy relay ranks only the authorized server account and keeps the native cursor off old workers", async (t) => {
  const requests: string[] = [];
  let allow = true,
    legacy = true;
  const api = {
    enabled: () => true,
    chat: async (
      _host: HostConfig,
      _pass: unknown,
      _actor: string,
      _method: string,
      path: string,
    ) => {
      requests.push(path);
      return {
        status: 200,
        value: {
          data: [],
          nextCursor: null,
          ...(!legacy && { preferredCwd: "/repo" }),
        },
      };
    },
  };
  const cursors: (string | undefined)[] = [];
  const app = express();
  app.use(
    "/:hostId",
    workspaceChatRouter(
      api as unknown as RemoteWorkspaces,
      () => host,
      async () => undefined,
      () => {
        if (!allow) throw Object.assign(Error("revoked"), { status: 403 });
        return { kind: "host", id: "owner" };
      },
      undefined,
      undefined,
      async (h, o) => {
        assert.equal(h.id, host.id);
        assert.equal(o.cwd, "/repo");
        assert.equal(o.search, "needle");
        cursors.push(o.cursor);
        return {
          preferredCwd: o.cwd,
          data: [],
          nextCursor: o.cursor ? null : "fixture-opaque",
        };
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
  const s = app.listen(0, "127.0.0.1");
  await once(s, "listening");
  t.after(() => s.close());
  const path = `http://127.0.0.1:${(s.address() as AddressInfo).port}/fixture/hosts/fixture/history?provider=codex&query=needle&cwd=%2Frepo`;
  const first = await (await fetch(path)).json();
  assert.equal(first.nextCursor, "lh1.fixture-opaque");
  legacy = false;
  assert.equal(
    (await (await fetch(path + "&cursor=" + first.nextCursor)).json())
      .nextCursor,
    null,
  );
  assert.ok(!requests.at(-1)?.includes("fixture-opaque"));
  await fetch(path);
  allow = false;
  assert.equal((await fetch(path)).status, 403);
  assert.deepEqual(cursors, [undefined, "fixture-opaque"]);
});

test("legacy global history follows an entirely excluded page using the same host and query", async (t) => {
  const pages: Array<string | null> = [];
  const workspaces = {
    enabled: () => true,
    async chat(
      h: HostConfig,
      _pass: unknown,
      _actor: string,
      method: string,
      path: string,
    ) {
      const url = new URL(path, "http://workspace.invalid");
      assert.equal(h.id, host.id);
      assert.equal(method, "GET");
      assert.equal(url.searchParams.get("query"), "test");
      const cursor = url.searchParams.get("cursor");
      pages.push(cursor);
      return {
        status: 200,
        value: {
          data: [
            {
              id: cursor ? "actual" : "verification",
              title: "test",
              hostId: "local",
            },
          ],
          nextCursor: cursor ? null : "next",
        },
      };
    },
  };
  const app = express();
  app.use(
    "/:hostId",
    workspaceChatRouter(
      workspaces as unknown as RemoteWorkspaces,
      () => host,
      async () => undefined,
      () => ({ kind: "host", id: "fixture" }),
      undefined,
      undefined,
      undefined,
      (h, p, id) => h.id !== host.id || p !== "codex" || id !== "verification",
    ),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/fixture/hosts/fixture/history?provider=codex&query=test`;
  const page = await (await fetch(url)).json();
  assert.deepEqual(pages, [null, "next"]);
  assert.deepEqual(
    page.data.map((row: HistoryThread) => [row.id, row.hostId]),
    [["actual", host.id]],
  );
  assert.equal(page.nextCursor, null);
});
