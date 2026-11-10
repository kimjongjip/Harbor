import {
  terminalAgents,
  type TerminalCrewSnapshot,
} from "./terminal-agents.js";

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
  model?: string;
  contextEstimated?: boolean;
  compactLimit?: number;
  costSource?: "native" | "api-estimate";
  costStatus?: "loading" | "partial" | "unpriced";
  crew?: TerminalCrewSnapshot;
}

export interface TerminalUsageResponse {
  usage: TerminalUsage | null;
}

/** Shared by the native receiver and the read-only legacy-server fallback. */
export function claudeUsage(
  value: any,
  updatedAt = Date.now(),
): TerminalUsage | null {
  const count = (n: unknown): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (
    !value ||
    typeof value.session_id !== "string" ||
    !/^[A-Za-z0-9-]{1,256}$/.test(value.session_id)
  )
    return null;
  const context = value.context_window,
    current = context?.current_usage;
  const parts = [
    current?.input_tokens,
    current?.cache_creation_input_tokens ?? 0,
    current?.cache_read_input_tokens ?? 0,
  ];
  const used =
    current && parts.every(count) && count(parts.reduce((a, b) => a + b, 0))
      ? parts.reduce((a, b) => a + b, 0)
      : null;
  const window =
    count(context?.context_window_size) && context.context_window_size > 0
      ? context.context_window_size
      : null;
  const cost =
    typeof value.cost?.total_cost_usd === "number" &&
    Number.isFinite(value.cost.total_cost_usd) &&
    value.cost.total_cost_usd >= 0
      ? value.cost.total_cost_usd
      : null;
  const percent =
    current &&
    typeof context?.used_percentage === "number" &&
    context.used_percentage >= 0 &&
    context.used_percentage <= 100
      ? context.used_percentage
      : null;
  const agents = terminalAgents(value.harbor_agents);
  if (
    used === null &&
    window === null &&
    cost === null &&
    percent === null &&
    !agents
  )
    return null;
  const model = value.model?.id;
  return {
    provider: "claude",
    sessionId: value.session_id,
    usedTokens: used,
    contextWindow: window,
    usedPercent:
      used !== null && window !== null ? (used / window) * 100 : percent,
    costUsd: cost,
    updatedAt,
    source: "native",
    costSource: "native",
    ...(agents
      ? {
          crew: {
            agents,
            updatedAt,
            source: "native" as const,
            ...(value.harbor_agent_details === 1
              ? { detailVersion: 1 as const }
              : {}),
          },
        }
      : {}),
    ...(typeof model === "string" && /^[A-Za-z0-9._:[\]-]{1,150}$/.test(model)
      ? { model }
      : {}),
    ...(value.harbor_context_estimated === true
      ? { contextEstimated: true }
      : {}),
    ...(count(value.harbor_compact_limit) && value.harbor_compact_limit > 0
      ? { compactLimit: value.harbor_compact_limit }
      : {}),
  };
}

export function claudeUsageSnapshot(
  text: string,
  sessionId: string,
): TerminalUsage | null {
  if (text.length > 16384) return null;
  try {
    const value = JSON.parse(text);
    if (
      value.session_id !== sessionId ||
      !Number.isSafeInteger(value.harbor_updated_at) ||
      value.harbor_updated_at <= 0
    )
      return null;
    return claudeUsage(value, value.harbor_updated_at);
  } catch {
    return null;
  }
}

export function compactTokens(value: number | null): string {
  if (value === null) return "—";
  const divisor = value >= 1_000_000 ? 1_000_000 : value >= 1_000 ? 1_000 : 1;
  const suffix = divisor === 1_000_000 ? "M" : divisor === 1_000 ? "k" : "";
  return `${Number((value / divisor).toFixed(1))}${suffix}`;
}
