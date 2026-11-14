import test from "node:test";
import assert from "node:assert/strict";
import {
  codexUsage,
  claudeUsage,
  codexUsageTail,
  claudeUsageTail,
  TerminalUsageStore,
} from "./terminal-usage.js";
import {
  compactTokens,
  claudeUsageSnapshot,
  mergeClaudeUsage,
} from "../shared/terminal-usage.js";
import { History } from "./history.js";
import { ClaudeHistory, type ClaudeHistoryReader } from "./claude-history.js";
import { Files } from "./files.js";
import type { HostConfig } from "../shared/types.js";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";

const line = (value: unknown) => JSON.stringify(value) + "\n";
const codex = (used = 42000) => ({
  last: { totalTokens: used },
  total: { totalTokens: 8800000 },
  modelContextWindow: 1000000,
});
const claude = {
  session_id: "session-a",
  context_window: {
    context_window_size: 1000000,
    used_percentage: 5,
    current_usage: {
      input_tokens: 1000,
      cache_creation_input_tokens: 10000,
      cache_read_input_tokens: 31000,
    },
    total_input_tokens: 9000000,
    total_output_tokens: 800000,
  },
  cost: { total_cost_usd: 3.25 },
};

test("new Claude history keeps same-model engine limits as explicitly dated metadata", () => {
  const native = claudeUsage(
    { ...claude, model: { id: "claude-fixture" } },
    100,
  )!;
  const saved = claudeUsageTail(
    "session-a",
    line({
      type: "assistant",
      sessionId: "session-a",
      timestamp: "2030-01-01T00:00:00Z",
      message: { model: "claude-fixture", usage: { input_tokens: 150000 } },
    }),
    200,
  )!;
  const merged = mergeClaudeUsage(saved, native)!;
  assert.equal(merged.usedTokens, 150000);
  assert.equal(merged.contextWindow, 1000000);
  assert.equal(merged.usedPercent, 15);
  assert.equal(merged.metadataUpdatedAt, 100);
  assert.equal(merged.costUsd, 3.25);
  assert.equal(
    mergeClaudeUsage({ ...saved, model: "different" }, native)?.contextWindow,
    null,
  );
  assert.equal(
    mergeClaudeUsage({ ...saved, sessionId: "other" }, native)?.contextWindow,
    null,
  );
  assert.equal(
    mergeClaudeUsage(saved, { ...native, updatedAt: saved.updatedAt + 1 })
      ?.metadataUpdatedAt,
    undefined,
  );
});

test("context uses the latest request including cache, never cumulative usage or double-counted output", () => {
  const c = codexUsage("session-a", codex(), 1)!;
  assert.equal(c.usedTokens, 42000);
  assert.equal(c.usedPercent, 4.2);
  assert.equal(c.costUsd, null);
  const a = claudeUsage(claude, 2)!;
  assert.equal(a.usedTokens, 42000);
  assert.equal(a.usedPercent, 4.2);
  assert.equal(a.costUsd, 3.25);
  assert.equal(compactTokens(a.usedTokens), "42k");
  assert.equal(compactTokens(a.contextWindow), "1M");
  assert.equal(compactTokens(null), "—");
  assert.equal(compactTokens(0), "0");
});

