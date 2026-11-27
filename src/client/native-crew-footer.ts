import type { TerminalAgent } from "../shared/terminal-agents";
import type { AgentProvider } from "../shared/agent-provider";

export interface NativeCrewRow {
  name: string;
  task: string;
  elapsed: string;
  tokens: string;
}
/** The terminal lists a role and changing activity rather than a child ID. */
export function nativeAgentModels(rows: NativeCrewRow[], roster: TerminalAgent[]) {
  const models = rows.map((): string | undefined => undefined);
  const active = roster.filter(a => a.state === "working" || a.state === "waiting" || a.state === "idle");
  for (const name of new Set(rows.map(row => row.name))) {
    const group = rows.map((row, index) => ({...row, index})).filter(row => row.name === name);
    let candidates = active.filter(agent => agent.name === name || agent.id === name);
    const remaining = group.filter(row => {
      const matches = candidates.filter(agent => agent.task === row.task);
      if (matches.length !== 1 || group.filter(other => other.task === row.task).length !== 1) return true;
      models[row.index] = matches[0].model;
      candidates = candidates.filter(agent => agent !== matches[0]);
      return false;
    });
    if (remaining.length === candidates.length && candidates.length && candidates.every(agent => agent.model === candidates[0].model))
      for (const row of remaining) models[row.index] = candidates[0].model;
  }
  return models;
}

export interface NativeCrewFooter {
  key: string;
  agents: NativeCrewRow[];
  taskCount?: number;
  start: number;
  end: number;
  suffixOffset?: number;
}

// Only recognize a complete native widget. Tool output and partially redrawn
// rosters remain in the reader until the sidebar can represent the same group.
export function nativeCrewFooter(provider: AgentProvider | undefined, lines: readonly string[]): NativeCrewFooter | undefined {
  if (provider === "antigravity") {
    let end = lines.length;
    while (end && !lines[end - 1].trim()) end--;
    for (let i = end - 1; i >= Math.max(0, end - 8); i--) {
      const m = /(?:\s*·\s*|^\s*)(\d+) task\(s\)\s*·\s*\/tasks\s*$/i.exec(lines[i]);
      if (m && /(?:\? for shortcuts|\b(?:auto|plan|manual|default)\s*·)/i.test(lines.slice(Math.max(0, i - 2), i + 1).join(" "))) {
        return { key: "agy-tasks", agents: [], taskCount: Number(m[1]), start: i, end: i+1, suffixOffset: m.index };
      }
    }
  }
  if (provider !== "claude") return;
  for (let i = lines.length - 1; i >= 0; i--) {
    const header = /^\s*\S\s+Waiting for (\d+) background agents? to finish\s*$/i.exec(lines[i]);
    const main = /^\s*[●◉]\s+main\s*$/i.test(lines[i]);
    if (!header && !main) continue;
    const expected = header ? Number(header[1]) : undefined;
    const agents: NativeCrewRow[] = [];
    let end = i + 1;
    for (; end < lines.length && agents.length < (expected ?? 32); end++) {
      if (!lines[end].trim()) {
        if (main && agents.length) break;
        continue;
      }
      const m = /^\s*[◯○●⏺]\s+(\S+)\s{2,}(.+?)\s{2,}((?:\d+(?:\.\d+)?[hms]\s*)+)\s*·\s*↓\s*([\d,.]+[kKmM]?)\s+tokens\s*$/u.exec(lines[end]);
      if (!m) break;
      agents.push({ name: m[1], task: m[2].trim(), elapsed: m[3].trim(), tokens: m[4] });
    }
    if (agents.length && (expected === undefined || agents.length === expected))
      return {key: JSON.stringify(agents.map(a => [a.name, a.task])), agents, start:i, end};
  }
}
