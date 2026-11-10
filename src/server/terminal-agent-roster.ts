import {
  terminalAgents,
  type TerminalAgent,
  type TerminalCrewSnapshot,
} from "../shared/terminal-agents.js";

/** Parent-thread telemetry only. Never loads or starts a child conversation. */
export class TerminalAgentRoster {
  private agents = new Map<string, TerminalAgent>();
  private updatedAt = 0;
  private changed = false;

  private put(id: unknown, state: unknown, name?: unknown, model?: unknown) {
    if (typeof id !== "string") return;
    const previous = this.agents.get(id);
    const next = terminalAgents([
      {
        id,
        state,
        name: name || previous?.name,
        model: model || previous?.model,
      },
    ])?.[0];
    if (!next || JSON.stringify(next) === JSON.stringify(previous)) return;
    this.agents.delete(id);
    // Keep active agents first and bound retained display metadata.
    this.agents = new Map(
      terminalAgents([next, ...this.agents.values()])!.map((agent) => [
        agent.id,
        agent,
      ]),
    );
    this.changed = true;
  }

  observe(item: any, stamp = Date.now()): boolean {
    this.changed = false;
    if (!item || typeof item !== "object") return false;
    if (
      item.type === "subAgentActivity" ||
      item.type === "sub_agent_activity"
    ) {
      const state = {
        started: "working",
        interacted: "working",
        interrupted: "stopped",
        completed: "completed",
      }[item.kind as string];
      const path = item.agentPath ?? item.agent_path;
      if (state)
        this.put(
          item.agentThreadId ?? item.agent_thread_id,
          state,
          typeof path === "string"
            ? path.split("/").filter(Boolean).pop()
            : undefined,
          item.model,
        );
    } else if (
      item.type === "collabAgentToolCall" ||
      item.type === "collabToolCall"
    ) {
      const states = item.agentsStates;
      if (states && typeof states === "object")
        for (const [id, value] of Object.entries(states).slice(0, 128))
          this.put(id, (value as any)?.status, undefined, item.model);
      // Completing a spawn tool is NOT completion of the child agent.
      // Older app-server versions supplied a single receiver and agentStatus.
      if (item.receiverThreadId && item.agentStatus != null)
        this.put(
          item.receiverThreadId,
          item.agentStatus,
          undefined,
          item.model,
        );
      for (const id of Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds.slice(0, 128)
        : []) {
        if (this.agents.has(id)) continue;
        const spawned =
          item.tool === "spawnAgent" && item.status === "completed";
        this.put(id, spawned ? "working" : "unknown", undefined, item.model);
      }
    } else if (item.type === "collab_agent_spawn_end") {
      this.put(
        item.new_thread_id,
        item.status,
        item.new_agent_nickname || item.new_agent_role,
        item.model,
      );
    } else if (
      [
        "collab_agent_interaction_end",
        "collab_resume_end",
        "collab_close_end",
      ].includes(item.type)
    ) {
      this.put(
        item.receiver_thread_id,
        item.type === "collab_close_end" ? "stopped" : item.status,
        item.receiver_agent_nickname || item.receiver_agent_role,
      );
    } else if (item.type === "collab_waiting_end") {
      for (const value of Array.isArray(item.agent_statuses)
        ? item.agent_statuses.slice(0, 128)
        : [])
        this.put(
          value.thread_id,
          value.status,
          value.agent_nickname || value.agent_role,
        );
      if (item.statuses && typeof item.statuses === "object")
        for (const [id, state] of Object.entries(item.statuses).slice(0, 128))
          this.put(id, state);
    }
    if (this.changed) this.updatedAt = stamp;
    return this.changed;
  }

  snapshot(
    source: TerminalCrewSnapshot["source"],
  ): TerminalCrewSnapshot | undefined {
    return this.updatedAt
      ? { agents: [...this.agents.values()], updatedAt: this.updatedAt, source }
      : undefined;
  }
}
