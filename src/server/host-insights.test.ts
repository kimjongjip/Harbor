import test from "node:test";
import assert from "node:assert/strict";
import {
  HostInsights,
  claudeQuota,
  codexQuota,
  claudeQuotaError,
} from "./host-insights.js";
import { History } from "./history.js";
import { taskName, workKind, TerminalWorkMonitor } from "./terminal-work.js";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { once } from "node:events";
import { claudeUsage } from "../shared/terminal-usage.js";
import type { HostConfig } from "../shared/types.js";
import type { Files } from "./files.js";
const host = {
  id: "fixture",
  kind: "ssh",
  name: "Fixture",
  codexPath: "codex",
} as HostConfig;
test("quota normalization separates subscription windows, clamps percentages and drops raw fields", () => {
  const quota = codexQuota(
    {
      account: {
        email: "fixture@example.invalid",
        planType: "pro",
        accessToken: "never-expose",
      },
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1234 },
          secondary: { usedPercent: 102, windowDurationMins: 10080 },
        },
      },
    },
    10,
  );
  assert.deepEqual(quota.windows, [
    { label: "5시간 한도", remaining: 75, resetsAt: 1234000 },
    { label: "7일 한도", remaining: 0 },
  ]);
  assert.ok(!JSON.stringify(quota).includes("never-expose"));
  const claude = claudeQuota({
    usage: {
      five_hour: { utilization: 12.5, resets_at: "2030-01-01T00:00:00Z" },
      seven_day: { utilization: 68, resets_at: "2030-01-01T00:00:00Z" },
      seven_day_fable: { utilization: 99 },
      seven_day_opus: { utilization: 50 },
      extra_usage: { utilization: 10 },
    },
  });
  assert.equal(claude.windows.length, 2);
  assert.equal(claude.windows[0].remaining, 32);
  assert.equal(claude.windows[1].remaining, 1);
  assert.equal(claude.windows[1].label, "7일 Fable 한도");
  assert.equal(
    claudeQuota({
      usage: { seven_day: { utilization: 68 }, seven_day_fable: null },
    }).windows.length,
    1,
  );
});
test("context writes target active profile and catalog maximum, without launching a thread", async () => {
  const calls: { method: string; params: any }[] = [];
  let config: any = {
    profile: "research",
    profiles: { research: { model: "fixture-model" } },
    unrelated: "keep",
  };
  const history = new History(async () => ({
    alive: true,
    stop() {},
    async call(method, params: any) {
      calls.push({ method, params });
      if (method === "config/read") return { config };
      if (method === "config/batchWrite") {
        for (const edit of params.edits)
          config.profiles.research[edit.keyPath.split(".").at(-1)!] =
            edit.value;
        return {};
      }
      throw new Error("Unexpected RPC");
    },
  }));
  const files = {
    researchCommand: async () =>
      JSON.stringify([
        {
          slug: "fixture-model",
          context_window: 272000,
          max_context_window: 872000,
        },
      ]),
  } as unknown as Files;
  const insights = new HostInsights(files, history, async () => undefined);
  try {
    assert.equal((await insights.context(host)).current, 272000);
    assert.equal((await insights.configure(host, "expand")).current, 872000);
    await insights.configure(host, "compact");
    assert.equal(
      config.profiles.research.model_auto_compact_token_limit,
      784800,
    );
    assert.equal(
      config.profiles.research.model_post_turn_compact_threshold_percent,
      85,
    );
    assert.equal(config.unrelated, "keep");
    assert.ok(calls.every((c) => c.method.startsWith("config/")));
    config.profiles.research.model_provider = "custom";
    await assert.rejects(insights.configure(host, "expand"), /지원 컨텍스트/);
  } finally {
    history.close(host.id);
  }
});
test("modern weekly_scoped usage returns Fable independently of legacy fields and unrelated models", () => {
  const quota = claudeQuota({
    usage: {
      seven_day: { utilization: 3 },
      limits: [
        { kind: "weekly_all", percent: 69, resets_at: "2030-01-01T00:00:00Z" },
        {
          kind: "weekly_scoped",
          percent: 40,
          scope: { model: { display_name: "Opus" } },
        },
        {
          kind: "daily_scoped",
          percent: 1,
          scope: { model: { display_name: "Fable" } },
        },
        {
          kind: "weekly_scoped",
          percent: 99,
          resets_at: "2030-01-01T00:00:00Z",
          scope: { model: { display_name: "Fable" } },
          internal: "must-not-leak",
        },
      ],
    },
  });
  assert.deepEqual(
    quota.windows.map((w) => [w.label, w.remaining]),
    [
      ["7일 한도", 31],
      ["7일 Fable 한도", 1],
    ],
  );
  assert.equal(quota.windows[1].resetsAt, Date.parse("2030-01-01T00:00:00Z"));
  assert.equal(JSON.stringify(quota).includes("must-not-leak"), false);
});
test("account reads deduplicate and fresh native Claude statusline replaces polling", async () => {
  let calls = 0;
  const history = {
    async accountUsage() {
      calls++;
      return {
        rateLimits: { primary: { usedPercent: 30, windowDurationMins: 300 } },
      };
    },
  } as unknown as History;
  const files = {
    researchCommand: async () => {
      throw new Error("should not read OAuth when native usage is fresh");
    },
  } as unknown as Files;
  const service = new HostInsights(files, history, async () => undefined);
  service.observe(
    host.id,
    claudeUsage({
      session_id: "fixture",
      rate_limits: {
        five_hour: { used_percentage: 80, resets_at: 12345 },
        seven_day: { used_percentage: 10 },
        seven_day_fable: { used_percentage: 95 },
      },
    })!,
  );
  const [a, b] = await Promise.all([service.quota(host), service.quota(host)]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.equal(a[1].windows[0].remaining, 90);
  assert.equal(a[1].windows[1].remaining, 5);
  await service.quota(host);
  assert.equal(calls, 1);
});
test("partial native quota preserves the separately fetched Fable quota and identity", async () => {
  const service = new HostInsights(
    {
      researchCommand: async () =>
        JSON.stringify({
          email: "fixture@example.invalid",
          plan: "max",
          usage: {
            seven_day: { utilization: 10 },
            seven_day_fable: { utilization: 98 },
          },
        }),
    } as unknown as Files,
    { accountUsage: async () => ({}) } as unknown as History,
    async () => undefined,
  );
  service.observe(
    host.id,
    claudeUsage({
      session_id: "fixture",
      rate_limits: { seven_day: { used_percentage: 20 } },
    })!,
  );
  for (const quotas of [await service.quota(host), await service.quota(host)]) {
    assert.equal(quotas[1].account, "fixture@example.invalid");
    assert.deepEqual(
      quotas[1].windows.map((w) => w.remaining),
      [80, 2],
    );
  }
});
test("refresh recovers after CLI credential rotation without caching auth errors for two minutes, while respecting 429", async (t) => {
  const root = resolve(".cache/quota-auth-tests");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "run-"));
  const oldConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  const file = join(dir, ".credentials.json");
  const credentials = (token: string) =>
    writeFile(
      file,
      JSON.stringify({
        claudeAiOauth: { accessToken: token, subscriptionType: "max" },
      }),
    );
  await credentials("synthetic-expired");
  await writeFile(
    join(dir, ".claude.json"),
    JSON.stringify({
      oauthAccount: { emailAddress: "fixture@example.invalid" },
    }),
  );
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  let requests = 0,
    status = 401;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
      requests++;
      if (status === 200)
        assert.equal(
          (options.headers as any).Authorization,
          "Bearer synthetic-current",
        );
      return new Response(
        JSON.stringify(
          status === 200
            ? {
                seven_day: { utilization: 68 },
                seven_day_fable: { utilization: 99 },
              }
            : {},
        ),
        { status, headers: { "Retry-After": "300" } },
      );
    },
  );
  try {
    const service = new HostInsights(
      {} as Files,
      { accountUsage: async () => ({}) } as unknown as History,
      async () => undefined,
    );
    const local = { ...host, kind: "local" } as HostConfig;
    assert.match((await service.quota(local))[1].error!, /인증/);
    await credentials("synthetic-current");
    status = 200;
    await service.quota(local, true);
    assert.equal(requests, 1, "rapid clicks do not hammer usage endpoint");
    t.mock.timers.tick(15001);
    const recovered = (await service.quota(local, true))[1];
    assert.equal(recovered.error, undefined);
    assert.equal(recovered.account, "fixture@example.invalid");
    assert.deepEqual(
      recovered.windows.map((w) => w.remaining),
      [32, 1],
    );
    status = 429;
    t.mock.timers.tick(15001);
    assert.match((await service.quota(local, true))[1].error!, /요청 제한/);
    const before = requests;
    t.mock.timers.tick(120001);
    await service.quota(local, true);
    assert.equal(requests, before, "Retry-After wins over manual refresh");
    assert.doesNotMatch(claudeQuotaError(503), /로그인|인증/);
    assert.match(claudeQuotaError(403), /조회.*거부/);
  } finally {
    if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = oldConfig;
  }
});
test("background jobs show script/log targets without credentials or arbitrary command text", () => {
  const name = taskName(
    "python train.py --api-key secret-value --output /private/results/run.log",
    "/usr/bin/python",
  );
  assert.equal(name, "python · train.py · run.log");
  assert.equal(workKind(name), "background");
  assert.equal(workKind("ramulator simulation.yaml"), "simulator");
  assert.equal(workKind("tail · simulation.log"), "monitor");
  assert.equal(workKind(name, 1024), "gpu");
  assert.equal(workKind("codex"), null);
});

test(
  "Windows probe finds an owned simulator child and never labels another process as this terminal's job",
  { skip: process.platform !== "win32", timeout: 20000 },
  async () => {
    const root = resolve(".cache/work-probe-tests");
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "run-"));
    const script = join(dir, "simulator.js");
    await writeFile(script, "setInterval(()=>{},1000);console.log('ready');");
    const child = spawn(
      process.execPath,
      [script, "--api-key", "synthetic-secret-never-display"],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      await once(child.stdout!, "data");
      const monitor = new TerminalWorkMonitor({} as Files);
      const result = await monitor.read(
        { ...host, kind: "local" },
        "fixture",
        undefined,
        process.pid,
      );
      assert.equal(result.error, undefined);
      const job = result.jobs.find((j) => j.pid === child.pid);
      assert.ok(job);
      assert.equal(job.kind, "simulator");
      assert.match(job.task, /simulator\.js/);
      assert.equal(JSON.stringify(result).includes("synthetic-secret"), false);
    } finally {
      const exit = once(child, "exit");
      child.kill();
      await exit;
    }
  },
);
