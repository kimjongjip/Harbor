import type { TerminalUsage } from "../shared/terminal-usage.js";
export { claudeUsage } from "../shared/terminal-usage.js";

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
const windowSize = (value: unknown) => {
  const n = count(value);
  return n && n > 0 ? n : null;
};
function snapshot(
  provider: TerminalUsage["provider"],
  sessionId: string,
  usedTokens: number | null,
  contextWindow: number | null,
  costUsd: number | null,
  updatedAt: number,
  source: TerminalUsage["source"],
  percent: number | null = null,
): TerminalUsage {
  return {
    provider,
    sessionId,
    usedTokens,
    contextWindow,
    costUsd,
    updatedAt,
    source,
    usedPercent:
      usedTokens !== null && contextWindow !== null
        ? (usedTokens / contextWindow) * 100
        : percent !== null && percent <= 100
          ? percent
          : null,
  };
}

export function codexUsage(
  sessionId: string,
  value: any,
  updatedAt = Date.now(),
  source: TerminalUsage["source"] = "native",
): TerminalUsage | null {
  if (!value || typeof value !== "object") return null;
  const used = count(value.last?.totalTokens);
  const limit = windowSize(value.modelContextWindow);
  if (used === null && limit === null) return null;
  // total is cumulative billing usage; last is the context of the latest call.
  // Codex does not report session USD cost in this event.
  return snapshot("codex", sessionId, used, limit, null, updatedAt, source);
}

/** Only complete JSONL records in a bounded tail are considered. */
export function codexUsageTail(
  sessionId: string,
  text: string,
  modified: number,
): TerminalUsage | null {
  let result: TerminalUsage | null = null;
  for (const line of text.split("\n").slice(0, -1)) {
    try {
      const row = JSON.parse(line);
      if (row.type === "compacted") result = null;
      if (
        row.type !== "event_msg" ||
        row.payload?.type !== "token_count" ||
        !row.payload.info
      )
        continue;
      const info = row.payload.info;
      const stamp = Date.parse(row.timestamp);
      result = codexUsage(
        sessionId,
        {
          last: { totalTokens: info.last_token_usage?.total_tokens },
          modelContextWindow: info.model_context_window,
        },
        Number.isFinite(stamp) ? stamp : modified,
        "history",
      );
    } catch {
      /* Truncated first/last records and non-JSON diagnostics are ignored. */
    }
  }
  return result;
}

export function claudeUsageTail(
  sessionId: string,
  text: string,
  modified: number,
): TerminalUsage | null {
  let result: TerminalUsage | null = null;
  for (const line of text.split("\n").slice(0, -1)) {
    try {
      const row = JSON.parse(line);
      if (row.sessionId !== sessionId || row.isSidechain || row.agentId)
        continue;
      if (row.type === "system" && row.subtype === "compact_boundary")
        result = null;
      if (row.type !== "assistant" || !row.message?.usage) continue;
      const usage = row.message.usage;
      const parts = [
        usage.input_tokens,
        usage.cache_creation_input_tokens ?? 0,
        usage.cache_read_input_tokens ?? 0,
      ].map(count);
      if (parts.some((n) => n === null)) continue;
      const stamp = Date.parse(row.timestamp);
      result = snapshot(
        "claude",
        sessionId,
        count(parts.reduce<number>((sum, n) => sum + n!, 0)),
        null,
        null,
        Number.isFinite(stamp) ? stamp : modified,
        "history",
      );
    } catch {
      /* Ignore incomplete records. No model-name guesses for context limits/cost. */
    }
  }
  return result;
}

/** Independent of terminal/global state: no transcript renders or disk writes on updates. */
export class TerminalUsageStore {
  private values = new Map<string, TerminalUsage>();
  private reads = new Map<
    string,
    { time: number; pending: Promise<TerminalUsage | null> }
  >();
  put(terminalId: string, usage: TerminalUsage) {
    this.values.delete(terminalId);
    this.values.set(terminalId, usage);
    if (this.values.size > 256)
      this.values.delete(this.values.keys().next().value!);
  }
  clear(terminalId: string) {
    this.values.delete(terminalId);
    for (const key of this.reads.keys())
      if (key.startsWith(`${terminalId}\0`)) this.reads.delete(key);
  }
  compact(terminalId: string) {
    const previous = this.values.get(terminalId);
    this.clear(terminalId);
    if (previous)
      this.put(terminalId, {
        ...previous,
        usedTokens: null,
        usedPercent: null,
        updatedAt: Date.now(),
      });
  }
  async read(
    terminalId: string,
    provider: TerminalUsage["provider"],
    sessionId: string,
    fallback: () => Promise<TerminalUsage | null>,
  ) {
    const native = this.values.get(terminalId);
    const currentNative =
      native?.provider === provider && native.sessionId === sessionId
        ? native
        : undefined;
    if (currentNative && provider === "claude") return currentNative;
    const withNative = (value: TerminalUsage | null) => {
      const latest = this.values.get(terminalId);
      if (latest?.provider !== provider || latest.sessionId !== sessionId)
        return value;
      if (provider === "codex" && value)
        return {
          ...value,
          ...latest,
          model: latest.model ?? value.model,
          costUsd: latest.costUsd ?? value.costUsd,
          costSource: latest.costSource ?? value.costSource,
          costStatus: value.costStatus,
        };
      return latest;
    };
    const key = `${terminalId}\0${provider}\0${sessionId}`;
    const previous = this.reads.get(key);
    if (previous && Date.now() - previous.time < 2000)
      return previous.pending.then(withNative);
    const entry = {
      time: Number.POSITIVE_INFINITY,
      pending: Promise.resolve(null) as Promise<TerminalUsage | null>,
    };
    entry.pending = fallback()
      .then(withNative)
      .catch((error) => {
        const latest = this.values.get(terminalId);
        if (latest?.provider === provider && latest.sessionId === sessionId)
          return latest;
        throw error;
      })
      .finally(() => {
        entry.time = Date.now();
      });
    this.reads.delete(key);
    this.reads.set(key, entry);
    if (this.reads.size > 256)
      this.reads.delete(this.reads.keys().next().value!);
    return entry.pending;
  }
}
