export type HostStatus = "disconnected" | "connecting" | "connected" | "error";
export type SessionStatus =
  "idle" | "running" | "waiting" | "error" | "offline";
export type PermissionMode = "read-only" | "workspace-write";
export type CliApprovalMode = "native" | "full-access";

export interface HostConfig {
  /** User-selected default for new terminals, never an instruction from a peer. */
  cliApprovalMode?: CliApprovalMode;
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
  /** Lazy reference to exact saved work output, scoped to its host and native session. */
  activityRef?: string;
  activityTruncated?: boolean;
  phase?: string;
  status?: string;
  /** Native turn outcome. Unknown/absent is never evidence that work finished. */
  turnStatus?:
    "completed" | "inProgress" | "failed" | "interrupted" | "unknown";
  imageCount?: number;
  /** A user-kind record the person did not type (slash command, notice, channel…). */
  origin?: import("./user-message-origin.js").UserMessageOrigin;
  /** Native tool call id pairing a call with its result. */
  toolUseId?: string;
  /** detail is a unified diff with hunk line numbers, or a created file's text. */
  format?: "diff" | "file";
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
export type TerminalConnectionIssue =
  | "network"
  | "timeout"
  | "authentication"
  | "forwarding"
  | "remote-missing"
  | "management"
  | "capability"
  | "transport"
  | "remote-exit"
  | "backend-stop";
export interface TerminalInfo {
  autoApproval?: {
    enabled: boolean;
    accepted: number;
    sessionId?: string;
    lastAcceptedAt?: number;
    detail?: string;
  };
  /** Launch-time setting; does not claim to observe later native CLI changes. */
  cliApprovalMode?: CliApprovalMode;
  id: string;
  startupPlaceholder?: boolean;
  hostId: string;
  cwd: string;
  title: string;
  exited: boolean;
  connectionState?:
    "connecting" | "connected" | "reconnecting" | "disconnected" | "exited";
  persistent?: boolean;
  persistenceDetail?: string;
  disconnectReason?: string;
  connectionIssue?: TerminalConnectionIssue;
  lastDisconnectedAt?: number;
  reconnectAttempt?: number;
  exitCode?: number;
  exitSignal?: string;
  program?: "shell" | "codex" | "resume" | "claude" | "claude-resume";
  agentKind?: "codex" | "claude";
  agentState?: "working" | "idle" | "waiting";
  agentSessionId?: string;
  /** Exact native Stop answer proof; contains no answer text and is not persisted. */
  agentCompletion?: { sessionId: string; textHash: string };
  integration?: "ready" | "unavailable";
  agentConnected?: boolean;
  peerDelivery?: "automatic" | "hook" | "poll" | "unavailable";
  peerDetail?: string;
  resumeThreadId?: string;
  researchSettings?: import("./research.js").ResearchAgentSettings;
}
export interface AppState {
  researchLabs?: import("./research.js").ResearchLabView[];
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
  | {
      type: "terminal-control";
      id: string;
      control: import("./mobile.js").TerminalControlView | null;
    }
  | { type: "terminal-resize"; id: string; cols: number; rows: number }
  | { type: "connection-heartbeat" }
  | import("./rich-terminal.js").RichTerminalEvent
  | { type: "state"; state: AppState }
  | { type: "session"; session: SessionView }
  | {
      type: "terminal-data";
      id: string;
      data: string;
      replay?: TerminalReplayMetadata;
    }
  | {
      type: "terminal-exit";
      id: string;
      exitCode: number;
      connectionIssue?: TerminalConnectionIssue;
      disconnectReason?: string;
      persistent?: boolean;
    }
  | { type: "error"; message: string };

export const sessionKey = (hostId: string, threadId: string) =>
  `${hostId}:${threadId}`;
