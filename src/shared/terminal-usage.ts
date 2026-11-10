/** A provider-reported snapshot, never a sum of every request in a conversation. */
export interface TerminalUsage {
  provider: "codex" | "claude";
  sessionId: string;
  usedTokens: number | null;
  contextWindow: number | null;
  usedPercent: number | null;
  costUsd: number | null;
  updatedAt: number;
  source: "native" | "history";
}

export interface TerminalUsageResponse {
  usage: TerminalUsage | null;
}

export function compactTokens(value: number | null): string {
  if (value === null) return "—";
  const divisor = value >= 1_000_000 ? 1_000_000 : value >= 1_000 ? 1_000 : 1;
  const suffix = divisor === 1_000_000 ? "M" : divisor === 1_000 ? "k" : "";
  return `${Number((value / divisor).toFixed(1))}${suffix}`;
}
