import test from "node:test";
import assert from "node:assert/strict";
import {
  ClaudeMods,
  modsEnvironment,
  parseModsStatus,
  type ModsRunner,
} from "./claude-mods";
import type { HostConfig } from "../shared/types";

const host = {
  id: "synthetic-host",
  kind: "ssh",
  name: "Test server",
} as HostConfig;
test("Mods install is host scoped, deduplicated and verified without terminal input", async () => {
  const calls: { host: string; args: string[] }[] = [];
  let installed = false,
    release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const manager = new ClaudeMods(async (target, args, password) => {
    assert.equal(password, "fixture-not-a-secret");
    calls.push({ host: target.id, args });
    if (args[0] === "--version")
      return { code: 0, stdout: "2.1.319 (Claude Code)" };
    if (args[1] === "install") {
      await gate;
      installed = true;
      return { code: 0, stdout: '{"success":true}' };
    }
    return {
      code: 0,
      stdout: JSON.stringify(
        installed ? [{ id: "agent-crew@agent-crew", enabled: true }] : [],
      ),
    };
  });
  const one = manager.install(host, "fixture-not-a-secret");
  assert.equal(manager.install(host, "fixture-not-a-secret").id, one.id);
  assert.equal(manager.job("unrelated-host"), undefined);
  release();
  const result = await manager.settled(host.id);
  assert.equal(result?.status, "succeeded");
  assert.equal(result?.result?.installed, true);
  const installs = calls.filter((call) => call.args[1] === "install");
  assert.deepEqual(installs, [
    {
      host: host.id,
      args: [
        "plugin",
        "install",
        "agent-crew",
        "--marketplace",
        "kimjongjip/agent-crew",
        "--scope",
        "user",
        "--json",
      ],
    },
  ]);
  manager.install(host, "fixture-not-a-secret");
  await manager.settled(host.id);
  assert.equal(
    calls.filter((call) => call.args[1] === "install").length,
    1,
    "An installed mod is not reinstalled",
  );
});

test("Mods refuses an old CLI or a disabled plugin and does not trust an install exit code alone", async () => {
  for (const scenario of [
    "old",
    "disabled",
    "missing-after-install",
    "command-denied",
    "bad-json",
  ] as const) {
    let installs = 0;
    const run: ModsRunner = async (_host, args) => {
      if (args[0] === "--version")
        return { code: 0, stdout: scenario === "old" ? "2.1.317" : "2.1.319" };
      if (args[1] === "install") {
        installs++;
        return { code: scenario === "command-denied" ? 1 : 0, stdout: "{}" };
      }
      return {
        code: 0,
        stdout:
          scenario === "bad-json"
            ? "invalid"
            : JSON.stringify(
                scenario === "disabled"
                  ? [{ id: "agent-crew@fixture", enabled: false }]
                  : [],
              ),
      };
    };
    const manager = new ClaudeMods(run);
    manager.install(host);
    assert.equal((await manager.settled(host.id))?.status, "failed", scenario);
    assert.equal(
      installs,
      ["missing-after-install", "command-denied"].includes(scenario) ? 1 : 0,
      scenario,
    );
  }
  assert.equal(parseModsStatus("2.2.0", "[]").compatible, true);
  assert.equal(
    parseModsStatus("2.1.318", '[{"id":"not-agent-crew@fixture"}]').installed,
    false,
  );
  assert.throws(() => parseModsStatus("unknown", "[]"));
});

test("Mods maintenance does not inherit another live agent's bridge or thread", () => {
  const source = {
    PATH: "fixture",
    CLAUDE_CONFIG_DIR: "fixture-config",
    HARBOR_HOOK_TOKEN: "fixture-only",
    CODEX_THREAD_ID: "fixture-thread",
    CLAUDECODE: "1",
    ELECTRON_RUN_AS_NODE: "1",
  };
  assert.deepEqual(modsEnvironment(source), {
    PATH: "fixture",
    CLAUDE_CONFIG_DIR: "fixture-config",
  });
  assert.equal(source.CODEX_THREAD_ID, "fixture-thread");
});