test("unknown, zero, invalid and post-compaction usage stay distinct; model limits may change", () => {
  assert.equal(
    codexUsage("s", { last: { totalTokens: -1 }, modelContextWindow: 0 }),
    null,
  );
  assert.equal(codexUsage("s", { last: { totalTokens: "42000" } }), null);
  assert.equal(codexUsage("s", codex(0))!.usedPercent, 0);
  assert.equal(
    codexUsage("s", { ...codex(100000), modelContextWindow: 200000 })!
      .usedPercent,
    50,
  );
  const compacted = claudeUsage({
    ...claude,
    context_window: { ...claude.context_window, current_usage: null },
  })!;
  assert.equal(compacted.usedTokens, null);
  assert.equal(compacted.usedPercent, null);
  assert.equal(compacted.contextWindow, 1000000);
  assert.equal(compacted.costUsd, 3.25);
  assert.equal(
    claudeUsage({ ...claude, cost: { total_cost_usd: Number.NaN } })!.costUsd,
    null,
  );
  assert.equal(
    claudeUsage({
      ...claude,
      context_window: {
        ...claude.context_window,
        current_usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    })!.usedTokens,
    0,
  );
});

test("native cache validates identity, bounded JSON, measurement time and zero cost", () => {
  const value = {
    ...claude,
    harbor_updated_at: 100,
    harbor_context_estimated: true,
    model: { id: "claude-opus-5-5" },
    cost: { total_cost_usd: 0 },
  };
  const usage = claudeUsageSnapshot(JSON.stringify(value), "session-a")!;
  assert.equal(usage.contextWindow, 1000000);
  assert.equal(usage.costUsd, 0);
  assert.equal(usage.contextEstimated, true);
  assert.equal(usage.model, "claude-opus-5-5");
  assert.equal(usage.updatedAt, 100);
  assert.equal(claudeUsageSnapshot(JSON.stringify(value), "other"), null);
  assert.equal(claudeUsageSnapshot('{"unfinished":', "session-a"), null);
  assert.equal(
    claudeUsageSnapshot(
      JSON.stringify({ ...value, harbor_updated_at: NaN }),
      "session-a",
    ),
    null,
  );
  assert.equal(claudeUsageSnapshot(" ".repeat(17000), "session-a"), null);
});

test("native Codex context updates immediately while its saved ledger supplies cost", async () => {
  const store = new TerminalUsageStore();
  store.put("t", codexUsage("a", codex(90000), 200)!);
  const old = {
    ...codexUsage("a", codex(42000), 100, "history")!,
    costUsd: 4.2,
    model: "gpt-6-astra",
    costSource: "api-estimate" as const,
  };
  const value = await store.read("t", "codex", "a", async () => old);
  assert.equal(value!.usedTokens, 90000);
  assert.equal(value!.costUsd, 4.2);
  store.put("t", codexUsage("a", codex(95000), 300)!);
  assert.equal(
    (await store.read("t", "codex", "a", async () => {
      throw Error("cached");
    }))!.usedTokens,
    95000,
  );
});

test("bounded Codex rollout parsing tolerates truncation and resets at compaction", () => {
  const record = {
    timestamp: "2026-01-01T00:00:00Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { total_tokens: 10000000 },
        last_token_usage: { total_tokens: 42000 },
        model_context_window: 1000000,
      },
    },
  };
  const text = "truncated}\n" + line(record) + '{"unfinished":';
  const usage = codexUsageTail("s", text, 1)!;
  assert.equal(usage.usedTokens, 42000);
  assert.equal(usage.source, "history");
  assert.equal(usage.updatedAt, Date.parse(record.timestamp));
  assert.equal(
    codexUsageTail("s", line(record) + line({ type: "compacted" }), 1),
    null,
  );
});

test("Claude saved usage is main-session-only and never invents a model window or price", () => {
  const record = {
    sessionId: "session-a",
    type: "assistant",
    timestamp: "2026-01-01T00:00:00Z",
    message: { usage: claude.context_window.current_usage },
  };
  const text =
    line(record) +
    line({ ...record, sessionId: "other" }) +
    line({ ...record, isSidechain: true }) +
    line({ ...record, agentId: "child" });
  const usage = claudeUsageTail("session-a", text, 1)!;
  assert.equal(usage.usedTokens, 42000);
  assert.equal(usage.contextWindow, null);
  assert.equal(usage.costUsd, null);
  assert.equal(
    claudeUsageTail(
      "session-a",
      text +
        line({
          sessionId: "session-a",
          type: "system",
          subtype: "compact_boundary",
        }),
      1,
    ),
    null,
  );
});

