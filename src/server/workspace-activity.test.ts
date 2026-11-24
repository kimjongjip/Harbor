import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import type { HostConfig, MessageItem } from "../shared/types";
import type { HistoryDetail } from "../shared/history";
import type { RemoteWorkspaces } from "./remote-workspaces";
import { workspaceChatRouter } from "./workspace-chat";
import { WorkspaceActivity, type ActivityView } from "./workspace-activity";

const v: ActivityView = {
  id: randomUUID(),
  runtimeId: randomUUID(),
  nativeId: randomUUID(),
  cwd: "/fixture/project",
  provider: "codex",
  contentRevision: 7,
  status: "running",
  items: [{ kind: "user", id: "u", turnId: "turn", text: "work" }],
};
const tool: MessageItem = {
  kind: "command",
  id: "c",
  turnId: "turn",
  text: "fixture",
  detail: "line",
  status: "inProgress",
};
const report: MessageItem = {
  kind: "assistant",
  id: "report",
  turnId: "turn",
  phase: "commentary",
  text: "public update",
};
function saved(view: ActivityView = v): HistoryDetail {
  return {
    thread: {
      id: view.nativeId,
      hostId: "target",
      provider: view.provider,
      cwd: view.cwd,
      title: "",
      preview: "",
      updatedAt: 0,
      source: "cli",
      active: true,
    },
    items: [],
    timeline: [{ ...v.items[0] }, report, tool],
    nextCursor: null,
  };
}
test("legacy active timeline retains native revisions, refreshes tool output at most once per interval and survives a final response", async () => {
  let time = 0,
    reads = 0,
    checks = 0;
  const a = new WorkspaceActivity(() => time),
    scope = "authorized";
  const run = (view: ActivityView, detail: string, requested?: string) =>
    a.enrich(
      scope,
      "target",
      view,
      async () => {
        reads++;
        const page = saved();
        page.timeline![2] = { ...tool, detail };
        return page;
      },
      async () => {
        checks++;
        return undefined;
      },
      () => {},
      requested,
    );
  const first = (await run(v, "first")) as ActivityView & {
    pollRevision: string;
  };
  assert.deepEqual(
    first.items.map((i) => i.id),
    ["u", "report", "c"],
  );
  assert.equal(first.contentRevision, 7);
  assert.equal(a.conditional(scope, first.pollRevision), v.runtimeId + ":7");
  assert.deepEqual(await run(v, "changed", first.pollRevision), {
    unchanged: true,
  });
  assert.equal(reads, 1);
  assert.equal(checks, 1);
  time += 5001;
  assert.equal(a.conditional(scope, first.pollRevision), undefined);
  const second = (await run(v, "done", first.pollRevision)) as typeof first;
  assert.equal(second.items[2].detail, "done");
  assert.notEqual(first.pollRevision, second.pollRevision);
  const idle = {
    ...v,
    status: "idle",
    contentRevision: 8,
    items: [
      ...v.items,
      report,
      { id: "final", kind: "assistant" as const, text: "answer" },
    ],
  };
  const final = (await run(idle, "complete")) as typeof first;
  assert.deepEqual(
    final.items.map((i) => i.id),
    ["u", "report", "c", "final"],
  );
  time += 10000;
  assert.equal(a.conditional(scope, final.pollRevision), v.runtimeId + ":8");
  assert.equal(a.conditional("other device", final.pollRevision), undefined);
});
test("a slow read returns the original snapshot while shared history comes in, and never crosses a new prompt", async () => {
  const a = new WorkspaceActivity(),
    scope = "one device";
  let finish!: (detail: HistoryDetail) => void;
  const read = new Promise<HistoryDetail>((resolve) => {
    finish = resolve;
  });
  const first = await a.enrich(
    scope,
    "target",
    v,
    () => read,
    async () => undefined,
    () => {},
  );
  assert.deepEqual(first, v);
  finish(saved());
  await new Promise((done) => setImmediate(done));
  assert.equal(a.conditional(scope, v.runtimeId + ":7"), undefined);
  const result = await a.enrich(
    scope,
    "target",
    v,
    () => {
      throw Error("duplicate read");
    },
    async () => undefined,
    () => {},
  );
  assert.equal(("items" in result ? result.items : []).length, 3);
  const next = {
    ...v,
    items: [
      ...v.items,
      { kind: "user" as const, id: "other", turnId: "new", text: "other" },
    ],
  };
  const other = await a.enrich(
    scope,
    "target",
    next,
    async () => saved(),
    async () => undefined,
    () => {},
  );
  assert.deepEqual(other, next);
});

