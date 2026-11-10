/** Public install sources only. Server-specific plugin state stays on that server. */
export const crewMod = {
  id: "agent-crew",
  name: "Agent Crew",
  marketplace: "kimjongjip/agent-crew",
  url: "https://github.com/kimjongjip/agent-crew",
  minimumVersion: "2.1.318",
} as const;
export interface ClaudeModsStatus {
  version: string;
  compatible: boolean;
  installed: boolean;
  enabled: boolean;
  pluginId?: string;
}
export interface ClaudeModsJob {
  id: string;
  hostId: string;
  status: "running" | "succeeded" | "failed";
  message: string;
  startedAt: number;
  updatedAt: number;
  result?: ClaudeModsStatus;
}