test("usage store coalesces slow reads, scopes provider/session, and clears context after compaction", async () => {
  const store = new TerminalUsageStore();
  let count = 0,
    finish!: (value: null) => void;
  const read = () => {
    count++;
    return new Promise<null>((resolve) => {
      finish = resolve;
    });
  };
  const a = store.read("t", "codex", "a", read),
    b = store.read("t", "codex", "a", read);
  assert.equal(count, 1);
  finish(null);
  await Promise.all([a, b]);
  const native = codexUsage("a", codex(), 1)!;
  store.put("t", native);
  assert.deepEqual(
    await store.read("t", "codex", "a", async () => {
      throw Error("unexpected read");
    }),
    native,
  );
  assert.equal(await store.read("t", "codex", "b", async () => null), null);
  assert.equal(await store.read("t", "claude", "a", async () => null), null);
  store.compact("t");
  assert.equal(
    (
      await store.read("t", "codex", "a", async () => {
        throw Error("stale fallback");
      })
    )?.usedTokens,
    null,
  );
  store.put("t", codexUsage("a", codex(12000))!);
  assert.equal(
    (await store.read("t", "codex", "a", async () => null))?.usedTokens,
    12000,
  );
  const pending = store.read("other", "codex", "a", read);
  store.put("other", codexUsage("a", codex(9000))!);
  finish(null);
  assert.equal(
    (await pending)?.usedTokens,
    9000,
    "a late fallback cannot replace newer native telemetry",
  );
});

test("shared Codex telemetry finds its rollout with read-only metadata, never resume/start", async () => {
  const calls: string[] = [];
  const history = new History(async () => ({
    alive: true,
    stop() {},
    async call(method, params: any) {
      calls.push(method);
      assert.deepEqual(params, { threadId: "session-a", includeTurns: false });
      return {
        thread: { id: "session-a", path: "/fixture/rollout-session-a.jsonl" },
      };
    },
  }));
  try {
    assert.equal(
      await history.usagePath(
        { id: "fixture", kind: "local" } as HostConfig,
        undefined,
        "session-a",
      ),
      "/fixture/rollout-session-a.jsonl",
    );
    assert.deepEqual(calls, ["thread/read"]);
  } finally {
    history.shutdown();
  }
});

test("existing Claude sessions read only a bounded tail after discovery and never rescan projects on usage ticks", async () => {
  const host = { id: "fixture", kind: "local" } as HostConfig;
  let content = Buffer.from(
    line({ padding: "x".repeat(310000) }) +
      line({
        sessionId: "session-a",
        type: "assistant",
        message: { usage: claude.context_window.current_usage },
      }),
  );
  let entries = 0,
    opened = 0;
  const sizes: number[] = [];
  const reader: ClaudeHistoryReader = {
    root: "/fixture",
    join: (...parts) => parts.join("/"),
    close() {},
    async entries(dir) {
      entries++;
      return dir === "/fixture"
        ? [{ name: "project", directory: true, size: 0, modified: 1 }]
        : [
            {
              name: "session-a.jsonl",
              directory: false,
              size: content.length,
              modified: 1,
            },
          ];
    },
    async stat() {
      return { directory: false, size: content.length, modified: 2 };
    },
    async read(_file, start, length) {
      sizes.push(length);
      return content.subarray(start, start + length);
    },
  };
  const history = new ClaudeHistory(async () => {
    opened++;
    return reader;
  });
  try {
    assert.equal(await history.usage(host, undefined, "session-a"), null);
    assert.equal(opened, 0, "status does not start an all-project lookup");
    await history.list(host);
    const scans = entries;
    sizes.length = 0;
    assert.equal(
      (await history.usage(host, undefined, "session-a"))?.usedTokens,
      42000,
    );
    content = Buffer.concat([
      content,
      Buffer.from(
        line({
          sessionId: "session-a",
          type: "assistant",
          message: { usage: { input_tokens: 12000 } },
        }),
      ),
    ]);
    assert.equal(
      (await history.usage(host, undefined, "session-a"))?.usedTokens,
      12000,
    );
    assert.equal(entries, scans);
    assert.ok(sizes.every((size) => size <= 256 * 1024));
  } finally {
    history.shutdown();
  }
});

