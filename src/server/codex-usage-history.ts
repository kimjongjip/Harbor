import { codexUsage, codexUsageTail } from "./terminal-usage.js";
import type { TerminalUsage } from "../shared/terminal-usage.js";

// USD / 1M tokens, Standard API equivalents, checked 2026-11-10.
// https://developers.openai.com/api/docs/pricing
// https://developers.openai.com/api/docs/models/gpt-6-astra
// https://developers.openai.com/api/docs/models/gpt-6-sol
// This is not a ChatGPT subscription charge or a credits/quota estimate.
const rates: Record<string, readonly [number, number, number]> = {
  "gpt-6-astra": [10, 1, 50],
  "gpt-6-sol": [2, 0.2, 10],
  "gpt-6.1-sol": [2, 0.1, 10],
  "gpt-6.1-terra": [1, 0.05, 5],
  "gpt-6-luna": [0.1, 0.01, 0.5],
  "gpt-5.6-sol": [4, 0.4, 20],
  "gpt-5.6": [4, 0.4, 20],
};
type Counts = { input: number; cached: number; write: number; output: number };
const zero = (): Counts => ({ input: 0, cached: 0, write: 0, output: 0 });
function counts(value: any): Counts | null {
  if (!value) return null;
  const result = {
    input: value.input_tokens,
    cached: value.cached_input_tokens ?? 0,
    write: value.cache_write_input_tokens ?? 0,
    output: value.output_tokens,
  };
  return Object.values(result).every((n) => Number.isSafeInteger(n) && n >= 0)
    ? result
    : null;
}

