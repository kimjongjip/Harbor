import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk/core";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeSshProcess,
  installedClaudeExecutable,
  type ClaudeQuery,
} from "./ide-chat-claude.js";
import type { HostConfig } from "../shared/types.js";
import type { AccountQuota } from "../shared/host-insights.js";

// An async stream that never yields a user message only opens the control
// protocol. skipBehaviors avoids scanning transcripts on the selected host.
export async function claudeUsageControl(
  host: HostConfig,
  password: string | undefined,
  start: ClaudeQuery = query,
) {
  let finish!: () => void;
  const end = new Promise<void>((r) => {
    finish = r;
  });
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 12000);
  let session: ReturnType<ClaudeQuery> | undefined;
  try {
    const prompt = async function* (): AsyncGenerator<SDKUserMessage> {
      await end;
    };
    session = start({
      prompt: prompt(),
      options: {
        cwd: host.kind === "local" ? tmpdir() : "/tmp",
        pathToClaudeCodeExecutable:
          host.kind === "local" ? await installedClaudeExecutable() : "claude",
        abortController: controller,
        persistSession: false,
        permissionMode: "dontAsk",
        settingSources: [],
        tools: [],
        strictMcpConfig: true,
        mcpServers: {},
        spawnClaudeCodeProcess: (options) => {
          if (host.kind === "ssh")
            return new ClaudeSshProcess(host, password, options);
          const child = spawn(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            signal: options.signal,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          });
          child.stderr.resume();
          return child;
        },
      },
    });
    const account = await session.accountInfo();
    if (account.apiProvider && account.apiProvider !== "firstParty")
      return {
        error: "이 Claude 로그인 방식에서는 구독 한도가 제공되지 않습니다.",
      };
    if (!account.email) return;
    const identity = {
      email: account.email,
      plan: account.subscriptionType,
      source: "cli",
    };
    if (
      typeof session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !==
      "function"
    )
      return;
    try {
      const usage =
        await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(
          { skipBehaviors: true },
        );
      if (usage.rate_limits_available && usage.rate_limits)
        return {
          ...identity,
          plan: usage.subscription_type || account.subscriptionType,
          usage: usage.rate_limits,
        };
      return {
        ...identity,
        error: usage.rate_limits_available
          ? "Claude Code에서 한도를 확인하는 중입니다."
          : "Claude Code에서 이 계정의 구독 한도를 제공하지 않습니다.",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/429|too many requests|rate.?limit/i.test(message))
        return {
          ...identity,
          status: 429,
          error: "Claude 사용량 조회 요청 제한입니다.",
        };
      if (
        /unsupported|unknown (?:control|request|subtype)|not implemented/i.test(
          message,
        )
      )
        return;
      return {
        ...identity,
        error: "Claude Code의 사용량 조회가 일시적으로 실패했습니다.",
      };
    }
  } finally {
    clearTimeout(timer);
    finish();
    session?.close();
  }
}
export function quotaHostKey(host: HostConfig) {
  return JSON.stringify([
    host.id,
    host.kind,
    host.address,
    host.username,
    host.port,
    host.identityFile,
    host.kind === "local" ? process.env.CLAUDE_CONFIG_DIR : "",
  ]);
}
export function retryAfterSeconds(value: unknown, now = Date.now()) {
  if (typeof value !== "string" && typeof value !== "number") return 0;
  const str = String(value).trim();
  if (/^\d+$/.test(str)) {
    const n = Number(str);
    return Number.isSafeInteger(n) ? n : 0;
  }
  const until = Date.parse(str);
  return Number.isFinite(until)
    ? Math.max(0, Math.ceil((until - now) / 1000))
    : 0;
}
interface RecordValue {
  updatedAt: number;
  good?: AccountQuota;
  blockedUntil?: number;
  failures?: number;
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export class ClaudeQuotaSource {
  private readonly records = new Map<string, RecordValue>();
  private readonly samples = new Map<string, { raw: any; at: number }>();
  private readonly pending = new Map<string, Promise<any>>();
  private readonly file?: string;
  constructor(directory?: string) {
    this.file = directory && join(directory, "claude-quota-snapshots.json");
    if (this.file)
      try {
        if (statSync(this.file).size > 512 * 1024) return;
        const saved = JSON.parse(readFileSync(this.file, "utf8"));
        for (const [k, v] of Object.entries(saved) as [string, RecordValue][])
          if (
            /^[a-f0-9]{64}$/.test(k) &&
            Number.isFinite(v?.updatedAt) &&
            (!v.good ||
              (v.good.provider === "claude" && Array.isArray(v.good.windows)))
          )
            this.records.set(k, v);
      } catch {
        /* No cache on first start. */
      }
  }
  private key(host: HostConfig, email: unknown) {
    return typeof email === "string" && email.trim()
      ? digest(quotaHostKey(host) + "\n" + email.trim().toLowerCase())
      : undefined;
  }
  private put(key: string, entry: RecordValue) {
    this.records.delete(key);
    this.records.set(key, entry);
    if (this.records.size > 128)
      this.records.delete(this.records.keys().next().value!);
    if (this.file)
      try {
        writeFileSync(
          this.file + "." + process.pid + ".tmp",
          JSON.stringify(Object.fromEntries(this.records)),
          { mode: 0o600 },
        );
        renameSync(this.file + "." + process.pid + ".tmp", this.file);
      } catch {
        /* Disk failures do not erase in-memory measurements. */
      }
  }
  read(
    host: HostConfig,
    force: boolean,
    getIdentity: () => Promise<any>,
    network: () => Promise<any>,
    control: undefined | (() => Promise<any>),
    normalize: (v: any) => AccountQuota,
  ) {
    const key = quotaHostKey(host),
      sample = this.samples.get(key);
    if (sample && Date.now() - sample.at < (force ? 15000 : 120000))
      return Promise.resolve(sample.raw);
    const current = this.pending.get(key);
    if (current) return current;
    const task = (async () => {
      const id = await getIdentity().catch(() => ({})),
        recordKey = this.key(host, id?.email);
      const anonymous = digest(key + "\n(unknown)");
      const budgetKey = digest(key + "\n(request budget)");
      const blockedUntil =
          this.records.get(budgetKey)?.blockedUntil ||
          this.records.get(recordKey || anonymous)?.blockedUntil ||
          0,
        now = Date.now();
      let raw: any;
      if (blockedUntil > now)
        raw = {
          ...id,
          status: 429,
          error: "Claude 사용량 조회 요청 제한입니다.",
          retryAt: blockedUntil,
        };
      else {
        if (control) raw = await control().catch(() => undefined);
        if (!raw)
          raw = await network().catch(() => ({
            ...id,
            status: 503,
            error: "Claude 사용량 서버에 연결하지 못했습니다.",
          }));
      }
      const rawKey = this.key(host, raw.email);
      const record = this.records.get(rawKey || anonymous);
      if (raw.status === 429 && !raw.retryAt) {
        const failures = Math.min(8, (record?.failures || 0) + 1);
        const delay = Math.max(
          retryAfterSeconds(raw.retryAfter),
          Math.min(1800, 120 * 2 ** (failures - 1)),
        );
        raw.retryAt = Date.now() + delay * 1000;
        this.put(rawKey || anonymous, {
          ...record,
          updatedAt: Date.now(),
          failures,
          blockedUntil: raw.retryAt,
        });
        this.put(budgetKey, {
          updatedAt: Date.now(),
          blockedUntil: raw.retryAt,
        });
      }
      if (rawKey && !raw.error) {
        const good = normalize(raw);
        if (good.windows.length) {
          const { account: _email, ...publicFields } = good;
          this.put(rawKey, { updatedAt: Date.now(), good: publicFields });
        }
      }
      if (
        raw.error &&
        rawKey &&
        record?.good &&
        Date.now() - record.good.updatedAt < 24 * 3600000
      ) {
        const windows = record.good.windows.filter(
          (w) => !w.resetsAt || w.resetsAt > Date.now(),
        );
        if (windows.length) raw.cached = { ...record.good, windows };
      }
      this.samples.delete(key);
      this.samples.set(key, { raw, at: Date.now() });
      if (this.samples.size > 64)
        this.samples.delete(this.samples.keys().next().value!);
      return raw;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
}