test("rollout tail transport has a fixed read bound on large files and preserves the latest complete usage", async () => {
  const parent = resolve(".cache/usage-tail-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "run-"));
  assert.ok(resolve(directory).startsWith(parent + sep));
  try {
    const record = {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { total_tokens: 42000 },
          model_context_window: 1000000,
        },
      },
    };
    const file = join(directory, "rollout.jsonl");
    await writeFile(
      file,
      line({ padding: "x".repeat(1024 * 1024) }) + line(record) + '{"partial":',
    );
    const files = new Files(() => undefined);
    const text = await files.usageTail(
      { id: "fixture", kind: "local" } as HostConfig,
      file,
    );
    assert.ok(Buffer.byteLength(text) <= 256 * 1024);
    assert.equal(codexUsageTail("a", text, 1)?.usedTokens, 42000);
    const host = { id: "fixture", kind: "local" } as HostConfig;
    const chunk = await files.usageChunk(host, file, 0);
    assert.equal(chunk.data.length, 256 * 1024);
    assert.ok(chunk.size > 1024 * 1024);
    assert.equal(
      (await files.usageChunk(host, file, chunk.size)).data.length,
      0,
    );
    await assert.rejects(files.usageSnapshot(host, file), /too large/);
    await writeFile(file, '{"numericSnapshot":123}');
    assert.equal(
      await files.usageSnapshot(host, file),
      '{"numericSnapshot":123}',
    );
    await writeFile(file, "");
    assert.equal(
      await files.usageTail(
        { id: "fixture", kind: "local" } as HostConfig,
        file,
      ),
      "",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude usage is available before opening history, using only the session's cwd or scoped hook path", async () => {
  const host = { id: "fixture", kind: "ssh" } as HostConfig;
  const text = Buffer.from(
    line({
      sessionId: "SessionA",
      type: "assistant",
      message: { usage: { input_tokens: 42000 } },
    }),
  );
  const files = new Set([
    "/claude/projects/-project-a/SessionA.jsonl",
    "/claude/projects/한글/SessionA.jsonl",
  ]);
  const stats: string[] = [],
    reads: string[] = [];
  const reader: ClaudeHistoryReader = {
    root: "/claude/projects",
    join: (...p) => p.join("/"),
    close() {},
    async entries() {
      throw Error("usage must never scan the catalog");
    },
    async stat(file) {
      stats.push(file);
      if (!files.has(file))
        throw Object.assign(Error("missing"), { code: "ENOENT" });
      return { directory: false, size: text.length, modified: 1 };
    },
    async read(file, start, length) {
      reads.push(file);
      return text.subarray(start, start + length);
    },
  };
  const history = new ClaudeHistory(async () => reader);
  try {
    assert.equal(
      (await history.usage(host, undefined, "SessionA", "/project/a"))
        ?.usedTokens,
      42000,
    );
    assert.deepEqual(stats, ["/claude/projects/-project-a/SessionA.jsonl"]);
    history.noteTranscript(
      host.id,
      "SessionA",
      "/claude/projects/한글/SessionA.jsonl",
    );
    assert.equal(
      (await history.usage(host, undefined, "SessionA"))?.usedTokens,
      42000,
    );
    assert.equal(reads.at(-1), "/claude/projects/한글/SessionA.jsonl");
    const previous = reads.length;
    history.noteTranscript(host.id, "SessionA", "/outside/SessionA.jsonl");
    assert.equal(await history.usage(host, undefined, "SessionA"), null);
    history.noteTranscript(
      host.id,
      "SessionA",
      "/claude/projects/project/other.jsonl",
    );
    assert.equal(await history.usage(host, undefined, "SessionA"), null);
    assert.equal(
      reads.length,
      previous,
      "out-of-root and different-session files are never read",
    );
    assert.equal(
      await history.usage(host, undefined, "missing", "/new-project"),
      null,
    );
    history.close(host.id);
    assert.equal(
      await history.usage(host, undefined, "SessionA"),
      null,
      "host reset discards usage paths",
    );
  } finally {
    history.shutdown();
  }
});
