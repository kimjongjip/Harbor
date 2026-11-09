import { test } from "node:test";
import assert from "node:assert/strict";
import {
  researchArguments,
  researchSettings,
  validateResearchSettings,
  researchReconnectOptions,
} from "./research-settings.js";
import {
  powershellInitialization,
  bashInitialization,
} from "./terminal-shell.js";
import type { HostConfig } from "../shared/types.js";
import { shellQuote } from "./ssh.js";
import type { ResearchModel } from "../shared/research.js";

test("resuming an existing research Claude requests peer reception with the same native ID and no model/effort overrides", () => {
  const nativeId = "synthetic-resume-session-123",
    cwd = "/workspace/research";
  const options = researchReconnectOptions(
    { owned: false, kind: "claude", cwd },
    { model: "must-not-override", effort: "max" },
  );
  assert.deepEqual(options, { researchLaunch: { cwd, effort: "default" } });
  assert.deepEqual(researchArguments("claude", options.researchLaunch!), []);
  const host: HostConfig = {
    id: "fixture-host",
    name: "Fixture",
    kind: "local",
    address: "",
    username: "",
    port: 22,
    identityFile: "",
    codexPath: "codex",
    defaultCwd: "~",
    mode: "isolated",
    color: "#112233",
    createdAt: 0,
  };
  const bridge = {
    url: "http://127.0.0.1:4317/fixture",
    token: "synthetic-token",
    hook: { url: "http://127.0.0.1:4317/hook", token: "synthetic-hook" },
  };
  const windows = powershellInitialization(
    host,
    "claude-resume",
    bridge.url,
    nativeId,
    true,
    options.resumeCwd,
    options.researchLaunch,
  );
  const remote = bashInitialization(
    { ...host, kind: "ssh" },
    "~",
    "claude-resume",
    bridge,
    nativeId,
    options.resumeCwd,
    options.researchLaunch,
  );
  assert.match(
    windows,
    /claude --harbor-peers\s+--resume 'synthetic-resume-session-123'/,
  );
  assert.ok(
    remote.includes(
      shellQuote(
        `claude --harbor-peers  --resume ${shellQuote(nativeId)}`,
      ).slice(1, -1),
    ),
  );
  assert.doesNotMatch(windows, /must-not-override/);
  assert.doesNotMatch(remote, /must-not-override/);
  assert.deepEqual(
    researchReconnectOptions({ owned: false, kind: "codex", cwd }),
    { resumeCwd: cwd },
  );
  assert.deepEqual(
    researchReconnectOptions(
      { owned: true, kind: "codex", cwd },
      { model: "fixture-model", effort: "low" },
    ),
    { researchLaunch: { cwd, model: "fixture-model", effort: "low" } },
  );
});

test("research defaults omit model and effort overrides while explicit settings stay provider-specific", () => {
  assert.deepEqual(researchArguments("codex", { effort: "default" }), []);
  assert.deepEqual(
    researchArguments("claude", { model: " ", effort: "default" }),
    [],
  );
  assert.deepEqual(
    researchArguments("codex", { model: "fixture-model", effort: "xhigh" }),
    ["--model", "fixture-model", "-c", 'model_reasoning_effort="xhigh"'],
  );
  assert.deepEqual(
    researchArguments("claude", { model: "opus[1m]", effort: "max" }),
    ["--model", "opus[1m]", "--effort", "max"],
  );
  assert.equal(researchSettings("codex", undefined, "low").effort, "low");
});

test("invalid model identifiers and unsupported Claude effort fail before shell launch without silently reducing effort", () => {
  for (const model of [
    "--model",
    "model with space",
    "model; echo bad",
    "$(bad)",
    "`bad`",
    "x\ny",
    'x"y',
    "a".repeat(151),
  ])
    assert.throws(() => researchSettings("codex", { model, effort: "low" }));
  for (const effort of ["none", "minimal", "ultra"])
    assert.throws(
      () => researchSettings("claude", { effort }),
      /지원하지 않는/,
    );
  assert.equal(
    researchSettings("claude", { model: "  sonnet  ", effort: "high" }).model,
    "sonnet",
  );
  assert.equal(researchSettings("codex", { effort: "ultra" }).effort, "ultra");
});

test("Astra display shorthand preserves intended model; account catalog verifies ID and effort without substitution", async () => {
  const models: ResearchModel[] = [
    {
      id: "gpt-6-astra",
      name: "GPT-6 Astra",
      isDefault: false,
      efforts: ["low", "max"],
    },
    {
      id: "fixture-default",
      name: "Default",
      isDefault: true,
      efforts: ["low"],
    },
  ];
  assert.deepEqual(
    researchArguments("codex", { model: " Astra ", effort: "max" }),
    ["--model", "gpt-6-astra", "-c", 'model_reasoning_effort="max"'],
  );
  assert.equal(
    researchSettings("claude", { model: "Astra", effort: "low" }).model,
    "Astra",
  );
  assert.deepEqual(
    await validateResearchSettings(
      "codex",
      { model: "ASTRA", effort: "max" },
      async () => models,
    ),
    { model: "gpt-6-astra", effort: "max" },
  );
  await assert.rejects(
    validateResearchSettings(
      "codex",
      { model: "Astra", effort: "low" },
      async () => models.slice(1),
    ),
    /gpt-6-astra.*사용할 수 없습니다/,
  );
  await assert.rejects(
    validateResearchSettings(
      "codex",
      { model: "Astra", effort: "ultra" },
      async () => models,
    ),
    /ultra/,
  );
  await assert.rejects(
    validateResearchSettings("codex", { effort: "max" }, async () => models),
    /Default.*max/,
  );
  assert.deepEqual(
    await validateResearchSettings(
      "codex",
      { effort: "low" },
      async () => models,
    ),
    { effort: "low" },
  );
  await assert.rejects(
    validateResearchSettings(
      "codex",
      { model: "Astra", effort: "low" },
      async () => {
        throw new Error("private authentication details");
      },
    ),
    /모델 목록을 확인하지 못했습니다/,
  );
  assert.deepEqual(
    await validateResearchSettings("codex", { effort: "default" }, async () => {
      throw Error("Must not load");
    }),
    { effort: "default" },
  );
  assert.deepEqual(
    await validateResearchSettings(
      "claude",
      { model: "sonnet", effort: "low" },
      async () => {
        throw Error("Must not load");
      },
    ),
    { model: "sonnet", effort: "low" },
  );
});
