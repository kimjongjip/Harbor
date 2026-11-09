import { createHash } from "node:crypto";
import { z } from "zod";
import type { HostConfig, TerminalInfo } from "../shared/types.js";
import type {
  ResearchLab,
  ResearchManager,
  ResearchParticipant,
} from "../shared/research.js";
import type { PeerRuntimeStatus } from "./peer-delivery.js";
import { ResearchLabs, researchCreateSchema } from "./research-lab.js";
import { researchSettingsSchema } from "./research-settings.js";

const id = z.string().trim().min(1).max(256);
export const managerLaunchSchema = researchCreateSchema
  .omit({ terminalIds: true })
  .extend({
    requestId: id,
    context: z.string().trim().max(16000).default(""),
    claude: researchSettingsSchema.optional(),
    codex: researchSettingsSchema.optional(),
    sshSessionMode: z.enum(["direct", "tmux"]).default("direct"),
  })
  .strict();
export type ManagerLaunch = z.infer<typeof managerLaunchSchema>;
const statusSchema = z
  .object({
    labId: id.optional(),
    waitMs: z.number().int().min(0).max(25000).default(0),
  })
  .strict();
const controlSchema = z
  .object({
    labId: id,
    action: z.enum(["pause", "resume", "retry", "stop"]),
    directive: z.string().trim().min(1).max(4000).optional(),
  })
  .strict();

export const managerTools = [
  {
    name: "harbor_lab_hosts",
    description:
      "List registered Harbor host IDs and names (no credentials) for a user-requested managed lab. Launch defaults to your own terminal's host; use the user's specified host and project folder.",
    inputSchema: z.toJSONSchema(z.object({}).strict()),
  },
  {
    name: "harbor_lab_launch",
    description:
      "Only when the user asks you to delegate joint work: create a NEW Claude and NEW Codex in Harbor and start their lab. You remain manager, separate from both participants. Supply the actual goal, fixed constraints/context, completion criteria and project cwd. Stable requestId retries return the same lab; never change it to retry a timeout. Models/efforts default to each CLI's settings; explicit settings are validated before launch. SSH defaults to direct; tmux requires the user's choice. Native login, trust and command approvals remain native. Participants cannot recursively launch labs. Result 'connecting' is not receipt: use harbor_lab_status to inspect actual delivery/reports, then summarize results for the user. No existing conversations are restarted or attached.",
    inputSchema: z.toJSONSchema(managerLaunchSchema, { io: "input" }),
  },
  {
    name: "harbor_lab_status",
    description:
      "Read your managed lab's real participant connections, assignment receipt, reports, work and final result. Omit labId to list your labs. With labId, waitMs (0..25000) waits for progress or timeout; while monitoring use a bounded wait instead of rapid polling. Timeout is not completion. Results are agent-reported evidence, not independently verified tests. This does not submit reports or claim completion. Do not relaunch a connecting lab.",
    inputSchema: z.toJSONSchema(statusSchema),
  },
  {
    name: "harbor_lab_control",
    description:
      "Control only a lab created by your authenticated manager conversation: pause new assignments (in-flight native work continues), resume, retry delivery, or stop (pause then close its still-bound owned terminals). Stop preserves reports and never marks unfinished work complete. An optional directive on resume starts a revised analysis within the user's authorized scope. Cannot answer a user-only pending decision or override native approval. Cannot close unrelated/reused sessions; partial close failures are returned. The user may also control the lab in Harbor's Research tab.",
    inputSchema: z.toJSONSchema(controlSchema),
  },
];

interface Options {
  labs: ResearchLabs;
  terminals(): TerminalInfo[];
  runtime(id: string): PeerRuntimeStatus | undefined;
  hosts(): Pick<HostConfig, "id" | "name" | "kind">[];
  /** Validates both settings and prepares isolated workspaces before opening either CLI. */
  prepare(input: ManagerLaunch & { hostId: string }): Promise<{
    cwd: string;
    workspace?: ResearchLab["workspace"];
    spawn(index: 0 | 1): Promise<ResearchParticipant>;
  }>;
  close(id: string): Promise<void>;
}

/** Authority is the native conversation, never owner IDs supplied in tool arguments. */
export class ResearchLabManager {
  private pending = new Map<
    string,
    { fingerprint: string; promise: Promise<unknown> }
  >();
  private controls = new Set<string>();
  private watchers = new Set<string>();
  constructor(private options: Options) {}

