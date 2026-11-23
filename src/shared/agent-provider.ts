export type AgentProvider = "codex" | "claude" | "antigravity";
export const providerName = (provider: AgentProvider) =>
  ({ codex: "Codex", claude: "Claude", antigravity: "Antigravity" })[provider];
