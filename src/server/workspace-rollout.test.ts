import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostConfig, WorkspaceUpdateStatus } from "../shared/types";
import { desktopUpdateReceipt, WorkspaceRollout } from "./workspace-rollout";

test("desktop install receipts bind the selected SHA, version, pending restart and original data directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harbor-handoff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sha = "a".repeat(40),
    runtime = join(root, ".runtime"),
    active = join(runtime, "updates", sha);
  const data = join(root, "data");
  await mkdir(active, { recursive: true });
  await mkdir(data);
  const pointer = join(runtime, "desktop-update.json");
  const pending = join(
    runtime,
    "update-restart-00000000-0000-4000-a000-000000000001.json",
  );
  const version = "2.4.0",
    spec = { dataDirectory: data, installRoot: root, sha, version };
  await writeFile(
    join(active, ".harbor-update.json"),
    JSON.stringify({ sha, version }),
  );
  await writeFile(
    pointer,
    JSON.stringify({ directory: sha, version, dataDirectory: data }),
  );
  const receipt = () => desktopUpdateReceipt(data, version, root, active);
  assert.equal(
    receipt(),
    undefined,
    "ordinary reopening of an old install is passive",
  );
  await writeFile(pending, JSON.stringify(spec));
  assert.equal(receipt()?.sha, sha);
  assert.equal(desktopUpdateReceipt(root, version, root, active), undefined);
  assert.equal(desktopUpdateReceipt(data, "2.5.0", root, active), undefined);
  await writeFile(pending, JSON.stringify({ ...spec, sha: "b".repeat(40) }));
  assert.equal(
    receipt(),
    undefined,
    "rollback to the previous pointer has no matching upgrade",
  );
  await writeFile(pending, JSON.stringify(spec));
  await utimes(pointer, new Date(0), new Date(0));
  assert.equal(
    receipt(),
    undefined,
    "a stale handoff cannot arm future sessions",
  );
  await rm(pending);
  const profiles = ["f".repeat(64)];
  await writeFile(
    pointer,
    JSON.stringify({
      directory: sha,
      version,
      dataDirectory: data,
      workspaceUpdate: { requestedAt: Date.now(), profiles },
    }),
  );
  assert.deepEqual(
    receipt()?.profiles,
    profiles,
    "current updater snapshots enrollment before launch",
  );
});

test("explicit update converges enrolled profiles across PC restarts and retires only confirmed releases", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "harbor-update-plan-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const host = (id: string) =>
    ({ id, name: id, kind: "ssh", address: id.repeat(64) }) as HostConfig;
  const first = host("a"),
    other = host("b"),
    third = host("c");
  const hosts = [first, other];
  const enabled = new Set([first.id]);
  const calls: string[] = [],
    passive: string[] = [];
  let phase: WorkspaceUpdateStatus["phase"] = "pending";
  const workers = {
    version: "2.4.0",
    enabled: (h: HostConfig) => enabled.has(h.id),
    profile: (h: HostConfig) => h.address,
    status: (): WorkspaceUpdateStatus => ({
      phase,
      targetVersion: "2.4.0",
      runningVersion: phase === "current" ? "2.4.0" : "2.0.1",
    }),
    convergeForUpdate: async (h: HostConfig) => {
      calls.push(h.id);
    },
    synchronize: async (h: HostConfig) => {
      passive.push(h.id);
    },
  };
  const open = () =>
    new WorkspaceRollout(
      dir,
      workers,
      () => hosts,
      async () => undefined,
    );
  const finish = () => new Promise((done) => setImmediate(done));
  let plan = open();
  plan.tick();
  assert.deepEqual(calls, []);
  assert.deepEqual(passive, ["a"]);
  const start = plan.start();
  plan.tick();
  assert.deepEqual(
    start.hosts.map((h) => h.id),
    ["a"],
  );
  assert.deepEqual(calls, ["a"]);
  await finish();
  plan = open();
  hosts.push(third);
  enabled.add(third.id);
  plan.tick();
  await finish();
  assert.deepEqual(calls, ["a", "a"]);
  assert.deepEqual(passive, ["a", "c"]);
  phase = "current";
  plan = open();
  plan.tick();
  await finish();
  assert.deepEqual(calls, ["a", "a", "a"]);
  plan = open();
  plan.tick();
  assert.equal(calls.length, 3);
  phase = "pending";
  plan.start();
  await finish();
  plan.forget(first);
  plan = open();
  plan.tick();
  assert.deepEqual(calls.slice(3), ["a", "c", "c"]);
  await finish();
  const file = join(dir, "workspace-update-intent.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...saved, until: 0 }));
  plan = open();
  plan.tick();
  assert.equal(calls.length, 6);
  // The installer only authorized 'first'; the rest of the PC's enrolled accounts stay passive.
  const receipt = {
    sha: "a".repeat(40),
    at: Date.now(),
    profiles: [workers.profile(first)],
  };
  plan.adopt(receipt);
  phase = "current";
  plan.tick();
  await finish();
  assert.deepEqual(calls.slice(6), ["a"]);
  plan = open();
  plan.adopt(receipt);
  plan.tick();
  assert.equal(
    calls.length,
    7,
    "a consumed installer receipt cannot re-arm a session",
  );
});
