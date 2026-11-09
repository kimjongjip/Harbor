import { EventEmitter } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { realpath, stat, readFile } from "node:fs/promises";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { z } from "zod";
import type { HostConfig, TerminalInfo } from "../shared/types.js";
import type {
  ResearchLab,
  ResearchLabView,
  ResearchAssignment,
  ResearchReport,
  ResearchPhase,
  ResearchWork,
  ResearchPlanRequest,
} from "../shared/research.js";
import { researchPhaseLabel } from "../shared/research.js";
import { Mailbox } from "./mailbox.js";
import type { PeerRuntimeStatus } from "./peer-delivery.js";
import {
  researchSettings,
  researchSettingsSchema,
} from "./research-settings.js";

const id = z.string().min(1).max(256);
const text = z.string().trim().min(1).max(8000);
const userDecisionSchema = z
  .object({
    kind: z.enum(["scope-change", "missing-information", "external-approval"]),
    question: z.string().trim().min(1).max(2000),
    reason: z.string().trim().min(1).max(2000),
    peerMessageId: id,
    constraintChange: z
      .object({
        category: z.enum(["hardware", "budget", "protected-resources"]),
        constraint: z.string().trim().min(8).max(1000),
        proposedChange: z.string().trim().min(1).max(2000),
      })
      .strict()
      .optional(),
  })
  .strict();
export const researchReportSchema = z
  .object({
    summary: text,
    bestResult: z.string().trim().max(16000).optional(),
    criteria: z
      .array(z.object({ id, met: z.boolean(), reason: text }))
      .min(1)
      .max(12),
    issues: z.array(text).max(12).default([]),
    nextActions: z.array(text).max(12).default([]),
    ready: z.boolean(),
    decision: z.enum(["approve", "revise"]).optional(),
    userQuestion: z.string().trim().max(2000).optional(),
    peerQuestions: z
      .array(z.string().trim().min(1).max(2000))
      .max(4)
      .default([]),
    userDecision: userDecisionSchema.optional(),
    researchDecision: z
      .object({
        question: z.string().trim().min(1).max(2000),
        reason: z.string().trim().min(1).max(2000),
      })
      .strict()
      .optional(),
  })
  .strict();
export const researchWorkSchema = z
  .object({
    labId: id,
    assignmentId: id,
    workId: id.optional(),
    title: z.string().trim().min(1).max(300),
    kind: z.enum(["experiment", "code", "investigation"]),
    status: z.enum(["running", "completed", "failed"]),
    command: z.string().max(4000).optional(),
    cwd: z.string().max(4096).optional(),
    revision: z.string().max(300).optional(),
    exitCode: z.number().int().optional(),
    metrics: z.string().max(4000).optional(),
    result: z.string().max(8000).optional(),
    artifacts: z.array(z.string().min(1).max(4096)).max(24).default([]),
    resource: z.string().trim().max(100).optional(),
  })
  .strict();
export const researchArtifactSchema = z
  .object({
    labId: id,
    workId: id,
    path: z.string().min(1).max(4096),
    startLine: z.number().int().min(1).default(1),
  })
  .strict();
export const researchCreateSchema = z
  .object({
    hostId: id.optional(),
    title: z.string().trim().min(1).max(180),
    goal: text,
    kind: z.enum(["ideas", "code", "research"]).default("ideas"),
    cwd: z.string().trim().min(1).max(4096),
    criteria: z.array(z.string().trim().min(1).max(1000)).min(1).max(12),
    effort: z.enum(["default", "low"]).default("default"),
    terminalIds: z.tuple([id, id]).optional(),
  })
  .strict();

export const researchPrepareSchema = z
  .object({
    hostId: id.optional(),
    title: z.string().trim().min(1).max(180).default("새 연구실"),
    cwd: z.string().trim().min(1).max(4096),
    leadKind: z.enum(["codex", "claude"]).default("claude"),
    effort: z.enum(["default", "low"]).default("low"),
    terminalId: id.optional(),
    agentSettings: researchSettingsSchema.optional(),
  })
  .strict();
export const researchProposalSchema = z
  .object({
    goal: text,
    kind: z.enum(["ideas", "code", "research"]),
    criteria: z.array(z.string().trim().min(1).max(1000)).min(1).max(12),
    context: z.string().trim().max(16000).default(""),
  })
  .strict();
export const researchStartSchema = researchProposalSchema
  .extend({
    partnerKind: z.enum(["codex", "claude"]).default("codex"),
    partnerHostId: id.optional(),
    partnerTerminalId: id.optional(),
    partnerCwd: z.string().trim().min(1).max(4096).optional(),
    partnerSettings: researchSettingsSchema.optional(),
    manualContext: z.boolean().default(false),
    revision: z.number().int().min(1),
  })
  .strict();

const phaseSchema = z.enum([
  "preparation",
  "analysis",
  "discussion",
  "work",
  "synthesis",
  "verify",
]);
const participantSchema = z.object({
  terminalId: id,
  hostId: id.optional(),
  sessionId: id.optional(),
  name: z.string().max(200),
  kind: z.enum(["codex", "claude"]),
  cwd: z.string().max(4096),
  owned: z.boolean(),
  settings: researchSettingsSchema.optional(),
});
const assignmentSchema = z.object({
  id,
  participant: z.number().int().min(0).max(1),
  phase: phaseSchema,
  revision: z.number().int().nonnegative(),
  cycle: z.number().int().nonnegative(),
  createdAt: z.number(),
  messageIds: z.array(id),
  report: researchReportSchema.optional(),
  reportedAt: z.number().optional(),
  decisionAnswer: z
    .object({ text: z.string().max(4000), at: z.number() })
    .optional(),
});
const workSchema = researchWorkSchema
  .omit({ labId: true, workId: true })
  .extend({
    id,
    participant: z.number().int().min(0).max(1),
    evidence: z.literal("agent-reported"),
    createdAt: z.number(),
    updatedAt: z.number(),
  });
const labSchema = z
  .object({
    id,
    title: z.string().max(180),
    goal: z.string().trim().max(8000),
    kind: z.enum(["ideas", "code", "research"]),
    cwd: z.string().max(4096),
    hostId: id,
    effort: z.enum(["default", "low"]),
    status: z.enum([
      "preparing",
      "connecting",
      "running",
      "paused",
      "needs-input",
      "completed",
    ]),
    phase: phaseSchema,
    cycle: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    criteria: z.array(z.object({ id, text: z.string().max(1000) })).max(12),
    participants: z.array(participantSchema).min(1).max(2),
    assignments: z.array(assignmentSchema),
    works: z.array(workSchema),
    events: z.array(
      z.object({
        id,
        at: z.number(),
        text: z.string().max(2000),
        participant: z.number().optional(),
      }),
    ),
    bestResult: z.string().max(16000),
    manager: z
      .object({
        terminalId: id,
        hostId: id,
        sessionId: id,
        kind: z.enum(["codex", "claude"]),
        name: z.string().max(200),
        requestId: id,
        fingerprint: z.string().length(64),
      })
      .optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    attention: z.string().max(2000).optional(),
    pendingDecision: userDecisionSchema
      .extend({
        assignmentId: id,
        participant: z.number().int().min(0).max(1),
      })
      .optional(),
    directives: z.array(z.string().max(4000)),
    proposal: researchProposalSchema
      .extend({
        updatedAt: z.number(),
        source: z.enum(["user", "agent"]),
      })
      .optional(),
    conversation: z
      .object({
        text: z.string().max(32000),
        sessionId: id,
        hostId: id,
        capturedAt: z.number(),
        truncated: z.boolean(),
        items: z.number().int().nonnegative(),
      })
      .optional(),
    workspace: z
      .object({
        repository: z.string(),
        baseline: z.string(),
        branches: z.array(z.string()),
      })
      .optional(),
  })
  .superRefine((lab, context) => {
    if (
      lab.status === "preparing"
        ? lab.phase !== "preparation" || lab.participants.length !== 1
        : lab.phase === "preparation" ||
          lab.participants.length !== 2 ||
          !lab.goal.trim() ||
          !lab.criteria.length
    )
      context.addIssue({
        code: "custom",
        message: "Invalid research preparation/assignment state",
      });
  });
interface Options {
  terminal(id: string): TerminalInfo | undefined;
  host(id: string): Pick<HostConfig, "id" | "kind"> | undefined;
  runtime(id: string): PeerRuntimeStatus | undefined;
  artifact?(
    hostId: string,
    root: string,
    cwd: string,
    filename: string,
  ): Promise<{ path: string; bytes: Buffer }>;
}