/** Counts are inclusive: cached input and reasoning output must not be added twice. */
export function codexApiCost(
  model: string | undefined,
  usage: Counts,
  requestInput: number,
): number | null {
  const rate = model && rates[model.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
  if (!rate || usage.cached + usage.write > usage.input) return null;
  // API-equivalent pricing includes the documented long-prompt surcharge.
  // This threshold never supplies the context-window denominator in the UI.
  const long = requestInput > 272000;
  const inputMultiplier = long ? 2 : 1,
    outputMultiplier = long ? 1.5 : 1;
  return (
    ((usage.input - usage.cached - usage.write) * rate[0] * inputMultiplier +
      usage.cached * rate[1] * inputMultiplier +
      usage.write * rate[0] * 1.25 * inputMultiplier +
      usage.output * rate[2] * outputMultiplier) /
    1_000_000
  );
}

/** Incremental ledger: one session file, bounded chunks, no transcript retained. */
export class CodexUsageLedger {
  model?: string;
  usage: TerminalUsage | null = null;
  cost = 0;
  priced = 0;
  unpriced = 0;
  private previous = zero();
  private fragment = "";
  private skipping = false;
  constructor(readonly sessionId: string) {}
  append(text: string) {
    const lines = (this.fragment + text).split("\n");
    this.fragment = lines.pop()!;
    for (const line of lines) {
      if (this.skipping) {
        this.skipping = false;
        continue;
      }
      if (line.length > 2 * 1024 * 1024) continue;
      try {
        this.record(JSON.parse(line));
      } catch {
        /* A partial/non-JSON record is not usage. */
      }
    }
    if (this.fragment.length > 2 * 1024 * 1024) {
      this.fragment = "";
      this.skipping = true;
    }
  }
  private record(row: any) {
    if (row.type === "turn_context" && typeof row.payload?.model === "string")
      this.model = row.payload.model.slice(0, 150);
    if (row.type === "compacted") {
      if (this.usage)
        this.usage = { ...this.usage, usedTokens: null, usedPercent: null };
      return;
    }
    if (row.type !== "event_msg" || row.payload?.type !== "token_count") return;
    const info = row.payload.info;
    if (!info) return;
    const stamp = Date.parse(row.timestamp);
    this.usage = codexUsage(
      this.sessionId,
      {
        last: { totalTokens: info.last_token_usage?.total_tokens },
        modelContextWindow: info.model_context_window,
      },
      Number.isFinite(stamp) ? stamp : Date.now(),
      "history",
    );
    const total = counts(info.total_token_usage);
    if (!total) return;
    const delta = Object.fromEntries(
      Object.keys(total).map((k) => [
        k,
        total[k as keyof Counts] - this.previous[k as keyof Counts],
      ]),
    ) as Counts;
    if (Object.values(delta).some((n) => n < 0)) {
      this.previous = total;
      this.unpriced++;
      return;
    }
    this.previous = total;
    if (!Object.values(delta).some((n) => n > 0)) return; // Duplicate token/rate-limit notifications.
    const price = codexApiCost(
      this.model,
      delta,
      info.last_token_usage?.input_tokens ?? delta.input,
    );
    if (price === null) this.unpriced++;
    else {
      this.cost += price;
      this.priced++;
    }
  }
  snapshot(loading = false): TerminalUsage | null {
    if (!this.usage) return null;
    return {
      ...this.usage,
      model: this.model,
      costUsd: this.priced ? this.cost : null,
      costSource: "api-estimate",
      costStatus: loading
        ? "loading"
        : this.unpriced
          ? this.priced
            ? "partial"
            : "unpriced"
          : undefined,
    };
  }
}

export type UsageChunk = { size: number; data: Buffer };
type Entry = {
  file: string;
  offset: number;
  ledger: CodexUsageLedger;
  pending?: Promise<void>;
  cancelled?: boolean;
  failed?: boolean;
};
export class CodexUsageHistory {
  private entries = new Map<string, Entry>();
  async read(
    hostId: string,
    sessionId: string,
    file: string,
    read: (start: number) => Promise<UsageChunk>,
    tail: () => Promise<string>,
  ) {
    const key = hostId + "\0" + sessionId;
    let e = this.entries.get(key);
    if (!e || e.file !== file) {
      if (e) e.cancelled = true;
      e = { file, offset: 0, ledger: new CodexUsageLedger(sessionId) };
      this.entries.set(key, e);
    }
    this.entries.delete(key);
    this.entries.set(key, e);
    while (this.entries.size > 32) {
      const oldest = this.entries.keys().next().value!;
      this.entries.get(oldest)!.cancelled = true;
      this.entries.delete(oldest);
    }
    const entry = e;
    if (!entry.pending)
      entry.pending = (async () => {
        entry.failed = false;
        let size = entry.offset;
        while (!entry.cancelled) {
          const chunk = await read(entry.offset);
          size = chunk.size;
          if (entry.cancelled) return;
          if (size < entry.offset) {
            entry.offset = 0;
            entry.ledger = new CodexUsageLedger(sessionId);
            continue;
          }
          if (!chunk.data.length) break;
          // Usage/model fields are ASCII; decode complete UTF-8 independently of
          // content, which is deliberately never kept or returned by this reader.
          entry.ledger.append(chunk.data.toString("utf8"));
          entry.offset += chunk.data.length;
          if (entry.offset >= size) break;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      })()
        .catch(() => {
          entry.failed = true;
        })
        .finally(() => {
          entry.pending = undefined;
        });
    // Current context is always available from the bounded tail immediately;
    // an old 150MB conversation's cost scan continues independently of polling.
    const latest = codexUsageTail(sessionId, await tail(), Date.now());
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (entry.cancelled) return null;
    const loading = !!entry.pending || !!entry.failed;
    const value = entry.ledger.snapshot(loading);
    if (!loading) return value;
    return latest
      ? {
          ...value,
          ...latest,
          costUsd: value?.costUsd ?? null,
          costSource: "api-estimate" as const,
          costStatus: "loading" as const,
          model: value?.model,
        }
      : value
        ? {
            ...value,
            usedTokens: null,
            usedPercent: null,
            costStatus: "loading" as const,
          }
        : null;
  }
  clear(hostId: string) {
    for (const key of this.entries.keys())
      if (key.startsWith(hostId + "\0")) {
        this.entries.get(key)!.cancelled = true;
        this.entries.delete(key);
      }
  }
  shutdown() {
    for (const entry of this.entries.values()) entry.cancelled = true;
    this.entries.clear();
  }
}