  private actor(terminalId: string) {
    const terminal = this.options
      .terminals()
      .find((t) => t.id === terminalId && !t.exited);
    const runtime = this.options.runtime(terminalId);
    if (
      !terminal ||
      !runtime?.sessionId ||
      runtime.state === "offline" ||
      (terminal.agentSessionId && terminal.agentSessionId !== runtime.sessionId)
    )
      throw new Error(
        "현재 AI 대화의 연결을 확인할 수 없습니다. Harbor에서 원래 대화를 연결하세요.",
      );
    return {
      terminalId,
      hostId: terminal.hostId,
      sessionId: runtime.sessionId,
      kind: runtime.kind,
      name: terminal.title.slice(0, 200),
    };
  }

  private sameOwner(
    owner: Pick<ResearchManager, "hostId" | "kind" | "sessionId"> | undefined,
    actor: ReturnType<ResearchLabManager["actor"]>,
  ) {
    return (
      !!owner &&
      owner.hostId === actor.hostId &&
      owner.kind === actor.kind &&
      owner.sessionId === actor.sessionId
    );
  }

  private owned(terminalId: string, labId: string) {
    const actor = this.actor(terminalId);
    const lab = this.options.labs.get(labId);
    if (!this.sameOwner(lab.manager, actor))
      throw new Error("이 관리자 대화가 만든 연구실만 관리할 수 있습니다.");
    return lab;
  }

  async call(
    terminalId: string,
    tool: string,
    args: unknown,
  ): Promise<unknown> {
    const actor = this.actor(terminalId);
    switch (tool) {
      case "harbor_lab_hosts":
        z.object({}).strict().parse(args);
        return {
          currentHostId: actor.hostId,
          hosts: this.options
            .hosts()
            .map(({ id, name, kind }) => ({ id, name, kind })),
        };
      case "harbor_lab_launch":
        return this.launch(terminalId, args);
      case "harbor_lab_status": {
        const { labId, waitMs } = statusSchema.parse(args);
        if (labId) {
          const current = this.owned(terminalId, labId);
          if (waitMs && ["connecting", "running"].includes(current.status)) {
            if (this.watchers.has(terminalId))
              throw new Error(
                "이 관리자 대화의 진행 조회가 이미 대기 중입니다.",
              );
            this.watchers.add(terminalId);
            try {
              await this.waitForChange(labId, waitMs);
            } finally {
              this.watchers.delete(terminalId);
            }
            this.owned(terminalId, labId);
          }
          return this.view(labId);
        }
        if (waitMs)
          throw new Error("진행을 기다릴 연구실의 labId를 지정하세요.");
        return {
          labs: this.options.labs
            .list()
            .filter((l) => this.sameOwner(l.manager, actor))
            .map((l) => ({
              id: l.id,
              title: l.title,
              hostId: l.hostId,
              status: l.status,
              phase: l.phase,
              updatedAt: l.updatedAt,
              attention: l.attention,
            })),
        };
      }
      case "harbor_lab_control":
        return this.control(terminalId, args);
      default:
        throw new Error("Unknown manager tool");
    }
  }

  private view(labId: string) {
    const lab = this.options.labs.list().find((l) => l.id === labId);
    if (!lab) throw new Error("연구실이 삭제되었습니다.");
    return {
      ...lab,
      assignments: lab.assignments.slice(-12),
      works: lab.works.slice(-30),
      events: lab.events.slice(-20),
      totals: {
        assignments: lab.assignments.length,
        works: lab.works.length,
        events: lab.events.length,
      },
      note: "Connections and delivery are observed by Harbor; reports/work are participant claims. Only status=completed means the lab met its completion process. Native login/approval may need the user in the participant terminal.",
    };
  }

