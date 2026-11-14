export interface QuotaWindow {
  label: string;
  remaining: number;
  resetsAt?: number;
}
export interface AccountQuota {
  provider: "codex" | "claude";
  account?: string;
  plan?: string;
  windows: QuotaWindow[];
  updatedAt: number;
  error?: string;
  stale?: boolean;
}
export interface CodexContextSettings {
  model: string;
  current: number | null;
  maximum: number | null;
  compactAt: number | null;
  postTurnPercent: number | null;
  profile?: string;
  customProvider?: boolean;
}
export interface TerminalWork {
  id: string;
  pid: number;
  kind: "gpu" | "simulator" | "monitor" | "background";
  task: string;
  memoryMiB?: number;
  state: "running" | "ended";
}
export interface TerminalWorkSnapshot {
  jobs: TerminalWork[];
  updatedAt: number;
  error?: string;
}
