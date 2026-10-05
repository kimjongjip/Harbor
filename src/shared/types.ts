export type HostStatus = "disconnected" | "connecting" | "connected" | "error";
export type SessionStatus =
  "idle" | "running" | "waiting" | "error" | "offline";
export type PermissionMode = "read-only" | "workspace-write";

export interface HostConfig {
  id: string;
  name: string;
  kind: "local" | "ssh";
  address: string;
  username: string;
  port: number;
  identityFile: string;
  codexPath: string;
  defaultCwd: string;
  mode: "auto" | "shared" | "isolated";
  color: string;
  createdAt: number;
}
export interface ModelOption {
  id: string;
  name: string;
  isDefault: boolean;
}
export interface HostView extends HostConfig {
  status: HostStatus;
  error?: string;
  transport?: "shared" | "isolated";
  models: ModelOption[];
  hasSavedPassword?: boolean;
  terminalConnected?: boolean;
}
export interface SessionMeta {
  id: string;
  hostId: string;
  threadId: string;
  title: string;
  cwd: string;
  model: string;
  permission: PermissionMode;
  createdAt: number;
  updatedAt: number;
  imported?: boolean;
  pinned?: boolean;
}
export interface SessionSummary extends SessionMeta {
  status: SessionStatus;
  preview: string;
  activeTurnId?: string;
  loaded: boolean;
  error?: string;
  jobId?: string;
}
export interface MessageItem {
  id: string;
  turnId?: string;
  kind:
    "user" | "assistant" | "command" | "change" | "plan" | "tool" | "notice";
  text: string;
  detail?: string;
  phase?: string;
  status?: string;
  imageCount?: number;
}

export interface FileEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  size: number;
  modifiedAt: number;
  mode: number;
}
export interface DirectoryView {
  path: string;
  parent: string;
  entries: FileEntry[];
  truncated: boolean;
}
export interface Question {
  id: string;
  header?: string;
  question: string;
  options?: { label: string; description?: string }[];
}
export interface Approval {
  id: string;
  requestId: string | number;
  method: string;
  kind: "command" | "file" | "question" | "permissions" | "unsupported";
  title: string;
  detail: string;
  questions?: Question[];
}
export interface SessionView extends SessionSummary {
  items: MessageItem[];
  approvals: Approval[];
  historyCursor?: string | null;
}
export interface Activity {
  id: string;
  type: "session" | "connection" | "transfer" | "discussion" | "error";
  text: string;
  at: number;
  sessionId?: string;
}
export interface Transfer {
  id: string;
  fromId: string;
  toId: string;
  kind: "context" | "review";
  text: string;
  createdAt: number;
}
export interface Discussion {
  id: string;
  topic: string;
  sessionIds: [string, string];
  status: "running" | "completed" | "failed" | "cancelled";
  steps: { sessionId: string; label: string; text: string }[];
  error?: string;
  createdAt: number;
}
export interface TerminalColors {
  foreground: string;
  background: string;
}
export interface TerminalInfo {
  id: string;
  hostId: string;
  cwd: string;
  title: string;
  exited: boolean;
  program?: "shell" | "codex" | "resume" | "claude" | "claude-resume";
  agentKind?: "codex" | "claude";
  agentState?: "working" | "idle" | "waiting";
  agentSessionId?: string;
  integration?: "ready" | "unavailable";
  agentConnected?: boolean;
  resumeThreadId?: string;
}
export interface AppState {
  requests?: import("./requests.js").HarborRequest[];
  connections?: import("./requests.js").HarborConnection[];
  notices?: import("./notices.js").TerminalNotice[];
  mailbox?: import("./mailbox.js").MailboxMessage[];
  hosts: HostView[];
  sessions: SessionSummary[];
  activities: Activity[];
  transfers: Transfer[];
  discussions: Discussion[];
  terminals: TerminalInfo[];
}
export interface TerminalReplayMetadata {
  /** Complete emulator state; data is a canonical snapshot, not a raw tail. */
  snapshot?: boolean;
  cols: number;
  rows: number;
  /** UTF-16 offsets into the same terminal-data packet's data string. */
  resizes: { offset: number; cols: number; rows: number }[];
  truncated?: boolean;
}
export type ServerEvent =
  | { type: "state"; state: AppState }
  | { type: "session"; session: SessionView }
  | {
      type: "terminal-data";
      id: string;
      data: string;
      replay?: TerminalReplayMetadata;
    }
  | { type: "terminal-exit"; id: string; exitCode: number }
  | { type: "error"; message: string };

export const sessionKey = (hostId: string, threadId: string) =>
  `${hostId}:${threadId}`;
