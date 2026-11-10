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
}
export interface TerminalCrewSnapshot {
  agents: TerminalAgent[];
  updatedAt: number;
  source: "native" | "history";
}
const label = (value: unknown, limit = 80) =>
  typeof value === "string"
    ? value
        .replace(/[\x00-\x1f\x7f]/g, " ")
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
/** Display metadata only. Prompts, answers, tool arguments and credentials are never copied. */
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
    agents.set(row.id, {
      id: row.id,
      name: label(row.name) || label(row.type) || "에이전트",
      state: terminalAgentState(row.state ?? row.status),
      ...(model ? { model } : {}),
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