test("Claude SDK fallback with different request UUIDs requires a unique open prompt and remembers that exact native turn", async () => {
  const a = new WorkspaceActivity(),
    base = {
      ...v,
      provider: "claude" as const,
      items: [{ kind: "user" as const, id: "client", text: "same" }],
    };
  const page = saved(base),
    request = {
      kind: "user" as const,
      id: "native",
      text: "same",
      turnId: "actual",
    };
  page.timeline = [request, { ...tool, turnId: "actual" }];
  const run = (key: string, view: ActivityView) =>
    a.enrich(
      key,
      "target",
      view,
      async () => page,
      async () => undefined,
      () => {},
    );
  const open = await run("visible", base);
  assert.equal("items" in open && open.items.at(-1)?.id, "c");
  page.timeline.push({
    kind: "assistant",
    id: "final",
    phase: "final_answer",
    text: "finished",
    turnId: "actual",
  });
  const done = await run("visible", { ...base, status: "idle" });
  assert.equal("items" in done && done.items.at(-1)?.id, "c");
  assert.equal(
    "items" in (await run("stale", base)) &&
      ((await run("stale", base)) as ActivityView).items.length,
    1,
  );
  page.timeline = [
    { ...request, id: "old" },
    request,
    { ...tool, turnId: "actual" },
  ];
  const repeated = await run("ambiguous", base);
  assert.equal("items" in repeated && repeated.items.length, 1);
});

test("legacy relay reauthorizes native bindings around history reads without trusting client-supplied IDs", async (t) => {
  const host = {
    id: "target",
    kind: "ssh",
    address: "fixture.invalid",
    port: 22,
    username: "test",
    identityFile: "",
  } as HostConfig;
  let reads = 0,
    allowed = true,
    mode = "good";
  const clone = () => ({
    ...v,
    hostId: "local",
    items: v.items.map((i) => ({ ...i })),
  });
  let changed = false;
  const remote = {
    enabled: () => true,
    chat: async (
      _host: HostConfig,
      _pw: unknown,
      _actor: string,
      _method: string,
      path: string,
      _body: unknown,
      _term: unknown,
      guard: () => void,
      options?: { revision?: string },
    ) => {
      assert.equal(path, "/conversations/" + v.id);
      guard();
      if (options?.revision === v.runtimeId + ":7" && !changed)
        return { status: 200, value: { unchanged: true } };
      return {
        status: 200,
        value: { ...clone(), nativeId: changed ? randomUUID() : v.nativeId },
      };
    },
  } as unknown as RemoteWorkspaces;
  const app = express();
  app.use(
    "/:hostId",
    workspaceChatRouter(
      remote,
      () => host,
      async () => undefined,
      (req) => {
        if (!allowed) throw Object.assign(Error("revoked"), { status: 403 });
        return { kind: "desktop", id: req.get("x-fixture-actor") || "A" };
      },
      undefined,
      async (_h, binding) => {
        assert.equal(binding.nativeId, v.nativeId);
        reads++;
        if (mode === "revoke") allowed = false;
        if (mode === "change") changed = true;
        const page = saved();
        if (mode === "wrong-dir") page.thread.cwd = "/different";
        return page;
      },
    ),
  );
  app.use(
    (
      e: Error & { status?: number },
      _r: express.Request,
      res: express.Response,
      _n: express.NextFunction,
    ) => res.status(e.status || 500).json({ error: "fixture" }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const get = (actor: string, rev?: string) =>
    fetch(
      "http://127.0.0.1:" +
        (server.address() as AddressInfo).port +
        "/target/conversations/" +
        v.id +
        "?nativeId=forged",
      {
        headers: {
          "x-fixture-actor": actor,
          ...(rev ? { "x-harbor-chat-revision": rev } : {}),
        },
      },
    );
  const first = await (await get("A")).json();
  assert.equal(first.items.length, 3);
  assert.deepEqual(await (await get("A", first.pollRevision)).json(), {
    unchanged: true,
  });
  assert.equal(reads, 1);
  mode = "wrong-dir";
  assert.equal(
    (await (await get("B", first.pollRevision)).json()).items.length,
    1,
  );
  mode = "revoke";
  assert.equal((await get("C")).status, 403);
  allowed = true;
  mode = "change";
  assert.equal((await get("D")).status, 409);
});
