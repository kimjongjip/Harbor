export type ResearchPhase =
  "preparation" | "analysis" | "discussion" | "work" | "synthesis" | "verify";
export type ResearchStatus =
  | "preparing"
  | "connecting"
  | "running"
  | "paused"
  | "needs-input"
  | "completed";
export const researchEfforts = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type ResearchEffort = (typeof researchEfforts)[number];
export interface ResearchAgentSettings {
  model?: string;
  effort: ResearchEffort;
}
/** Capabilities returned by the selected server's authenticated native CLI. */
export interface ResearchModel {
  id: string;
  name: string;
  isDefault: boolean;
  efforts?: ResearchEffort[];
  defaultEffort?: ResearchEffort;
}
export function codexModelId(value: string) {
  // Correct the display-name shorthand without selecting a different model.
  return /^astra$/i.test(value.trim()) ? "gpt-6-astra" : value.trim();
}
export const researchEffortLabel: Record<ResearchEffort, string> = {
  default: "CLI 기본 설정",
  none: "없음 · none",
  minimal: "최소 · minimal",
  low: "낮음 · low",
  medium: "중간 · medium",
  high: "높음 · high",
  xhigh: "매우 높음 · xhigh",
  max: "최대 · max",
  ultra: "ultra",
};
export function researchEffortsFor(kind: "codex" | "claude") {
  return kind === "codex"
    ? researchEfforts
    : researchEfforts.filter(
        (effort) => !["none", "minimal", "ultra"].includes(effort),
      );
}
export interface ResearchProposal {
  goal: string;
  kind: "ideas" | "code" | "research";
  criteria: string[];
  context: string;
  updatedAt: number;
  source: "user" | "agent";
}
export interface ResearchConversation {
  text: string;
  sessionId: string;
  hostId: string;
  capturedAt: number;
  truncated: boolean;
  items: number;
}
export interface ResearchCriterion {
  id: string;
  text: string;
}
export interface ResearchAssessment {
  id: string;
  met: boolean;
  reason: string;
}
export interface ResearchReport {
  summary: string;
  bestResult?: string;
  criteria: ResearchAssessment[];
  issues: string[];
  nextActions: string[];
  ready: boolean;
  decision?: "approve" | "revise";
  /** Legacy peer question; no longer requests a user pause. */
  userQuestion?: string;
  /** Uncertainties for the peer to examine; these do not pause the lab. */
  peerQuestions?: string[];
  /** A research choice delegated to the peers, never a request to the user. */
  researchDecision?: { question: string; reason: string };
  userDecision?: ResearchUserDecision;
}
export interface ResearchUserDecision {
  kind: "scope-change" | "missing-information" | "external-approval";
  question: string;
  reason: string;
  /** A real, answered, scoped question sent by this participant to its peer. */
  peerMessageId: string;
  /** Required to pause for scope change; ordinary research pivots are delegated. */
  constraintChange?: {
    category: "hardware" | "budget" | "protected-resources";
    constraint: string;
    proposedChange: string;
  };
}
export const researchDecisionLabel = {
  "scope-change": "고정 제약 변경",
  "missing-information": "사용자만 제공할 수 있는 정보",
  "external-approval": "새로운 외부 작업 허가",
};
export interface ResearchParticipant {
  terminalId: string;
  hostId?: string;
  sessionId?: string;
  name: string;
  kind: "codex" | "claude";
  cwd: string;
  owned: boolean;
  settings?: ResearchAgentSettings;
}
export interface ResearchAssignment {
  id: string;
  participant: number;
  phase: ResearchPhase;
  revision: number;
  cycle: number;
  createdAt: number;
  messageIds: string[];
  report?: ResearchReport;
  reportedAt?: number;
  decisionAnswer?: { text: string; at: number };
}
export interface ResearchWork {
  id: string;
  assignmentId: string;
  participant: number;
  title: string;
  kind: "experiment" | "code" | "investigation";
  status: "running" | "completed" | "failed";
  command?: string;
  cwd?: string;
  revision?: string;
  exitCode?: number;
  metrics?: string;
  result?: string;
  artifacts: string[];
  resource?: string;
  evidence: "agent-reported";
  createdAt: number;
  updatedAt: number;
}
export interface ResearchEvent {
  id: string;
  at: number;
  text: string;
  participant?: number;
}
export interface ResearchLab {
  id: string;
  title: string;
  goal: string;
  kind: "ideas" | "code" | "research";
  cwd: string;
  hostId: string;
  effort: "default" | "low";
  status: ResearchStatus;
  phase: ResearchPhase;
  cycle: number;
  revision: number;
  criteria: ResearchCriterion[];
  participants: ResearchParticipant[];
  assignments: ResearchAssignment[];
  works: ResearchWork[];
  events: ResearchEvent[];
  bestResult: string;
  createdAt: number;
  updatedAt: number;
  attention?: string;
  pendingDecision?: ResearchUserDecision & {
    assignmentId: string;
    participant: number;
  };
  directives: string[];
  proposal?: ResearchProposal;
  conversation?: ResearchConversation;
  workspace?: { repository: string; baseline: string; branches: string[] };
  /** The authenticated native conversation that launched these two new participants. */
  manager?: ResearchManager;
}
export interface ResearchManager {
  terminalId: string;
  hostId: string;
  sessionId: string;
  kind: "codex" | "claude";
  name: string;
  requestId: string;
  fingerprint: string;
}
export interface ResearchPlanRequest {
  messageId: string;
  requestedAt: number;
  state: "queued" | "offered" | "consumed" | "saved";
  automatic: boolean;
}
export interface ResearchLabView extends ResearchLab {
  planRequest?: ResearchPlanRequest;
  participants: Array<
    ResearchParticipant & {
      connection:
        | "connecting"
        | "automatic"
        | "boundary"
        | "manual"
        | "offline"
        | "changed";
      activity?: "working" | "idle" | "waiting";
      delivery?: "queued" | "offered" | "consumed" | "reported";
    }
  >;
}
export const researchPhaseLabel: Record<ResearchPhase, string> = {
  preparation: "주제 준비",
  analysis: "각자 분석",
  discussion: "상호 검토",
  work: "조사·수정·실험",
  synthesis: "결과 정리",
  verify: "최종 검토",
};
export const researchStatusLabel: Record<ResearchStatus, string> = {
  preparing: "대화로 준비 중",
  connecting: "참여자 연결 중",
  running: "진행 중",
  paused: "일시정지",
  "needs-input": "확인 필요",
  completed: "완료",
};
