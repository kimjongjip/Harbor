import type { TerminalInfo } from "./types";
import type { MessageItem } from "./types";

export interface MobileConversationPage {
  sessionId: string;
  provider: "codex" | "claude";
  items: Pick<MessageItem, "id" | "turnId" | "kind" | "text" | "imageCount">[];
  nextCursor: string | null;
  notice?: string;
}
import type { HarborRequest } from "./requests";
import type { ResearchLabView } from "./research";

export interface MobileState {
  viewer?: { deviceId: string; name: string; kind: "mobile" | "desktop" };
  controls?: Record<string, TerminalControlView>;
  runtimeId: string;
  hosts: { id: string; name: string; kind: "local" | "ssh" }[];
  terminals: TerminalInfo[];
  requests: HarborRequest[];
  labs: Pick<
    ResearchLabView,
    | "id"
    | "title"
    | "goal"
    | "status"
    | "phase"
    | "participants"
    | "bestResult"
    | "attention"
  >[];
}
export interface MobileSettings {
  mode?: "private" | "funnel";
  enabled: boolean;
  origin: string;
  port: number;
  listening: boolean;
  error?: string;
  devices: {
    kind?: "mobile" | "desktop";
    id: string;
    name: string;
    createdAt: number;
    expiresAt: number;
    notifications: boolean;
  }[];
}
export interface TerminalControlView {
  clientId: string;
  deviceName: string;
  expiresAt: number;
}
export interface MobileNetworkStatus {
  origin: string;
  mode?: "private" | "funnel";
  connected: boolean;
  conflict: boolean;
  approvalUrl?: string;
  error?: string;
}
