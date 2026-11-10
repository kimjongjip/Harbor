import {
  terminalAgents,
  type TerminalAgent,
  type TerminalCrewSnapshot,
} from "../shared/terminal-agents.js";

/** Latest cumulative counts, not a sum of repeated token_count notifications. */
export function codexAgentTail(text: string): Partial<TerminalAgent> {
  const result: Partial<TerminalAgent> = {};
  for (const line of text
    .slice(-256 * 1024)
    .split("\n")
    .slice(0, -1)) {
    try {
      const row = JSON.parse(line),
        p = row.payload;
      if (row.type === "turn_context" && typeof p?.model === "string")
        result.model = p.model;
      if (row.type !== "event_msg" || p?.type !== "token_count") continue;
      const usage = p.info?.total_token_usage;
      if (Number.isSafeInteger(usage?.total_tokens) && usage.total_tokens >= 0)
        result.tokens = {
          total: usage.total_tokens,
          input: usage.input_tokens,
          output: usage.output_tokens,
          cached: usage.cached_input_tokens,
          scope: "session",
        };
    } catch {
      /* Ignore incomplete lines; never read a complete conversation. */
    }
  }
  return result;
}

type Child = {
  checkedAt: number;
  pending: boolean;
  state: string;
  details?: Partial<TerminalAgent>;
};
type Entry = { children: Map<string, Child>; cancelled?: boolean };

/** At most four bounded reads per poll; the parent UI never waits for child I/O. */
export class CodexAgentTelemetry {
  private entries = new Map<string, Entry>();
  private stopped = false;
  read(
    hostId: string,
    sessionId: string,
    crew: TerminalCrewSnapshot,
    lookup: (id: string) => Promise<{ path: string | null; task?: string }>,
    tail: (path: string) => Promise<string>,
  ): TerminalCrewSnapshot {
    if (this.stopped) return crew;
    const key = hostId + "\0" + sessionId;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { children: new Map() };
      this.entries.set(key, entry);
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > 32) {
      const old = this.entries.keys().next().value!;
      this.entries.get(old)!.cancelled = true;
      this.entries.delete(old);
    }
    const current = entry,
      ids = new Set(crew.agents.map((a) => a.id));
    for (const id of current.children.keys())
      if (!ids.has(id)) current.children.delete(id);
    let slots = Math.max(
      0,
      4 - [...current.children.values()].filter((c) => c.pending).length,
    );
    const now = Date.now();
    for (const agent of [...crew.agents].sort(
      (a, b) =>
        (current.children.get(a.id)?.checkedAt || 0) -
        (current.children.get(b.id)?.checkedAt || 0),
    )) {
      if (
        this.stopped ||
        !slots ||
        !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(agent.id)
      )
        continue;
      if (agent.tokens && agent.task) continue;
      const previous = current.children.get(agent.id);
      if (
        previous?.state === agent.state &&
        previous.details?.tokens &&
        ["completed", "failed", "stopped"].includes(agent.state)
      )
        continue;
      const interval =
        agent.state === "working" || agent.state === "waiting" ? 5000 : 30000;
      if (
        previous?.pending ||
        (previous &&
          previous.state === agent.state &&
          now - previous.checkedAt < interval)
      )
        continue;
      const child: Child = {
        ...previous,
        checkedAt: now,
        pending: true,
        state: agent.state,
      };
      current.children.set(agent.id, child);
      slots--;
      void (async () => {
        try {
          const metadata = await lookup(agent.id);
          if (
            current.cancelled ||
            this.stopped ||
            current.children.get(agent.id) !== child
          )
            return;
          const details = metadata.path
            ? codexAgentTail(await tail(metadata.path))
            : {};
          const clean = terminalAgents([
            { ...agent, ...details, task: agent.task || metadata.task },
          ])?.[0];
          if (
            !current.cancelled &&
            !this.stopped &&
            current.children.get(agent.id) === child &&
            clean
          )
            child.details = {
              tokens: clean.tokens,
              task: clean.task,
              model: clean.model,
            };
        } catch {
          /* Missing child usage stays missing, never zero or a parent total. */
        } finally {
          child.pending = false;
          child.checkedAt = Date.now();
        }
      })();
    }
    return {
      ...crew,
      detailVersion: 1,
      agents: crew.agents.map((agent) => {
        const saved = current.children.get(agent.id)?.details;
        return saved
          ? {
              ...agent,
              tokens: agent.tokens || saved.tokens,
              task: agent.task || saved.task,
              model: agent.model || saved.model,
            }
          : agent;
      }),
    };
  }
  clear(hostId: string) {
    for (const [key, entry] of this.entries)
      if (key.startsWith(hostId + "\0")) {
        entry.cancelled = true;
        this.entries.delete(key);
      }
  }
  shutdown() {
    this.stopped = true;
    for (const entry of this.entries.values()) entry.cancelled = true;
    this.entries.clear();
  }
}