  private waitForChange(labId: string, waitMs: number) {
    const labs = this.options.labs;
    const before = JSON.stringify(this.view(labId));
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        labs.off("change", changed);
        resolve();
      };
      const changed = () => {
        try {
          if (JSON.stringify(this.view(labId)) !== before) finish();
        } catch {
          finish();
        }
      };
      const timer = setTimeout(finish, waitMs);
      labs.on("change", changed);
    });
  }

  private launch(terminalId: string, args: unknown) {
    const actor = this.actor(terminalId);
    const parsed = managerLaunchSchema.parse(args);
    const input = { ...parsed, hostId: parsed.hostId || actor.hostId };
    if (!this.options.hosts().some((h) => h.id === input.hostId))
      throw new Error("Harbor에 등록된 서버를 선택하세요.");
    if (
      this.options.labs
        .list()
        .some(
          (l) =>
            l.status !== "completed" &&
            l.participants.some(
              (p) =>
                p.hostId === actor.hostId &&
                p.kind === actor.kind &&
                (p.sessionId === actor.sessionId ||
                  p.terminalId === terminalId),
            ),
        )
    )
      throw new Error(
        "연구 참여자는 추가 연구실을 만들 수 없습니다. 별도 관리자 대화에서 요청하세요.",
      );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const existing = this.options.labs
      .list()
      .find(
        (l) =>
          this.sameOwner(l.manager, actor) &&
          l.manager?.requestId === input.requestId,
      );
    if (existing) {
      if (existing.manager!.fingerprint !== fingerprint)
        throw new Error(
          "같은 requestId의 요청 내용이 달라졌습니다. 기존 연구실을 확인하세요.",
        );
      return Promise.resolve(this.view(existing.id));
    }
    const key = JSON.stringify([
      actor.hostId,
      actor.kind,
      actor.sessionId,
      input.requestId,
    ]);
    const pending = this.pending.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint)
        throw new Error("같은 requestId의 실행 요청이 이미 처리 중입니다.");
      return pending.promise;
    }
    // One concurrent launch per manager prevents accidental fan-out from repeated tool calls.
    const ownerPrefix =
      JSON.stringify([actor.hostId, actor.kind, actor.sessionId]).slice(0, -1) +
      ",";
    if ([...this.pending.keys()].some((k) => k.startsWith(ownerPrefix)))
      throw new Error(
        "이 관리자 대화의 새 연구실을 만드는 중입니다. 기존 requestId로 결과를 확인하세요.",
      );
    const promise = (async () => {
      const participants: ResearchParticipant[] = [];
      try {
        const prepared = await this.options.prepare(input);
        for (const index of [0, 1] as const) {
          if (!this.sameOwner(actor, this.actor(terminalId)))
            throw new Error("관리자 대화가 변경되어 실행을 취소했습니다.");
          participants.push(await prepared.spawn(index));
        }
        if (!this.sameOwner(actor, this.actor(terminalId)))
          throw new Error("관리자 대화가 변경되어 실행을 취소했습니다.");
        const lab = this.options.labs.create(
          {
            title: input.title,
            hostId: input.hostId,
            goal: input.goal,
            kind: input.kind,
            cwd: prepared.cwd,
            criteria: input.criteria,
            effort: input.effort,
          },
          participants,
          prepared.workspace,
          {
            manager: { ...actor, requestId: input.requestId, fingerprint },
            context: input.context,
          },
        );
        return this.view(lab.id);
      } catch (error) {
        const results = await Promise.allSettled(
          participants.map((p) => this.options.close(p.terminalId)),
        );
        const unclosed = participants
          .filter((_, i) => results[i].status === "rejected")
          .map((p) => p.terminalId);
        if (unclosed.length)
          throw new Error(
            `${error instanceof Error ? error.message : error} 생성 중 오류로 중단했으나 종료 확인이 필요한 새 터미널: ${unclosed.join(", ")}`,
          );
        throw error;
      }
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, { fingerprint, promise });
    return promise;
  }

  private async control(terminalId: string, args: unknown) {
    const { labId, action, directive } = controlSchema.parse(args);
    const lab = this.owned(terminalId, labId);
    if (directive && action !== "resume")
      throw new Error("추가 지시는 resume 동작에만 사용할 수 있습니다.");
    if (lab.pendingDecision && (action === "resume" || action === "retry"))
      throw new Error(
        "사용자만 결정할 수 있는 질문이 대기 중입니다. 관리자가 대신 승인할 수 없습니다.",
      );
    if (this.controls.has(labId))
      throw new Error("이 연구실의 관리 동작을 처리 중입니다.");
    this.controls.add(labId);
    try {
      if (action !== "stop") {
        this.options.labs.control(
          labId,
          action,
          directive,
          undefined,
          "manager",
        );
        return this.view(labId);
      }
      if (lab.status !== "completed")
        this.options.labs.control(
          labId,
          "pause",
          undefined,
          undefined,
          "manager",
        );
      const closed: string[] = [],
        failures: Array<{ terminalId: string; reason: string }> = [];
      for (const p of lab.participants) {
        const current = this.options
          .terminals()
          .find((t) => t.id === p.terminalId);
        if (!current || current.exited) continue;
        const runtime = this.options.runtime(p.terminalId);
        const identities = [runtime?.sessionId, current.agentSessionId].filter(
          Boolean,
        );
        if (
          !p.owned ||
          current.hostId !== p.hostId ||
          (p.sessionId &&
            (!identities.length ||
              identities.some((id) => id !== p.sessionId))) ||
          (current.agentKind && current.agentKind !== p.kind) ||
          (runtime && runtime.kind !== p.kind)
        ) {
          failures.push({
            terminalId: p.terminalId,
            reason:
              "참여 대화가 변경되었거나 소유한 터미널이 아니므로 종료하지 않았습니다.",
          });
          continue;
        }
        try {
          await this.options.close(p.terminalId);
          closed.push(p.terminalId);
        } catch (error) {
          failures.push({
            terminalId: p.terminalId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { lab: this.view(labId), closed, failures };
    } finally {
      this.controls.delete(labId);
    }
  }
}
