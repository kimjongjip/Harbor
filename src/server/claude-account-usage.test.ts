import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HostConfig } from "../shared/types";
import {
  claudeUsageControl,
  ClaudeQuotaSource,
  retryAfterSeconds,
} from "./claude-account-usage";
import { claudeQuota } from "./host-insights";

const host = {
  id: "test",
  kind: "ssh",
  username: "user",
  address: "example.invalid",
  port: 22,
  identityFile: "",
} as HostConfig;
test("authenticated Claude control reads plan windows without a prompt, tools or persisted session", async () => {
  let closed = false;
  const calls: string[] = [];
  const data = await claudeUsageControl(host, undefined, (({
    options,
    prompt,
  }: any) => {
    assert.equal(typeof prompt[Symbol.asyncIterator], "function");
    assert.equal(options.persistSession, false);
    assert.equal(options.permissionMode, "dontAsk");
    assert.deepEqual(options.tools, []);
    assert.equal(typeof options.spawnClaudeCodeProcess, "function");
    return {
      accountInfo: async () => {
        calls.push("account");
        return { email: "fixture@example.invalid", apiProvider: "firstParty" };
      },
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (
        opts: any,
      ) => {
        assert.deepEqual(opts, { skipBehaviors: true });
        calls.push("usage");
        return {
          rate_limits_available: true,
          rate_limits: { seven_day: { utilization: 23 } },
        };
      },
      close: () => {
        closed = true;
      },
    };
  }) as any);
  assert.deepEqual(calls, ["account", "usage"]);
  assert.equal(closed, true);
  assert.equal(claudeQuota(data).windows[0].remaining, 77);
});

test("Claude quota prefers native control on cold startup, deduplicates, honors long Retry-After and isolates saved measurements after restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harbor-claude-quota-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = Date.parse("2030-01-01T12:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  let email = "fixture@example.invalid",
    native = 0,
    direct = 0,
    throttle = false;
  const identity = async () => ({ email });
  const network = async () => {
    direct++;
    throw Error("should not hit fallback");
  };
  const control = async () => {
    native++;
    return throttle
      ? {
          email,
          status: 429,
          retryAfter: new Date(now + 3600000).toUTCString(),
          error: "provider throttle",
        }
      : {
          email,
          usage: {
            seven_day: { utilization: 28 },
            seven_day_fable: { utilization: 57 },
          },
          token: "never-persist-this",
        };
  };
  const source = new ClaudeQuotaSource(directory);
  const read = (s: ClaudeQuotaSource, h: HostConfig = host) =>
    s.read(h, true, identity, network, control, claudeQuota);
  const [a, b] = await Promise.all([read(source), read(source)]);
  assert.equal(native, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(
    claudeQuota(a).windows.map((w) => w.remaining),
    [72, 43],
  );
  throttle = true;
  t.mock.timers.tick(16000);
  const limited = await read(source);
  assert.equal(limited.retryAt, now + 3600000);
  assert.equal(limited.cached.updatedAt, now);
  const cached = await readFile(
    join(directory, "claude-quota-snapshots.json"),
    "utf8",
  );
  assert.doesNotMatch(cached, /fixture@example|never-persist/);
  t.mock.timers.tick(121000);
  const reloaded = new ClaudeQuotaSource(directory);
  const saved = await read(reloaded);
  assert.equal(saved.retryAt, now + 3600000);
  assert.deepEqual(
    saved.cached.windows.map((w: any) => w.remaining),
    [72, 43],
  );
  assert.equal(native, 2);
  email = "other@example.invalid";
  t.mock.timers.tick(16000);
  const other = await read(reloaded);
  assert.equal(other.cached, undefined);
  assert.equal(other.retryAt, now + 3600000);
  assert.equal(native, 2);
  assert.equal(direct, 0);
  // A different host binding cannot inherit these data.
  await read(reloaded, { ...host, port: 2200 });
  assert.equal(native, 3);
});
test("parse rate limit wait time as seconds or HTTP date", () => {
  assert.equal(retryAfterSeconds("7200"), 7200);
  assert.equal(
    retryAfterSeconds(
      "Tue, 01 Jan 2030 12:00:00 GMT",
      Date.parse("2030-01-01T11:59:00Z"),
    ),
    60,
  );
  assert.equal(retryAfterSeconds("not a date"), 0);
});
