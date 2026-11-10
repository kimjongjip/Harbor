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
  private activityItems = new Map<string, string>();

  private put(
    id: unknown,
    state: unknown,
    name?: unknown,
    model?: unknown,
    details: Partial<TerminalAgent> = {},
  ) {
    if (typeof id !== "string") return;
    const previous = this.agents.get(id);
    const next = terminalAgents([
      {
        ...previous,
        ...details,
        id,
        state: state ?? previous?.state,
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
    for (const key of this.activityItems.keys())
      if (!this.agents.has(key)) this.activityItems.delete(key);
    this.changed = true;
  }

  has(id: string) {
    return this.agents.has(id);
  }

  /** Only explicitly observed children of this parent may contribute telemetry. */
  observeChild(id: string, method: string, params: any): boolean {
    this.changed = false;
    if (!this.has(id)) return false;
    if (method === "thread/tokenUsage/updated") {
      const u = params.tokenUsage?.total;
      if (Number.isSafeInteger(u?.totalTokens) && u.totalTokens >= 0)
        this.put(id, undefined, undefined, undefined, {
          tokens: {
            total: u.totalTokens,
            input: u.inputTokens,
            output: u.outputTokens,
            cached: u.cachedInputTokens,
            scope: "session",
          },
        });
    } else if (method === "item/started") {
      const activity = agentActivity(params.item);
      if (activity && typeof params.item?.id === "string") {
        this.activityItems.set(id, params.item.id);
        this.put(id, "working", undefined, undefined, { activity });
      }
    } else if (
      method === "item/completed" &&
      this.activityItems.get(id) === params.item?.id
    ) {
      this.activityItems.delete(id);
      this.put(id, undefined, undefined, undefined, { activity: undefined });
    } else if (method === "turn/started") this.put(id, "working");
    else if (
      method === "turn/completed" &&
      ["completed", "failed", "interrupted"].includes(params.turn?.status)
    ) {
      this.activityItems.delete(id);
      this.put(
        id,
        params.turn?.status === "failed"
          ? "failed"
          : params.turn?.status === "interrupted"
            ? "stopped"
            : "completed",
        undefined,
        undefined,
        { activity: undefined },
      );
    }
    if (this.changed) this.updatedAt = Date.now();
    return this.changed;
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
      const task =
        ["spawnAgent", "followupTask", "resumeAgent"].includes(item.tool) &&
        typeof item.prompt === "string"
          ? item.prompt
          : undefined;
      if (states && typeof states === "object")
        for (const [id, value] of Object.entries(states).slice(0, 128))
          this.put(
            id,
            (value as any)?.status,
            undefined,
            item.model,
            task ? { task } : {},
          );
      // Completing a spawn tool is NOT completion of the child agent.
      // Older app-server versions supplied a single receiver and agentStatus.
      if (
        (item.newThreadId || item.receiverThreadId) &&
        item.agentStatus != null
      )
        this.put(
          item.newThreadId || item.receiverThreadId,
          item.agentStatus,
          undefined,
          item.model,
          task ? { task } : {},
        );
      for (const id of Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds.slice(0, 128)
        : [item.newThreadId || item.receiverThreadId].filter(Boolean)) {
        if (states?.[id] || item.agentStatus != null) continue;
        const spawned =
          item.tool === "spawnAgent" && item.status === "completed";
        const previous = this.agents.get(id);
        this.put(
          id,
          spawned && (!previous || previous.state === "unknown")
            ? "working"
            : previous?.state || "unknown",
          undefined,
          item.model,
          task ? { task } : {},
        );
      }
    } else if (item.type === "collab_agent_spawn_end") {
      this.put(
        item.new_thread_id,
        item.status,
        item.new_agent_nickname || item.new_agent_role,
        item.model,
        typeof item.prompt === "string" ? { task: item.prompt } : {},
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
      ? {
          agents: [...this.agents.values()],
          updatedAt: this.updatedAt,
          source,
          detailVersion: 1,
        }
      : undefined;
  }
}

/** Tool labels only; never retain command arguments, output, or reasoning text. */
export function agentActivity(item: any): string | undefined {
  if (item?.type === "commandExecution") return "명령 실행";
  if (item?.type === "fileChange") return "파일 수정";
  if (item?.type === "webSearch") return "자료 검색";
  if (item?.type === "mcpToolCall" || item?.type === "dynamicToolCall")
    return typeof item.tool === "string" ? item.tool.slice(0, 64) : "도구 실행";
  if (item?.type === "agentMessage") return "응답 작성";
  return undefined;
}
