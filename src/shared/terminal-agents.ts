export type TerminalAgentState =
  | "working"
  | "waiting"
  | "idle"
  | "completed"
  | "failed"
  | "stopped"
  | "unknown";
export interface TerminalAgent {
  id: string;
  name: string;
  state: TerminalAgentState;
  model?: string;
  task?: string;
  activity?: string;
  tokens?: {
    total: number;
    input?: number;
    output?: number;
    cached?: number;
    scope: "session" | "observed";
  };
}
export interface TerminalCrewSnapshot {
  agents: TerminalAgent[];
  updatedAt: number;
  source: "native" | "history";
  detailVersion?: 1;
}
const label = (value: unknown, limit = 80) =>
  typeof value === "string"
    ? value
        .replace(/[\x00-\x1f\x7f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, limit)
    : "";
export function terminalAgentState(value: unknown): TerminalAgentState {
  if (typeof value === "object" && value !== null)
    value = Object.keys(value)[0];
  switch (value) {
    case "working":
    case "running":
    case "inProgress":
    case "pendingInit":
    case "pending_init":
      return "working";
    case "waiting":
      return "waiting";
    case "idle":
      return "idle";
    case "completed":
    case "done":
      return "completed";
    case "failed":
    case "errored":
      return "failed";
    case "killed":
    case "shutdown":
    case "interrupted":
    case "stopped":
      return "stopped";
    default:
      return "unknown";
  }
}
/** Bounded task labels and measured counts; no full transcript or tool results. */
export function terminalAgents(value: unknown): TerminalAgent[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const agents = new Map<string, TerminalAgent>();
  for (const row of value.slice(0, 128)) {
    if (
      !row ||
      typeof row.id !== "string" ||
      !/^[A-Za-z0-9_./:-]{1,128}$/.test(row.id)
    )
      continue;
    const model = label(row.model, 100);
    const task = label(row.task, 160),
      activity = label(row.activity, 96);
    const count = (n: unknown): n is number =>
      typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
    const usage = row.tokens;
    const tokens =
      usage &&
      count(usage.total) &&
      ["session", "observed"].includes(usage.scope)
        ? {
            total: usage.total,
            scope: usage.scope as "session" | "observed",
            ...(count(usage.input) ? { input: usage.input } : {}),
            ...(count(usage.output) ? { output: usage.output } : {}),
            ...(count(usage.cached) ? { cached: usage.cached } : {}),
          }
        : undefined;
    agents.set(row.id, {
      id: row.id,
      name: label(row.name) || label(row.type) || "에이전트",
      state: terminalAgentState(row.state ?? row.status),
      ...(model ? { model } : {}),
      ...(task ? { task } : {}),
      ...(activity ? { activity } : {}),
      ...(tokens ? { tokens } : {}),
    });
  }
  return [...agents.values()]
    .sort(
      (a, b) =>
        Number(b.state === "working" || b.state === "waiting") -
        Number(a.state === "working" || a.state === "waiting"),
    )
    .slice(0, 32);
}
