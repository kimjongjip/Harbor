import type { AgentProvider } from "./agent-provider.js";

export type LabPhase = "answers" | "reviews" | "conclusion";
export type LabStepStatus =
  "pending" | "running" | "done" | "failed" | "interrupted";

export interface LabMember {
  hostId: string;
  provider: AgentProvider;
  model?: string;
}
export interface LabQuestionInput {
  requestId: string;
  question: string;
  material: string;
  debate: boolean;
  members: LabMember[];
  chair: number;
}
export interface LabReply {
  member: number;
  status: LabStepStatus;
  nativeId?: string;
  model?: string;
  text?: string;
  error?: string;
}
export interface LabQuestion extends LabQuestionInput {
  id: string;
  createdAt: number;
  phase: LabPhase;
  status: "working" | "ready" | "partial" | "stopped";
  answers: LabReply[];
  reviews: LabReply[];
  conclusion: LabReply[];
}
export type LabAction = "cancel" | "review" | "conclude" | "retry";