/** The scheduler owns transitions, while the two native conversations own reasoning and execution. */
export class ResearchLabs extends EventEmitter {
  private labs: ResearchLab[] = [];
  private readonly file: string;
  private ticking = false;
  constructor(
    directory: string,
    private readonly mailbox: Mailbox,
    private readonly options: Options,
  ) {
    super();
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, "research.json");
    try {
      if (statSync(this.file).size > 32 * 1024 * 1024)
        throw new Error("연구실 기록이 너무 큽니다.");
      const saved = z
        .object({ version: z.literal(1), labs: z.array(labSchema).max(100) })
        .parse(JSON.parse(readFileSync(this.file, "utf8")));
      this.labs = saved.labs;
      for (const lab of this.labs)
        for (const participant of lab.participants)
          participant.hostId ??= lab.hostId;
      for (const lab of this.labs) {
        for (const job of lab.assignments)
          if (job.report && !job.decisionAnswer)
            job.report = this.delegateDecision(job.report);
        if (
          lab.pendingDecision?.kind === "scope-change" &&
          !lab.pendingDecision.constraintChange
        ) {
          const job = lab.assignments.find(
            (j) => j.id === lab.pendingDecision!.assignmentId,
          );
          if (job?.report && !job.report.researchDecision)
            job.report.researchDecision = {
              question: lab.pendingDecision.question,
              reason: lab.pendingDecision.reason,
            };
          delete lab.pendingDecision;
          lab.status = "paused";
          lab.attention =
            "이전 연구 방향 질문을 AI끼리 결정하도록 전환했습니다. 원래 대화를 연결하고 계속 진행하면 기존 분석에서 이어갑니다.";
          this.event(lab, lab.attention);
        } else if (
          lab.status === "needs-input" &&
          !lab.pendingDecision &&
          lab.attention?.startsWith(
            "같은 판단과 다음 행동이 반복되고 있습니다.",
          )
        ) {
          lab.status = "paused";
          lab.attention =
            "반복 검토 기록을 보존했습니다. 원래 대화를 연결하고 계속하면 AI끼리 다른 접근과 새 근거를 선택합니다.";
          this.event(lab, lab.attention);
        }
      }
      // Restart never silently resumes live work or assumes old terminals are alive.
      for (const lab of this.labs)
        if (
          lab.status === "needs-input" &&
          !lab.pendingDecision &&
          this.current(lab).some(
            (j) => j.report?.userQuestion === lab.attention,
          )
        ) {
          lab.status = "paused";
          lab.attention =
            "이전 질문과 분석을 보존했습니다. 원래 대화를 연결하고 계속하면 AI끼리 검토합니다.";
          this.event(lab, lab.attention);
        }
      for (const lab of this.labs)
        if (["running", "connecting"].includes(lab.status)) {
          lab.status = "paused";
          lab.attention =
            "앱이 다시 시작되었습니다. 원래 대화에 재연결한 뒤 계속하세요.";
          this.event(lab, lab.attention);
        }
      this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  list(): ResearchLabView[] {
    return this.labs
      .slice()
      .reverse()
      .map((lab) => ({
        ...structuredClone(lab),
        ...(lab.status === "preparing"
          ? { planRequest: this.planRequest(lab) }
          : {}),
        participants: lab.participants.map((participant, i) => {
          const terminal = this.options.terminal(participant.terminalId);
          const runtime = this.options.runtime(participant.terminalId);
          const job = this.current(lab).find((j) => j.participant === i);
          const messages =
            job?.messageIds
              .map((id) => this.mailbox.find(id))
              .filter(Boolean) || [];
          return {
            ...participant,
            connection:
              !terminal || terminal.exited || runtime?.state === "offline"
                ? ("offline" as const)
                : participant.sessionId &&
                    runtime?.sessionId &&
                    participant.sessionId !== runtime.sessionId
                  ? ("changed" as const)
                  : !runtime?.sessionId
                    ? ("connecting" as const)
                    : runtime.delivery === "automatic"
                      ? ("automatic" as const)
                      : runtime.kind === "claude" && runtime.delivery === "hook"
                        ? ("boundary" as const)
                        : ("manual" as const),
            activity: terminal?.agentState,
            delivery: job?.report
              ? ("reported" as const)
              : messages.some((m) => m?.consumedAt)
                ? ("consumed" as const)
                : messages.some((m) => m?.offeredAt)
                  ? ("offered" as const)
                  : messages.length
                    ? ("queued" as const)
                    : undefined,
          };
        }),
      }));
  }
  get(labId: string): ResearchLab {
    const lab = this.labs.find((l) => l.id === labId);
    if (!lab) throw new Error("연구 과제를 찾을 수 없습니다.");
    return structuredClone(lab);
  }

  peerScope(
    from: string,
    sessionId: string | undefined,
    to: string,
    targetSessionId: string | undefined,
  ): string | undefined {
    const lab = this.labs.find(
      (l) =>
        l.status !== "completed" &&
        l.participants.some(
          (p) => p.terminalId === from && p.sessionId === sessionId,
        ) &&
        l.participants.some(
          (p) => p.terminalId === to && p.sessionId === targetSessionId,
        ),
    );
    if (!lab) return;
    return lab.id;
  }

  create(
    input: z.infer<typeof researchCreateSchema>,
    participants: ResearchLab["participants"],
    workspace?: ResearchLab["workspace"],
    managed?: { manager: NonNullable<ResearchLab["manager"]>; context: string },
  ): ResearchLab {
    const parsed = researchCreateSchema.parse(input);
    if (this.labs.length >= 100)
      throw new Error("연구실은 최대 100개까지 보관할 수 있습니다.");
    if (
      participants.length !== 2 ||
      participants[0].terminalId === participants[1].terminalId
    )
      throw new Error("서로 다른 두 AI 세션을 선택하세요.");
    const hostId = this.validateParticipants(participants);
    if (parsed.hostId && parsed.hostId !== hostId)
      throw new Error("프로젝트 서버와 첫 참여자의 서버가 일치해야 합니다.");
    participants = participants.map((p) => ({
      ...p,
      hostId: this.options.terminal(p.terminalId)!.hostId,
    }));
    if (
      this.labs.some(
        (l) =>
          l.status !== "completed" &&
          l.participants.some((p) =>
            participants.some((q) => q.terminalId === p.terminalId),
          ),
      )
    )
      throw new Error("이 세션은 다른 연구 과제에 참여 중입니다.");
    const now = Date.now();
    const lab: ResearchLab = {
      id: randomUUID(),
      title: parsed.title,
      goal: parsed.goal,
      kind: parsed.kind,
      cwd: parsed.cwd,
      hostId,
      effort: parsed.effort,
      criteria: parsed.criteria.map((text, i) => ({ id: `c${i + 1}`, text })),
      participants: structuredClone(participants),
      status: "connecting",
      phase: "analysis",
      cycle: 0,
      revision: 1,
      assignments: [],
      works: [],
      events: [],
      bestResult: "",
      directives: [],
      createdAt: now,
      updatedAt: now,
      ...(workspace ? { workspace } : {}),
      ...(managed
        ? {
            manager: structuredClone(managed.manager),
            proposal: {
              goal: parsed.goal,
              kind: parsed.kind,
              criteria: parsed.criteria,
              context: managed.context,
              source: "agent",
              updatedAt: now,
            } as const,
          }
        : {}),
    };
    this.event(lab, "과제를 시작했습니다. 두 AI가 먼저 독립적으로 판단합니다.");
    this.labs.push(lab);
    this.persist();
    this.emit("change");
    this.tick();
    return this.get(lab.id);
  }

  private validateParticipants(
    participants: ResearchLab["participants"],
  ): string {
    const terminals = participants.map((p) =>
      this.options.terminal(p.terminalId),
    );
    if (terminals.some((t) => !t || t.exited))
      throw new Error("열려 있는 두 AI 터미널을 선택하세요.");
    const hostId = terminals[0]!.hostId;
    if (terminals.some((t) => !this.options.host(t!.hostId)))
      throw new Error("참여자의 서버를 찾을 수 없습니다.");
    participants.forEach((p, i) => {
      if (p.hostId && p.hostId !== terminals[i]!.hostId)
        throw new Error("원래 대화가 속한 서버의 세션만 연결할 수 있습니다.");
      const actual =
        this.options.runtime(p.terminalId)?.kind ||
        terminals[i]!.agentKind ||
        (terminals[i]!.program?.startsWith("claude")
          ? "claude"
          : terminals[i]!.program === "codex" ||
              terminals[i]!.program === "resume"
            ? "codex"
            : undefined);
      if (actual !== p.kind)
        throw new Error("실행 중인 Codex 또는 Claude 세션을 선택하세요.");
    });
    return hostId;
  }

  prepare(
    input: z.infer<typeof researchPrepareSchema>,
    participant: ResearchLab["participants"][number],
  ) {
    const parsed = researchPrepareSchema.parse(input);
    if (!participant.owned && parsed.agentSettings)
      throw new Error("기존 대화의 모델·effort는 해당 CLI에서 변경하세요.");
    const settings = participant.owned
      ? researchSettings(participant.kind, parsed.agentSettings, parsed.effort)
      : participant.settings;
    if (this.labs.length >= 100)
      throw new Error("연구실은 100개까지 보관할 수 있습니다.");
    const hostId = this.validateParticipants([participant]);
    if (parsed.hostId && parsed.hostId !== hostId)
      throw new Error("선택한 대화의 서버가 다릅니다.");
    this.available(participant.terminalId);
    const now = Date.now();
    const runtime = this.options.runtime(participant.terminalId);
    const lab: ResearchLab = {
      id: randomUUID(),
      title: parsed.title,
      goal: "",
      kind: "ideas",
      cwd: parsed.cwd,
      hostId,
      effort: parsed.effort,
      status: "preparing",
      phase: "preparation",
      cycle: 0,
      revision: 1,
      criteria: [],
      participants: [
        {
          ...participant,
          hostId,
          ...(settings ? { settings } : {}),
          sessionId: runtime?.sessionId || participant.sessionId,
        },
      ],
      assignments: [],
      works: [],
      events: [],
      bestResult: "",
      createdAt: now,
      updatedAt: now,
      directives: [],
    };
    this.event(
      lab,
      "먼저 한 AI와 대화하며 주제를 준비합니다. 공동 작업은 사용자가 시작할 때만 배정합니다.",
    );
    this.labs.push(lab);
    this.persist();
    this.emit("change");
    this.tick();
    return this.get(lab.id);
  }

  private available(terminalId: string, exceptId?: string) {
    const terminal = this.options.terminal(terminalId),
      runtime = this.options.runtime(terminalId);
    const nativeId =
      runtime?.sessionId ||
      terminal?.agentSessionId ||
      terminal?.resumeThreadId;
    if (
      this.labs.some(
        (l) =>
          l.id !== exceptId &&
          l.status !== "completed" &&
          l.participants.some(
            (p) =>
              p.terminalId === terminalId ||
              (nativeId &&
                p.sessionId === nativeId &&
                (p.hostId || l.hostId) === terminal?.hostId &&
                p.kind === (runtime?.kind || terminal?.agentKind)),
          ),
      )
    )
      throw new Error("이 대화는 이미 다른 연구실에 참여하고 있습니다.");
  }

  preparing(labId: string) {
    this.tick();
    const lab = this.get(labId),
      lead = lab.participants[0];
    if (lab.status !== "preparing")
      throw new Error("주제 준비 중인 연구실이 아닙니다.");
    this.member(lead.terminalId, lead.sessionId, labId);
    return lab;
  }

  removePreparation(labId: string) {
    const lab = this.get(labId);
    if (lab.status !== "preparing")
      throw new Error("준비 중인 연구실만 삭제할 수 있습니다.");
    this.remove([labId]);
    return { removed: true };
  }

  remove(labIds: string[]) {
    const ids = new Set(z.array(id).min(1).max(100).parse(labIds));
    const selected = this.labs.filter((lab) => ids.has(lab.id));
    for (const lab of selected) {
      const liveWork = lab.works.find((work) => {
        if (work.status !== "running") return false;
        const owner = lab.participants[work.participant];
        const terminal = owner && this.options.terminal(owner.terminalId);
        return terminal && !terminal.exited;
      });
      if (liveWork)
        throw new Error(
          `“${lab.title}”에 실행 중으로 등록된 작업 “${liveWork.title}”이 있습니다. 작업 결과를 등록하거나 해당 터미널에서 작업을 중단하고 터미널을 닫은 뒤 삭제하세요.`,
        );
    }
    const previous = this.labs;
    if (selected.length) {
      this.labs = this.labs.filter((lab) => !ids.has(lab.id));
      try {
        this.persist();
      } catch (error) {
        this.labs = previous;
        throw error;
      }
    }
    // Remove the lab before mailbox callbacks can dispatch another assignment.
    // Retrying missing IDs also cleans up messages after a mailbox write failure.
    const messagesRemoved = this.mailbox.removeForLabs([...ids]);
    if (selected.length || messagesRemoved) this.emit("change");
    return { removed: selected.length, messagesRemoved };
  }

  proposal(
    labId: string,
    input: unknown,
    source: "user" | "agent" = "user",
    revision?: number,
  ) {
    const lab = this.labs.find((l) => l.id === labId);
    if (!lab || lab.status !== "preparing")
      throw new Error("주제 준비 중인 연구실에서만 계획을 저장할 수 있습니다.");
    if (revision !== undefined && revision !== lab.revision)
      throw new Error("계획이 변경되었습니다. 최신 계획을 확인하세요.");
    lab.proposal = {
      ...researchProposalSchema.parse(input),
      source,
      updatedAt: Date.now(),
    };
    lab.revision++;
    this.event(
      lab,
      `${source === "agent" ? "주 대화의 AI가" : "사용자가"} 공동 작업 계획을 저장했습니다. 아직 공동 작업을 시작하지 않았습니다.`,
    );
    this.persist();
    this.emit("change");
    return this.get(labId);
  }

  plan(
    terminalId: string,
    sessionId: string | undefined,
    labId: string,
    input: unknown,
  ) {
    const lab = this.member(terminalId, sessionId, labId);
    if (lab.participants[0].terminalId !== terminalId)
      throw new Error("주 대화에서만 계획을 제안할 수 있습니다.");
    this.proposal(lab.id, input, "agent");
    return {
      saved: true,
      labId,
      next: "The proposal is saved for the user to review. Continue the native conversation. Only the user can start joint work in Harbor; do not create assignments, run experiments or claim that another AI has joined.",
    };
  }

  private planRequest(lab: ResearchLab): ResearchPlanRequest | undefined {
    const p = lab.participants[0];
    const message = this.mailbox
      .list(p.terminalId)
      .find(
        (m) =>
          m.research?.assignmentId === `preparation:${lab.id}` &&
          m.recipient.terminalId === p.terminalId &&
          m.recipient.sessionId === p.sessionId,
      );
    if (!message) return;
    return {
      messageId: message.id,
      requestedAt: message.createdAt,
      state:
        lab.proposal?.source === "agent" &&
        lab.proposal.updatedAt >= message.createdAt
          ? "saved"
          : message.consumedAt
            ? "consumed"
            : message.offeredAt
              ? "offered"
              : "queued",
      automatic: this.options.runtime(p.terminalId)?.delivery === "automatic",
    };
  }

  requestPlan(labId: string) {
    const lab = this.get(labId);
    if (lab.status !== "preparing")
      throw new Error("주제 준비 중에만 계획 정리를 요청할 수 있습니다.");
    const p = lab.participants[0];
    this.member(p.terminalId, p.sessionId, lab.id);
    const pending = this.mailbox
      .list(p.terminalId)
      .find(
        (m) =>
          m.research?.assignmentId === `preparation:${lab.id}` &&
          m.recipient.terminalId === p.terminalId &&
          m.recipient.sessionId === p.sessionId &&
          !m.consumedAt,
      );
    if (pending) return { ...this.planRequest(lab)!, queued: true };
    const message = this.mailbox.sendResearch(
      p.terminalId,
      p.sessionId!,
      `사용자가 지금까지 이 대화에서 논의한 내용을 바탕으로 공동 작업 계획 정리를 요청했습니다. harbor_lab_context({labId:${JSON.stringify(lab.id)}})를 확인하고, 대화의 배경·결정·열린 질문을 context로 정리하여 harbor_lab_plan에 goal, kind, criteria, context를 저장하세요. 목표가 모호하면 먼저 이 터미널에서 사용자에게 질문하세요. 계획 저장은 공동 작업 시작이 아닙니다. 추가 AI를 호출하거나 실험을 시작하지 마세요.`,
      {
        labId: lab.id,
        assignmentId: `preparation:${lab.id}`,
        revision: lab.revision,
      },
    );
    return { ...this.planRequest(lab)!, messageId: message.id, queued: true };
  }

  start(
    labId: string,
    input: z.infer<typeof researchStartSchema>,
    partner: ResearchLab["participants"][number],
    conversation?: ResearchLab["conversation"],
    workspace?: ResearchLab["workspace"],
  ) {
    const parsed = researchStartSchema.parse(input);
    if (!partner.owned && parsed.partnerSettings)
      throw new Error("기존 대화의 모델·effort는 해당 CLI에서 변경하세요.");
    const lab = this.labs.find((l) => l.id === labId);
    if (!lab || lab.status !== "preparing")
      throw new Error(
        "주제 준비 중인 연구실만 공동 작업을 시작할 수 있습니다.",
      );
    if (parsed.revision !== lab.revision)
      throw new Error(
        "준비 계획이 변경되었습니다. 최신 내용을 확인한 뒤 시작하세요.",
      );
    const lead = lab.participants[0];
    if (this.options.runtime(lead.terminalId)?.state === "working")
      throw new Error("주 대화의 답변이 끝난 뒤 공동 작업을 시작하세요.");
    this.member(lead.terminalId, lead.sessionId, lab.id);
    if (partner.terminalId === lead.terminalId)
      throw new Error("서로 다른 두 대화를 선택하세요.");
    this.validateParticipants([lead, partner]);
    this.available(partner.terminalId, lab.id);
    const settings = partner.owned
      ? researchSettings(partner.kind, parsed.partnerSettings, lab.effort)
      : partner.settings;
    if (
      !parsed.manualContext &&
      (!conversation?.text.trim() ||
        conversation.sessionId !== lead.sessionId ||
        conversation.hostId !== lead.hostId)
    )
      throw new Error(
        "주 대화의 기록을 읽지 못했습니다. 대화를 나눈 뒤 다시 시도하거나 배경을 직접 입력하세요.",
      );
    if (parsed.manualContext && !parsed.context.trim())
      throw new Error("대화 기록 대신 공유할 배경을 입력하세요.");
    lab.proposal = {
      goal: parsed.goal,
      kind: parsed.kind,
      criteria: parsed.criteria,
      context: parsed.context,
      source: "user",
      updatedAt: Date.now(),
    };
    lab.goal = parsed.goal;
    lab.kind = parsed.kind;
    lab.criteria = parsed.criteria.map((text, i) => ({
      id: `c${i + 1}`,
      text,
    }));
    lab.participants.push({
      ...partner,
      hostId: this.options.terminal(partner.terminalId)!.hostId,
      ...(settings ? { settings } : {}),
    });
    lab.conversation = parsed.manualContext
      ? undefined
      : structuredClone(conversation);
    lab.workspace = workspace;
    lab.status = "connecting";
    lab.phase = "analysis";
    lab.revision++;
    this.suppressUnsent(lab);
    this.event(
      lab,
      "사용자가 준비한 대화와 계획을 확인하고 공동 작업을 시작했습니다.",
    );
    this.persist();
    this.emit("change");
    this.tick();
    return this.get(lab.id);
  }

  nativeFailure(terminalId: string, sessionId: string, notice: string): void {
    let changed = false;
    for (const lab of this.labs) {
      if (!["preparing", "connecting", "running"].includes(lab.status))
        continue;
      const index = lab.participants.findIndex(
        (p) => p.terminalId === terminalId && p.sessionId === sessionId,
      );
      if (
        index < 0 ||
        this.options.runtime(terminalId)?.sessionId !== sessionId
      )
        continue;
      if (
        lab.status !== "preparing" &&
        !this.current(lab).some((j) => j.participant === index && !j.report)
      )
        continue;
      if (lab.status !== "preparing") {
        lab.status = "paused";
        this.suppressUnsent(lab);
      }
      lab.attention = `${lab.participants[index].name}: ${notice.slice(0, 800)}${lab.status === "preparing" ? " 오류를 수정한 뒤 주 대화를 이어가세요." : " 오류를 수정한 뒤 계속 진행 → 배정 알림으로 현재 미완료 배정을 다시 보내세요. 대화·단계·기존 결과는 유지합니다."}`;
      this.event(lab, lab.attention, index);
      changed = true;
    }
    if (changed) {
      this.persist();
      this.emit("change");
    }
  }

  /** Called at native lifecycle boundaries; binding is fixed after the first real session ID. */
  tick(): void {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const lab of this.labs) {
        if (lab.status === "preparing") {
          const p = lab.participants[0],
            runtime = this.options.runtime(p.terminalId);
          if (
            !p.sessionId &&
            runtime?.sessionId &&
            runtime.state !== "offline"
          ) {
            p.sessionId = runtime.sessionId;
            this.persist();
            this.emit("change");
          }
          continue;
        }
        if (!["connecting", "running"].includes(lab.status)) continue;
        let unavailable = false;
        for (const participant of lab.participants) {
          const terminal = this.options.terminal(participant.terminalId);
          const runtime = this.options.runtime(participant.terminalId);
          if (!terminal || terminal.exited || runtime?.state === "offline") {
            lab.status = "paused";
            lab.attention = `${participant.name} 연결이 종료되었습니다. 원래 대화로 다시 연결하세요.`;
            unavailable = true;
            break;
          }
          if (
            participant.sessionId &&
            runtime?.sessionId &&
            participant.sessionId !== runtime.sessionId
          ) {
            lab.status = "paused";
            lab.attention = `${participant.name}의 대화가 변경되었습니다. 원래 대화로 돌아가세요.`;
            unavailable = true;
            break;
          }
          if (!participant.sessionId && runtime?.sessionId)
            participant.sessionId = runtime.sessionId;
        }
        if (unavailable) {
          this.event(lab, lab.attention!);
          this.persist();
          this.emit("change");
          continue;
        }
        if (!lab.participants.every((p) => p.sessionId)) {
          if (Date.now() - lab.createdAt > 60000 && !lab.attention) {
            lab.attention =
              "CLI의 로그인·프로젝트 신뢰·MCP 연결 안내를 확인하세요. 아직 두 대화가 연결되지 않았습니다.";
            this.persist();
            this.emit("change");
          }
          continue;
        }
        if (lab.status === "connecting") {
          lab.status = "running";
          delete lab.attention;
          this.begin(lab, "analysis");
        }
        this.dispatchQuestions(lab);
        this.advance(lab);
        this.dispatch(lab);
      }
    } finally {
      this.ticking = false;
    }
  }

  private current(lab: ResearchLab): ResearchAssignment[] {
    return lab.assignments.filter(
      (j) =>
        j.revision === lab.revision &&
        j.cycle === lab.cycle &&
        j.phase === lab.phase,
    );
  }
  /** Native, authenticated peer exchanges from this revision; a notification is not an answer. */
  private questions(lab: ResearchLab) {
    const since = Math.min(
      ...lab.assignments
        .filter((j) => j.revision === lab.revision)
        .map((j) => j.createdAt),
    );
    return this.mailbox
      .list()
      .filter(
        (m) =>
          m.labId === lab.id &&
          m.author === "agent" &&
          m.purpose === "question" &&
          !m.replyToId &&
          (m.questionSource
            ? m.questionSource.revision === lab.revision
            : m.labRevision !== undefined
              ? m.labRevision === lab.revision
              : m.createdAt >= since) &&
          lab.participants.some(
            (p, i) =>
              m.sender.terminalId === p.terminalId &&
              m.sender.sessionId === p.sessionId &&
              m.sender.agentKind === p.kind &&
              m.recipient.terminalId === lab.participants[1 - i]?.terminalId &&
              m.recipient.sessionId === lab.participants[1 - i]?.sessionId &&
              m.recipient.agentKind === lab.participants[1 - i]?.kind,
          ),
      );
  }
  private peerReply(lab: ResearchLab, questionId: string) {
    const question = this.questions(lab).find((m) => m.id === questionId);
    const reply =
      question?.replyMessageId && this.mailbox.find(question.replyMessageId);
    return question &&
      reply &&
      reply.author === "agent" &&
      reply.labId === lab.id &&
      reply.replyToId === question.id &&
      reply.sender.terminalId === question.recipient.terminalId &&
      reply.sender.sessionId === question.recipient.sessionId &&
      reply.recipient.sessionId === question.sender.sessionId
      ? reply
      : undefined;
  }
  private reportQuestions(job: ResearchAssignment) {
    return [
      ...(job.report?.peerQuestions || []),
      ...(job.report?.userQuestion ? [job.report.userQuestion] : []),
      ...(job.report?.researchDecision
        ? [this.researchChoiceText(job.report.researchDecision)]
        : []),
    ];
  }
  private delegateDecision(report: ResearchReport): ResearchReport {
    const decision = report.userDecision;
    if (decision?.kind !== "scope-change" || decision.constraintChange)
      return report;
    const { userDecision: _decision, ...rest } = report;
    return {
      ...rest,
      researchDecision: {
        question: decision.question,
        reason: decision.reason,
      },
    };
  }
  private researchChoiceText(choice: { question: string; reason: string }) {
    return `Research decision for the two AI participants, not a user request. Preserve fixed hardware, budget, protected resources and completion criteria. Compare alternatives and choose the next useful path yourselves; a starting candidate list may be broadened if it fails. Do not ask the user to select among research paths. Question: ${choice.question}\nReason: ${choice.reason}`;
  }
  /** General clarification tools cannot bypass the lab's delegated research policy. */
  routeQuestion(
    terminalId: string,
    sessionId: string | undefined,
    text: string,
  ) {
    const lab = this.labs.find(
      (l) =>
        !["preparing", "completed"].includes(l.status) &&
        l.participants.some((p) => p.terminalId === terminalId),
    );
    if (!lab) return undefined;
    const member = this.member(terminalId, sessionId, lab.id);
    if (member.status !== "running")
      throw new Error(
        "연구실이 멈춰 있습니다. 원래 연결·고정 제약 요청을 확인하세요. 일반 연구 질문으로 새 사용자 요청을 만들지 않습니다.",
      );
    const index = lab.participants.findIndex(
        (p) => p.terminalId === terminalId,
      ),
      recipient = lab.participants[1 - index];
    if (!recipient?.sessionId)
      throw new Error("동료 AI의 원래 대화 연결을 기다리세요.");
    const messageText = `Research clarification for the peer; resolve within the authorized goal and constraints without asking the user to choose.\n${text}`;
    let question = this.questions(lab).find(
      (m) => m.sender.terminalId === terminalId && m.text === messageText,
    );
    if (!question) {
      if (
        this.questions(lab).filter(
          (m) =>
            m.sender.terminalId === terminalId && !this.peerReply(lab, m.id),
        ).length >= 8
      )
        throw new Error(
          "이미 동료에게 전달한 질문을 먼저 확인하세요. 추가 사용자 질문을 만들지 않습니다.",
        );
      question = this.mailbox.sendAgent(
        terminalId,
        recipient.terminalId,
        messageText,
        {
          senderSessionId: sessionId,
          recipientSessionId: recipient.sessionId,
          purpose: "question",
          labId: lab.id,
          labRevision: lab.revision,
        },
      );
      this.event(
        lab,
        "사용자에게 보내려던 연구 질문을 동료 AI에게 전달했습니다.",
        index,
      );
      this.persist();
      this.emit("change");
    }
    return {
      redirectedToPeer: true,
      labId: lab.id,
      questionId: question.id,
      to: recipient.name,
      status: this.peerReply(lab, question.id) ? "answered" : "pending",
      answer: this.peerReply(lab, question.id)?.text,
      next: "This is a peer question, not a user request or permission. Continue independent work; use harbor_ask_result with questionId as requestId if needed, and answer incoming questions with harbor_reply. Genuine user-only boundaries belong in a qualified userDecision report. Native security approvals stay native.",
    };
  }
  private dispatchQuestions(lab: ResearchLab) {
    if (lab.status !== "running") return;
    // Preserve independent initial reports; afterwards questions are ordinary native peer messages.
    if (lab.phase === "analysis" && this.current(lab).some((j) => !j.report))
      return;
    for (const job of lab.assignments.filter(
      (j) => j.revision === lab.revision && j.report,
    )) {
      const sender = lab.participants[job.participant],
        recipient = lab.participants[1 - job.participant];
      if (!sender.sessionId || !recipient?.sessionId) continue;
      if (
        recipient.kind === "claude" &&
        this.options.runtime(recipient.terminalId)?.state === "working"
      )
        continue;
      for (const [index, text] of this.reportQuestions(job).entries()) {
        if (
          this.questions(lab).some(
            (m) =>
              m.sender.sessionId === sender.sessionId &&
              ((m.questionSource?.assignmentId === job.id &&
                m.questionSource.index === index) ||
                m.text === text),
          )
        )
          continue;
        const outstanding = this.mailbox
          .list(recipient.terminalId)
          .filter(
            (m) =>
              m.purpose === "question" &&
              m.recipient.terminalId === recipient.terminalId &&
              m.recipient.sessionId === recipient.sessionId &&
              !m.replyMessageId,
          ).length;
        const sent = this.mailbox
          .list(sender.terminalId)
          .filter(
            (m) =>
              m.purpose === "question" &&
              m.sender.terminalId === sender.terminalId &&
              m.sender.sessionId === sender.sessionId &&
              !m.replyMessageId,
          ).length;
        if (outstanding >= 8 || sent >= 8) continue;
        try {
          this.mailbox.sendAgent(
            sender.terminalId,
            recipient.terminalId,
            text,
            {
              senderSessionId: sender.sessionId,
              recipientSessionId: recipient.sessionId,
              purpose: "question",
              labId: lab.id,
              questionSource: {
                assignmentId: job.id,
                index,
                revision: lab.revision,
              },
            },
          );
          this.event(
            lab,
            `${sender.name}의 질문을 ${recipient.name}에게 전달했습니다.`,
            job.participant,
          );
          this.persist();
          this.emit("change");
        } catch (error) {
          lab.status = "paused";
          lab.attention =
            error instanceof Error
              ? error.message
              : "동료 AI에게 질문을 전달하지 못했습니다.";
          this.event(lab, lab.attention);
          this.persist();
          this.emit("change");
          return;
        }
      }
    }
  }
  private event(lab: ResearchLab, text: string, participant?: number) {
    lab.updatedAt = Date.now();
    lab.events.push({
      id: randomUUID(),
      at: lab.updatedAt,
      text: text.slice(0, 2000),
      ...(participant !== undefined ? { participant } : {}),
    });
  }
  private begin(lab: ResearchLab, phase: ResearchPhase) {
    lab.phase = phase;
    const indices =
      phase === "synthesis" ? [0] : phase === "verify" ? [1] : [0, 1];
    for (const participant of indices)
      lab.assignments.push({
        id: randomUUID(),
        participant,
        phase,
        cycle: lab.cycle,
        revision: lab.revision,
        createdAt: Date.now(),
        messageIds: [],
      });
    this.event(lab, `${researchPhaseLabel[phase]}를 시작합니다.`);
    // Durable assignment IDs form an outbox; a crash cannot silently create another job.
    this.persist();
    this.emit("change");
  }

  private dispatch(lab: ResearchLab) {
    if (lab.status !== "running") return;
    for (const job of this.current(lab)) {
      if (job.report) continue;
      const participant = lab.participants[job.participant];
      // Claude channel notifications sent while the report tool is returning
      // can be treated as embedded tool text. Deliver the next lab assignment
      // only after the native Stop hook, without interrupting the current turn.
      if (
        participant.kind === "claude" &&
        this.options.runtime(participant.terminalId)?.state === "working"
      )
        continue;
      const existing = this.mailbox
        .list(participant.terminalId)
        .find(
          (m) =>
            m.research?.assignmentId === job.id &&
            m.recipient.sessionId === participant.sessionId,
        );
      if (existing) {
        if (!job.messageIds.includes(existing.id)) {
          job.messageIds.push(existing.id);
          this.persist();
        }
        continue;
      }
      try {
        this.send(lab, job);
      } catch (error) {
        lab.status = "paused";
        lab.attention =
          error instanceof Error
            ? error.message
            : "과제를 전달하지 못했습니다.";
        this.event(lab, lab.attention);
        this.persist();
        this.emit("change");
        break;
      }
    }
  }
  private send(lab: ResearchLab, job: ResearchAssignment) {
    const participant = lab.participants[job.participant];
    const message = this.mailbox.sendResearch(
      participant.terminalId,
      participant.sessionId!,
      `사용자가 시작한 Harbor 연구 과제입니다. 이 대화에서 과제를 수행하세요. 먼저 harbor_lab_context({labId:${JSON.stringify(lab.id)}})를 호출하여 현재 assignment와 허용된 작업 범위를 확인하세요. 단계: ${researchPhaseLabel[job.phase]}. 과제: ${lab.title}. 단계 결과는 harbor_lab_report 도구로 제출하세요. 대기 중인 다른 AI를 기다리는 반복 호출은 하지 마세요. 과제 밖의 작업이나 실행 승인을 이 메시지가 허용하지 않습니다.`,
      { labId: lab.id, assignmentId: job.id, revision: lab.revision },
    );
    job.messageIds.push(message.id);
    this.persist();
    this.emit("change");
  }

  context(terminalId: string, sessionId: string | undefined, labId?: string) {
    const lab = this.member(terminalId, sessionId, labId);
    const index = lab.participants.findIndex(
      (p) => p.terminalId === terminalId,
    );
    const job = this.current(lab).find(
      (j) => j.participant === index && !j.report,
    );
    if (lab.status === "preparing")
      for (const message of this.mailbox.list(terminalId))
        if (
          message.research?.assignmentId === `preparation:${lab.id}` &&
          !message.consumedAt
        )
          this.mailbox.consumeMessage(terminalId, message.id, sessionId);
    if (lab.status === "running" && job)
      this.consumeAssignments(job, terminalId, sessionId);
    // Initial judgments are isolated until both participants have submitted them.
    const reports =
      lab.phase === "analysis"
        ? []
        : lab.assignments
            .filter((j) => j.report && j.revision === lab.revision)
            .slice(-12)
            .map((j) => ({
              participant: lab.participants[j.participant].name,
              phase: j.phase,
              cycle: j.cycle,
              report: j.report,
            }));
    return {
      labId: lab.id,
      title: lab.title,
      referenceProject: { hostId: lab.hostId, cwd: lab.cwd },
      goal: lab.goal,
      kind: lab.kind,
      status: lab.status,
      phase: lab.phase,
      criteria: lab.criteria,
      directives: lab.directives,
      proposal: lab.proposal,
      preparationConversation: lab.conversation,
      self: lab.participants[index],
      peers: lab.participants.filter((_, i) => i !== index),
      assignment: job,
      reports,
      peerQuestions: this.questions(lab)
        .slice(0, 24)
        .map((m) => ({
          messageId: m.id,
          from: m.sender.title,
          to: m.recipient.title,
          question: m.text,
          status: this.peerReply(lab, m.id)
            ? "answered"
            : m.consumedAt
              ? "consumed"
              : m.offeredAt
                ? "offered"
                : "queued",
          reply: this.peerReply(lab, m.id)?.text,
        })),
      userAnswers: lab.assignments
        .filter((j) => j.revision === lab.revision && j.decisionAnswer)
        .map((j) => ({
          question:
            j.report?.userDecision?.question ||
            j.report?.researchDecision?.question,
          answer: j.decisionAnswer!.text,
        })),
      works:
        lab.phase === "analysis"
          ? lab.works.filter((w) => w.participant === index)
          : lab.works.slice(-40),
      bestResult: lab.phase === "analysis" ? "" : lab.bestResult,
      workspace: lab.workspace,
      instructions: this.instructions(lab, job),
      decisionPolicy: {
        researchChoices: "delegated-to-peers",
        candidateLists: "starting-points-within-fixed-constraints",
        fixedConstraints:
          "Preserve hardware, budget, protected resources and completion criteria. Do not relax them to claim success.",
        userEscalation:
          "Only user-only unavailable information, external permission, or an explicitly quoted fixed constraint change after real peer consultation.",
      },
    };
  }
  private instructions(lab: ResearchLab, job?: ResearchAssignment): string {
    if (lab.status === "preparing")
      return "Discuss the topic, background, constraints and open questions with the user in this native conversation. When the user asks to prepare a research plan, save goal, kind, criteria and a faithful summary of the conversation in harbor_lab_plan. Ask the user for missing direction instead of inventing it. Saving a proposal does NOT start joint work. Only the user can start it in Harbor. There is no lab assignment yet; do not report one, contact another AI or run experiments on the lab's behalf.";
    if (lab.status !== "running" || !job)
      return "No active assignment. In a running lab, answer actual received peer questions with harbor_reply, then wait for the next authorized assignment. Preserve your conversation; do not invent completion, poll, or repeat completed experiments.";
    const stage: Record<ResearchPhase, string> = {
      preparation: "Discuss the topic with the user and save a proposal only.",
      analysis:
        "Form your own initial judgment. Initial reports are kept independent until both are submitted. Identify assumptions, alternatives, and a useful approach. Put questions about candidates, interpretations or research choices in peerQuestions; Harbor relays them to the other AI after both initial reports. You may use harbor_ask(waitMs=0) for a concrete clarification, but do not wait for the peer before submitting your initial report. This analysis is not the final result; set ready=false. No code edits or experiments in this phase.",
      discussion:
        "Review the other participant's actual reports. Critique assumptions with reasons and propose focused next actions or experiments. You may actually use harbor_ask/harbor_send to ask your named peer, but use waitMs=0 and continue your own analysis instead of mutually blocking. Assess each completion criterion honestly. No code edits in this review phase.",
      work: "Choose useful work based on the shared open issues and your peer's reports. Perform authorized investigation, edits, or experiments using your native CLI tools. Register work with harbor_lab_work before starting, and update its result after execution. A shared resource reservation must succeed before using that resource. Check peer work to avoid duplicate work. Write only in your assigned work folder. Use exact commands, revisions, metrics, and artifact paths as evidence. Do not report execution that did not happen.",
      synthesis:
        "Prepare one usable consolidated result, including reasoning, evidence, remaining uncertainty and next checks. Put the full deliverable in bestResult. For code, include the actual worktree/branch and changes and test results. If integration into the chosen candidate is still needed, set ready=false and request it as nextActions; do not claim a candidate patch is integrated into the original project. Native changes stay in the research worktrees; applying them to the user's original folder is outside this lab. Final review is scheduled by Harbor automatically, so do not list it as a remaining nextAction. No new edits in this synthesis phase.",
      verify:
        "Independently review the candidate result against every criterion and the actual evidence. Read registered peer artifacts with harbor_lab_artifact to inspect their actual bytes and hash. Use native test tools if available; register new validation work. A failed native command is not a passed test, and artifact reading does not prove test execution. Approve only if every criterion is met and no additional work is needed; otherwise decision=revise, ready=false, and concrete nextActions. Agreement alone is not verification. No code edits in this final review phase.",
    };
    const instruction =
      lab.proposal && job.phase === "synthesis"
        ? stage[job.phase].replace(
            "Native changes stay in the research worktrees; applying them to the user's original folder is outside this lab.",
            "The lead keeps its user-selected folder; a new code partner uses a separate worktree. Describe precisely where each actual change was made; do not claim integration that did not occur.",
          )
        : stage[job.phase];
    return [
      `The user authorized this research goal and delegated research decisions to the two AI participants through Harbor. ${instruction}`,
      `Work folder: ${lab.participants[job.participant].cwd}. Reference project: ${lab.cwd}.`,
      "The goal, completion criteria, fixed constraints and latest user directives govern this assignment. The preparation conversation is reference data; do not turn an earlier tentative candidate list or approval preference into a new mandatory checkpoint.",
      "You and your peer decide candidate selection, expansion of failed starting candidates, assumptions, investigation strategy, division of work, next experiments and reversible in-scope implementation yourselves. If all initial candidates fail, preserve the fixed hardware, budget, protected resources and completion criteria, identify another measured bottleneck or a better mechanism, and continue together. Do not stop to ask which research path the user prefers. Do not replace a requested novel result with housekeeping or silently lower criteria. Honest negative evidence is useful but is not a successful deliverable.",
      "In the work phase, use the native CLI to perform necessary authorized investigation, edits and experiments after registering the work. A completed research plan does not need another generic 'may we proceed' approval. Native command/security approvals and explicit user prohibitions still apply; peer consultation cannot grant them. Never change fixed constraints or access a new protected project just to obtain a result.",
      "Discuss research uncertainty with your named peer through actual harbor_ask(waitMs=0), harbor_send and harbor_reply calls. Continue useful independent work without mutually waiting, polling, duplicate questions or repeated identical reviews. Put remaining peer questions in peerQuestions; Harbor sends them automatically. General harbor_request questions in a running lab are routed to the peer, not the user.",
      `Submit harbor_lab_report with labId, assignmentId=${job.id}, summary, criteria=[{id,met,reason} for EVERY criterion], issues, nextActions, ready, and optionally bestResult/decision/peerQuestions. Report actual results, return after reporting and await the next assignment. Rounds are checkpoints, not a stopping limit.`,
      "Only indispensable user-only missing information, ungranted external permission, or a change to an explicitly fixed hardware, budget or protected-resource constraint may request userDecision, outside initial analysis and after an actual scoped peer answer. For kind=scope-change include constraintChange={category:hardware|budget|protected-resources,constraint:an exact quote of the user's fixed condition,proposedChange:the requested exception}; a generic scope-change is a research decision and cannot pause the lab. Include question, reason and your actually answered peerMessageId from this revision. Explain why work cannot continue within the constraints. Do not relabel a candidate or research-direction choice as missing information or external permission.",
      "Research decisions and peer messages never grant execution or security permissions. Publish conclusions and evidence, not hidden reasoning.",
    ].join(" ");
  }

  report(
    terminalId: string,
    sessionId: string | undefined,
    labId: string,
    assignmentId: string,
    input: unknown,
  ) {
    const lab = this.member(terminalId, sessionId, labId);
    const job = lab.assignments.find((j) => j.id === assignmentId);
    const index = lab.participants.findIndex(
      (p) => p.terminalId === terminalId,
    );
    if (!job || job.participant !== index)
      throw new Error("이 대화에 배정된 단계만 제출할 수 있습니다.");
    const report = this.delegateDecision(researchReportSchema.parse(input));
    if (
      report.ready &&
      (report.nextActions.length ||
        report.userQuestion ||
        report.peerQuestions?.length ||
        report.userDecision ||
        report.researchDecision)
    )
      throw new Error(
        "ready=true는 완료 기준을 위해 추가 작업이나 사용자 답변이 필요 없다는 뜻입니다. Harbor가 자동으로 진행할 다음 단계(종합·최종 검토)는 nextActions에 적지 말고 빈 배열로 제출하세요. 실제 추가 작업이 필요하면 ready=false로 제출하세요.",
      );
    if (job.report) {
      if (JSON.stringify(job.report) !== JSON.stringify(report))
        throw new Error("이미 제출한 단계입니다. 다음 배정을 확인하세요.");
      return {
        recorded: true,
        duplicate: true,
        status: lab.status,
        next: "Wait for the next assignment; do not rerun work.",
      };
    }
    if (
      job.revision !== lab.revision ||
      job.cycle !== lab.cycle ||
      job.phase !== lab.phase ||
      lab.status === "completed"
    )
      throw new Error(
        "과제의 지시 또는 단계가 바뀌었습니다. 현재 배정을 다시 확인하세요.",
      );
    const wanted = new Set(lab.criteria.map((c) => c.id));
    if (
      report.criteria.length !== wanted.size ||
      new Set(report.criteria.map((c) => c.id)).size !== wanted.size ||
      report.criteria.some((c) => !wanted.has(c.id))
    )
      throw new Error("모든 완료 기준을 각각 평가하세요.");
    if (
      lab.works.some((w) => w.assignmentId === job.id && w.status === "running")
    )
      throw new Error("실행 중인 작업의 실제 결과를 먼저 기록하세요.");
    if (report.userDecision) {
      const change = report.userDecision.constraintChange;
      if (change) {
        if (report.userDecision.kind !== "scope-change")
          throw new Error("고정 제약 변경은 scope-change로 보고하세요.");
        const authorizedText = [
          lab.goal,
          ...lab.criteria.map((c) => c.text),
          ...lab.directives,
          lab.proposal?.context || "",
        ].join("\n");
        if (!authorizedText.includes(change.constraint))
          throw new Error(
            "사용자가 명시한 고정 제약을 그대로 인용하고 바꾸려는 내용을 적으세요. 후보·연구 방향 선택은 AI끼리 결정합니다.",
          );
      }
      const question = this.questions(lab).find(
        (m) => m.id === report.userDecision!.peerMessageId,
      );
      if (
        job.phase === "analysis" ||
        !question ||
        question.sender.terminalId !== terminalId ||
        (question.questionSource?.revision ?? question.labRevision) !==
          lab.revision ||
        !this.peerReply(lab, question.id)
      )
        throw new Error(
          "먼저 동료 AI와 실제 질문·답변으로 검토하세요. 초기 분석의 질문은 peerQuestions로 제출하고, 사용자만 결정할 수 있는 경우에만 답변된 peerMessageId와 이유를 userDecision에 적으세요.",
        );
      if (lab.pendingDecision)
        throw new Error(
          "이미 사용자 결정이 대기 중입니다. 답변 후 현재 배정을 이어가세요.",
        );
    }
    job.report = report;
    job.reportedAt = Date.now();
    if (report.bestResult) lab.bestResult = report.bestResult;
    this.event(
      lab,
      `${lab.participants[index].name}가 ${researchPhaseLabel[job.phase]} 결과를 제출했습니다.`,
      index,
    );
    if (report.userDecision) {
      lab.pendingDecision = {
        ...report.userDecision,
        assignmentId: job.id,
        participant: index,
      };
      if (lab.status !== "paused") lab.status = "needs-input";
      lab.attention = report.userDecision.question;
      this.event(
        lab,
        `사용자 결정 필요: ${report.userDecision.question}`,
        index,
      );
    }
    if (report.researchDecision)
      this.event(
        lab,
        "연구 방향 선택을 동료 AI에게 맡겼습니다. 사용자 답변 없이 다음 작업을 진행합니다.",
        index,
      );
    this.persist();
    this.consumeAssignments(job, terminalId, sessionId);
    this.emit("change");
    this.tick();
    return {
      recorded: true,
      status: lab.status,
      phase: lab.phase,
      next: "Your report is saved. Return now; Harbor delivers the next assignment when its dependencies are ready.",
    };
  }

  private consumeAssignments(
    job: ResearchAssignment,
    terminalId: string,
    sessionId: string | undefined,
  ) {
    for (const messageId of job.messageIds) {
      const message = this.mailbox.find(messageId);
      // Deleted unsent envelopes and old terminal IDs remain in assignment
      // history. A resumed native conversation consumes only its new copy.
      if (
        message?.recipient.terminalId === terminalId &&
        message.recipient.sessionId === sessionId
      )
        this.mailbox.consumeMessage(terminalId, messageId, sessionId);
    }
  }

  async artifact(
    terminalId: string,
    sessionId: string | undefined,
    input: unknown,
  ) {
    const parsed = researchArtifactSchema.parse(input);
    const lab = this.member(terminalId, sessionId, parsed.labId);
    const requester = lab.participants.findIndex(
      (p) => p.terminalId === terminalId,
    );
    const work = lab.works.find((w) => w.id === parsed.workId);
    if (
      !work ||
      !work.artifacts.includes(parsed.path) ||
      (lab.phase === "analysis" && work.participant !== requester)
    )
      throw new Error("공유 작업에 등록된 산출물만 읽을 수 있습니다.");
    const participant = lab.participants[work.participant];
    const hostId = participant.hostId || lab.hostId;
    let file: string;
    let bytes: Buffer;
    if (this.options.artifact) {
      const result = await this.options.artifact(
        hostId,
        participant.cwd,
        work.cwd || participant.cwd,
        parsed.path,
      );
      file = result.path;
      bytes = result.bytes;
    } else {
      if (this.options.host(hostId)?.kind !== "local")
        throw new Error("서버 산출물 읽기 연결을 확인하세요.");
      const root = await realpath(participant.cwd);
      file = await realpath(resolve(work.cwd || participant.cwd, parsed.path));
      const child = relative(root, file);
      if (!child || child.startsWith("..") || isAbsolute(child))
        throw new Error(
          "참여자의 작업 폴더 안에 있는 산출물만 읽을 수 있습니다.",
        );
      const details = await stat(file);
      if (!details.isFile() || details.size > 512 * 1024)
        throw new Error("512 KB 이하의 텍스트 산출물만 읽을 수 있습니다.");
      bytes = await readFile(file);
    }
    if (bytes.length > 512 * 1024 || bytes.includes(0))
      throw new Error("텍스트 산출물만 읽을 수 있습니다.");
    this.member(terminalId, sessionId, parsed.labId);
    const lines = bytes.toString("utf8").split(/\r?\n/);
    const text = lines
      .slice(parsed.startLine - 1, parsed.startLine + 199)
      .join("\n")
      .slice(0, 24000);
    return {
      path: file,
      workId: work.id,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      totalLines: lines.length,
      startLine: parsed.startLine,
      text,
      note: "Actual file bytes read by Harbor. This does not establish successful test execution.",
    };
  }

  private ready(lab: ResearchLab, report: ResearchReport): boolean {
    return (
      report.ready &&
      !report.userQuestion &&
      !report.peerQuestions?.length &&
      !report.userDecision &&
      !report.researchDecision &&
      !this.questions(lab).some((m) => !this.peerReply(lab, m.id)) &&
      report.nextActions.length === 0 &&
      lab.criteria.every((c) =>
        report.criteria.some((a) => a.id === c.id && a.met),
      )
    );
  }
  private advance(lab: ResearchLab) {
    if (lab.status !== "running" || lab.pendingDecision) return;
    const jobs = this.current(lab);
    if (
      !jobs.length ||
      jobs.some((j) => !j.report) ||
      lab.works.some((w) => w.status === "running")
    )
      return;
    if (lab.phase === "analysis") this.begin(lab, "discussion");
    else if (lab.phase === "discussion") {
      if (jobs.every((j) => this.ready(lab, j.report!)))
        this.begin(lab, "synthesis");
      else {
        const rounds = lab.assignments
          .filter(
            (j) =>
              j.phase === "discussion" &&
              j.revision === lab.revision &&
              j.report,
          )
          .slice(-6);
        if (
          rounds.length === 6 &&
          [0, 1].every((i) => {
            const own = rounds.filter((j) => j.participant === i);
            return (
              own.length === 3 &&
              own.every(
                (j) =>
                  JSON.stringify(j.report) === JSON.stringify(own[0].report),
              )
            );
          })
        ) {
          this.event(
            lab,
            "같은 검토가 반복되어 AI끼리 새로운 접근·근거·실험을 선택합니다. 사용자 방향 선택으로 중단하지 않습니다.",
          );
        }
        this.begin(lab, "work");
      }
    } else if (lab.phase === "work") {
      lab.cycle++;
      this.begin(lab, "discussion");
    } else if (lab.phase === "synthesis") {
      if (
        this.ready(lab, jobs[0].report!) &&
        jobs[0].report!.bestResult?.trim()
      )
        this.begin(lab, "verify");
      else {
        lab.cycle++;
        this.begin(lab, "work");
      }
    } else if (lab.phase === "verify") {
      if (
        jobs[0].report!.decision === "approve" &&
        this.ready(lab, jobs[0].report!) &&
        lab.bestResult.trim()
      ) {
        lab.status = "completed";
        delete lab.attention;
        this.event(
          lab,
          "최종 결과가 완료 기준에 따라 상대 AI의 검토를 통과했습니다.",
        );
        this.persist();
        this.emit("change");
      } else {
        lab.cycle++;
        this.begin(lab, "work");
      }
    }
  }

  work(terminalId: string, sessionId: string | undefined, input: unknown) {
    const parsed = researchWorkSchema.parse(input);
    const lab = this.member(terminalId, sessionId, parsed.labId);
    const index = lab.participants.findIndex(
      (p) => p.terminalId === terminalId,
    );
    const job = lab.assignments.find(
      (j) => j.id === parsed.assignmentId && j.participant === index,
    );
    const old = parsed.workId
      ? lab.works.find((w) => w.id === parsed.workId)
      : undefined;
    if (
      !job ||
      (parsed.workId &&
        (!old || old.assignmentId !== job.id || old.participant !== index))
    )
      throw new Error("본인에게 배정된 작업만 기록할 수 있습니다.");
    if (
      !old &&
      (lab.status !== "running" ||
        job.revision !== lab.revision ||
        !["work", "verify"].includes(job.phase) ||
        !this.current(lab).includes(job) ||
        job.report)
    )
      throw new Error("현재 수행 단계에서만 새 작업을 시작할 수 있습니다.");
    if (parsed.status === "running" && parsed.resource) {
      const ownerHostId = lab.participants[index].hostId || lab.hostId;
      const busy = this.labs
        .flatMap((l) =>
          l.works.filter(
            (w) =>
              (l.participants[w.participant].hostId || l.hostId) ===
              ownerHostId,
          ),
        )
        .find(
          (w) =>
            w.status === "running" &&
            w.resource === parsed.resource &&
            w.id !== old?.id,
        );
      if (busy)
        throw new Error(
          `자원 ${parsed.resource}은 다른 실험에서 사용 중입니다. 다른 작업을 먼저 수행하세요.`,
        );
    }
    if (old && old.status !== "running")
      throw new Error(
        "끝난 실험 기록은 변경하지 않습니다. 새 작업을 등록하세요.",
      );
    const { labId: _labId, workId: _workId, ...fields } = parsed;
    const now = Date.now();
    const work: ResearchWork = {
      ...old,
      ...fields,
      artifacts:
        input && typeof input === "object" && "artifacts" in input
          ? parsed.artifacts
          : old?.artifacts || parsed.artifacts,
      id: old?.id || randomUUID(),
      participant: index,
      evidence: "agent-reported",
      createdAt: old?.createdAt || now,
      updatedAt: now,
    };
    if (old) lab.works[lab.works.indexOf(old)] = work;
    else lab.works.push(work);
    this.event(
      lab,
      `${work.title}: ${work.status === "running" ? "시작" : work.status === "completed" ? "결과 기록" : "실패 기록"}`,
      index,
    );
    this.persist();
    this.emit("change");
    if (lab.status === "running") this.advance(lab);
    this.tick();
    return {
      work,
      note: "Recorded agent report, not independently verified execution. Execute using native CLI tools and attach actual evidence.",
    };
  }

  control(
    labId: string,
    action: "pause" | "resume" | "retry" | "answer",
    directive?: string,
    decisionAssignmentId?: string,
    actor: "user" | "manager" = "user",
  ): ResearchLab {
    const lab = this.labs.find((l) => l.id === labId);
    if (!lab) throw new Error("연구 과제를 찾을 수 없습니다.");
    if (lab.status === "preparing")
      throw new Error(
        "준비 중에는 터미널에서 대화하세요. 공동 작업 시작 버튼으로 과제를 배정할 수 있습니다.",
      );
    if (action === "pause") {
      if (lab.status === "completed") return this.get(labId);
      lab.status = "paused";
      lab.attention =
        "새 배정 전달을 멈췄습니다. 이미 전달된 작업과 실행 중인 실험은 종료하지 않습니다.";
      this.event(
        lab,
        actor === "manager"
          ? "관리자 AI가 일시정지했습니다."
          : "사용자가 일시정지했습니다.",
      );
      this.suppressUnsent(lab);
    } else if (action === "answer") {
      const decision = lab.pendingDecision;
      if (!decision || decision.assignmentId !== decisionAssignmentId)
        throw new Error(
          "답변할 질문이 변경되었습니다. 현재 질문을 확인하세요.",
        );
      if (!directive?.trim() || directive.trim().length > 4000)
        throw new Error("질문에 대한 답변을 4,000자 이내로 입력하세요.");
      this.validateParticipants(lab.participants);
      if (
        lab.participants.some(
          (p) => this.options.runtime(p.terminalId)?.sessionId !== p.sessionId,
        )
      )
        throw new Error("원래 대화를 연결한 뒤 답변하세요.");
      const job = lab.assignments.find((j) => j.id === decision.assignmentId)!;
      job.decisionAnswer = { text: directive.trim(), at: Date.now() };
      lab.directives.push(directive.trim());
      delete lab.pendingDecision;
      delete lab.attention;
      lab.status = "running";
      this.event(lab, `사용자 답변: ${directive.trim()}`);
    } else if (directive?.trim()) {
      if (directive.trim().length > 4000)
        throw new Error("추가 지시는 4,000자까지 입력할 수 있습니다.");
      lab.directives.push(directive.trim());
      lab.revision++;
      lab.cycle = 0;
      lab.status = "running";
      delete lab.attention;
      delete lab.pendingDecision;
      this.suppressUnsent(lab);
      this.event(
        lab,
        `${actor === "manager" ? "관리자 AI" : "사용자"} 추가 지시: ${directive.trim()}`,
      );
      this.begin(lab, "analysis");
    } else if (action === "retry") {
      if (lab.status !== "running")
        throw new Error("먼저 과제를 이어서 진행하세요.");
      for (const job of this.current(lab).filter((j) => !j.report)) {
        const participant = lab.participants[job.participant];
        if (
          this.options.runtime(participant.terminalId)?.sessionId !==
          participant.sessionId
        )
          throw new Error("원래 대화 연결을 먼저 확인하세요.");
        this.send(lab, job);
      }
      this.event(
        lab,
        "현재 배정을 다시 알렸습니다. 완료된 작업은 다시 실행하지 않습니다.",
      );
    } else {
      if (lab.pendingDecision)
        throw new Error("사용자만 결정할 수 있는 질문에 답변한 뒤 이어가세요.");
      if (lab.status === "completed") return this.get(labId);
      this.validateParticipants(lab.participants);
      if (
        lab.participants.some(
          (p) =>
            p.sessionId &&
            this.options.runtime(p.terminalId)?.sessionId &&
            this.options.runtime(p.terminalId)?.sessionId !== p.sessionId,
        )
      )
        throw new Error(
          "원래 대화를 다시 연결하세요. 다른 대화로 자동 변경하지 않습니다.",
        );
      lab.status = lab.participants.every((p) => p.sessionId)
        ? "running"
        : "connecting";
      delete lab.attention;
      this.event(
        lab,
        actor === "manager"
          ? "관리자 AI가 과제를 이어서 진행합니다."
          : "사용자가 과제를 이어서 진행합니다.",
      );
      if (lab.status === "running") this.advance(lab);
    }
    this.persist();
    this.emit("change");
    this.tick();
    return this.get(labId);
  }
  rebind(labId: string, terminalIds: string[]) {
    const lab = this.labs.find((l) => l.id === labId);
    if (!lab || terminalIds.length !== lab.participants.length)
      throw new Error("원래 참여자들의 연결을 지정하세요.");
    if (!["preparing", "paused", "needs-input"].includes(lab.status))
      throw new Error("일시정지 상태에서만 재연결할 수 있습니다.");
    const participants = lab.participants.map((p, i) => ({
      ...p,
      terminalId: terminalIds[i],
    }));
    this.validateParticipants(participants);
    participants.forEach((p) => this.available(p.terminalId, lab.id));
    if (
      new Set(terminalIds).size !== terminalIds.length ||
      this.labs.some(
        (l) =>
          l.id !== lab.id &&
          l.status !== "completed" &&
          l.participants.some((p) => terminalIds.includes(p.terminalId)),
      )
    )
      throw new Error("다른 연구 과제와 겹치지 않는 두 세션을 선택하세요.");
    for (const p of participants)
      if (
        !p.sessionId ||
        this.options.runtime(p.terminalId)?.sessionId !== p.sessionId
      )
        throw new Error("기존 대화 ID와 일치하는 세션만 재연결할 수 있습니다.");
    this.suppressUnsent(lab);
    lab.participants = participants;
    this.event(lab, "원래 대화에 재연결했습니다.");
    this.persist();
    this.emit("change");
    return this.get(labId);
  }
  private suppressUnsent(lab: ResearchLab) {
    for (const message of this.mailbox.list())
      if (
        (message.research?.labId === lab.id ||
          (message.labId === lab.id && !!message.questionSource)) &&
        !message.offeredAt &&
        !message.consumedAt
      )
        this.mailbox.remove(message.id);
  }
  private member(
    terminalId: string,
    sessionId: string | undefined,
    labId?: string,
  ): ResearchLab {
    const candidates = this.labs.filter(
      (l) =>
        (!labId || l.id === labId) &&
        l.participants.some(
          (p) =>
            p.terminalId === terminalId &&
            !!p.sessionId &&
            p.sessionId === sessionId,
        ),
    );
    const lab = labId
      ? candidates[0]
      : candidates.find((l) => l.status !== "completed") || candidates.at(-1);
    if (!lab)
      throw new Error("이 네이티브 대화가 참여하는 연구 과제가 없습니다.");
    if (
      !this.options.terminal(terminalId) ||
      this.options.terminal(terminalId)?.exited ||
      this.options.runtime(terminalId)?.sessionId !== sessionId ||
      this.options.runtime(terminalId)?.state === "offline"
    )
      throw new Error(
        "현재 실행 중인 원래 대화에서만 연구 과제를 확인할 수 있습니다.",
      );
    return lab;
  }
  shutdown() {
    for (const lab of this.labs)
      if (["running", "connecting"].includes(lab.status)) {
        lab.status = "paused";
        lab.attention =
          "Harbor가 종료되었습니다. 원래 대화에 재연결한 뒤 계속하세요.";
        this.event(lab, lab.attention);
        this.suppressUnsent(lab);
      }
    this.persist();
  }
  private persist() {
    const body = JSON.stringify({ version: 1, labs: this.labs });
    if (Buffer.byteLength(body) > 32 * 1024 * 1024)
      throw new Error(
        "연구 기록 저장 한도를 넘었습니다. 현재 결과를 보관하고 과제를 정리하세요.",
      );
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, body, { flag: "wx", mode: 0o600 });
      renameSync(temporary, this.file);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {}
      throw error;
    }
  }
}
