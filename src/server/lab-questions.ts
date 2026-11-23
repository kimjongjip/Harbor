import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Router } from "express";
import { z } from "zod";
import type {
  LabQuestion,
  LabMember,
  LabQuestionInput,
  LabAction,
  LabPhase,
  LabReply,
} from "../shared/lab-question.js";

const member = z
  .object({
    provider: z.enum(["codex", "claude", "antigravity"]),
    hostId: z.string().min(1).max(160),
    model: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[\w.:/-]+$/)
      .optional(),
  })
  .strict();
export const labQuestionInput = z
  .object({
    requestId: z.string().uuid(),
    question: z.string().trim().min(1).max(12000),
    material: z.string().max(24000).default(""),
    debate: z.boolean(),
    members: z.array(member).min(2).max(3),
    chair: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.members.map((m) => m.provider)).size === v.members.length &&
      v.chair < v.members.length,
    "서로 다른 AI와 종합 담당을 선택하세요.",
  );

export type LabRunner = (
  member: LabMember,
  prompt: string,
  signal: AbortSignal,
) => Promise<string | { text: string; nativeId: string; model?: string }>;
type Persisted = {
  job: LabQuestion;
  fingerprint: string;
  hostBindings: string[];
};
const fingerprint = (input: unknown) =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");
const replies = (indices: number[]): LabReply[] =>
  indices.map((member) => ({ member, status: "pending" }));
const successful = (rows: LabReply[]) =>
  rows.filter((r) => r.status === "done");
const conflict = (text: string) =>
  Object.assign(new Error(text), { status: 409 });

export class LabQuestions {
  private records = new Map<string, Persisted>();
  private summaries = new Map<
    string,
    {
      view: Pick<
        LabQuestion,
        "id" | "question" | "status" | "phase" | "createdAt"
      >;
      hosts: string[];
    }
  >();
  private active = new Map<string, AbortController>();
  private directory: string;
  constructor(
    directory: string,
    private run: LabRunner,
    private binding: (member: LabMember) => string,
  ) {
    this.directory = join(directory, "lab-questions");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(this.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/i.test(name)) continue;
      const record = JSON.parse(
        readFileSync(join(this.directory, name), "utf8"),
      ) as Persisted;
      if (record.job.id + ".json" !== name)
        throw Error("연구실 기록 ID가 일치하지 않습니다.");
      this.records.set(record.job.id, record);
      this.index(record.job);
      if (record.job.status === "working") this.stop(record.job);
      this.records.delete(record.job.id);
    }
  }
  private index(job: LabQuestion) {
    this.summaries.set(job.id, {
      view: {
        id: job.id,
        question: job.question.slice(0, 160),
        status: job.status,
        phase: job.phase,
        createdAt: job.createdAt,
      },
      hosts: job.members.map((m) => m.hostId),
    });
  }
  private lookup(id: string) {
    let record = this.records.get(id);
    if (!record && this.summaries.has(id)) {
      record = JSON.parse(
        readFileSync(join(this.directory, id + ".json"), "utf8"),
      ) as Persisted;
      this.records.set(id, record);
      if (this.records.size > this.active.size + 12) {
        for (const cached of this.records.keys())
          if (cached !== id && !this.active.has(cached)) {
            this.records.delete(cached);
            break;
          }
      }
    }
    return record;
  }
  private save(job: LabQuestion) {
    const path = join(this.directory, job.id + ".json");
    writeFileSync(path + ".tmp", JSON.stringify(this.records.get(job.id)), {
      mode: 0o600,
    });
    renameSync(path + ".tmp", path);
    this.index(job);
    if (job.status !== "working") this.records.delete(job.id);
  }
  list() {
    return [...this.summaries.values()]
      .map((x) => x.view)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  canRead(id: string, hosts: Set<string>) {
    return (
      this.summaries.get(id)?.hosts.every((host) => hosts.has(host)) ?? false
    );
  }
  get(id: string) {
    const record = this.lookup(id);
    if (!record)
      throw Object.assign(Error("연구실 질문을 찾지 못했습니다."), {
        status: 404,
      });
    return structuredClone(record.job);
  }
  create(input: LabQuestionInput) {
    input = labQuestionInput.parse(input);
    const existing = this.lookup(input.requestId);
    const hash = fingerprint(input);
    if (existing) {
      if (existing.fingerprint !== hash)
        throw conflict("같은 요청 ID에 다른 질문을 담을 수 없습니다.");
      return this.get(existing.job.id);
    }
    if (this.active.size >= 12)
      throw conflict("실행 중인 질문이 많습니다. 잠시 후 다시 시도하세요.");
    const hostBindings = input.members.map(this.binding);
    const job: LabQuestion = {
      ...input,
      id: input.requestId,
      createdAt: Date.now(),
      phase: "answers",
      status: "working",
      answers: replies(input.members.map((_, i) => i)),
      reviews: [],
      conclusion: [],
    };
    this.records.set(job.id, { job, fingerprint: hash, hostBindings });
    this.launch(job);
    return this.get(job.id);
  }
  private stop(job: LabQuestion) {
    this.active.get(job.id)?.abort();
    this.active.delete(job.id);
    for (const r of job[job.phase])
      if (r.status === "running" || r.status === "pending")
        r.status = "interrupted";
    job.status = "stopped";
    this.save(job);
  }
  close() {
    for (const id of this.active.keys()) this.stop(this.records.get(id)!.job);
  }
  control(id: string, action: LabAction, chair?: number) {
    const record = this.lookup(id);
    if (!record) return this.get(id);
    const job = record.job;
    if (action === "cancel") {
      if (job.status === "working") this.stop(job);
      return this.get(id);
    }
    if (job.status === "working") throw conflict("현재 응답을 기다려 주세요.");
    if (this.active.size >= 12)
      throw conflict("실행 중인 질문이 많습니다. 잠시 후 다시 시도하세요.");
    if (action === "retry") {
      const pending = job[job.phase].filter((r) => r.status !== "done");
      if (!pending.length) throw conflict("다시 실행할 응답이 없습니다.");
      pending.forEach((r) => {
        r.status = "pending";
        delete r.error;
      });
    } else if (action === "review") {
      if (job.phase !== "answers" || successful(job.answers).length < 2)
        throw conflict("두 개 이상의 독립 답변이 필요합니다.");
      job.phase = "reviews";
      job.reviews = replies(successful(job.answers).map((r) => r.member));
    } else {
      if (job.phase !== "reviews" || !successful(job.reviews).length)
        throw conflict("완료된 상호 검토가 필요합니다.");
      const picked = chair ?? job.chair;
      if (!successful(job.reviews).some((r) => r.member === picked))
        throw conflict("검토를 완료한 종합 담당을 선택하세요.");
      job.chair = picked;
      job.phase = "conclusion";
      job.conclusion = replies([picked]);
    }
    this.launch(job);
    return this.get(id);
  }
  private prompt(job: LabQuestion, phase: LabPhase) {
    const base = [
      "자료와 질문을 분석하고 사용자의 언어로 답하세요. 파일 수정이나 명령 실행 없이 제공된 자료만 사용하세요.",
      "질문",
      job.question,
      "공유 자료",
      job.material || "(없음)",
    ];
    const evidence = (rows: LabReply[]) =>
      JSON.stringify(
        successful(rows).map((r) => ({
          author: job.members[r.member].provider,
          text: r.text,
        })),
      );
    if (phase !== "answers")
      base.push("독립 답변 (검토할 자료)", evidence(job.answers));
    if (phase === "reviews")
      base.push("각 주장과 근거를 비교하고 이견 및 보완할 점을 제시하세요.");
    if (phase === "conclusion")
      base.push(
        "상호 검토 (검토할 자료)",
        evidence(job.reviews),
        "결론, 근거, 남은 이견, 다음 확인 사항을 정리하세요.",
      );
    return base.join("\n\n");
  }
  private launch(job: LabQuestion) {
    const ctrl = new AbortController();
    this.active.set(job.id, ctrl);
    job.status = "working";
    const phase = job.phase,
      rows = job[phase],
      prompt = this.prompt(job, phase);
    try {
      this.save(job);
    } catch (error) {
      this.active.delete(job.id);
      job.status = "stopped";
      if (!this.summaries.has(job.id)) this.records.delete(job.id);
      throw error;
    }
    const tasks = rows
      .filter((r) => r.status === "pending")
      .map(async (row) => {
        const m = job.members[row.member];
        row.status = "running";
        try {
          if (
            this.records.get(job.id)!.hostBindings[row.member] !==
            this.binding(m)
          )
            throw Error("원래 서버 연결 설정이 변경됐습니다.");
          const timeout = AbortSignal.timeout(20 * 60 * 1000);
          const signal = AbortSignal.any([ctrl.signal, timeout]);
          const result = await this.run(m, prompt, signal);
          if (ctrl.signal.aborted) return;
          const answer = typeof result === "string" ? result : result.text;
          if (typeof result !== "string") {
            row.nativeId = result.nativeId;
            row.model = result.model;
          }
          if (!answer.trim()) throw Error("답변이 비어 있습니다.");
          if (answer.length > 128000)
            throw Error("답변 보관 한도를 초과했습니다.");
          row.text = answer.trim();
          row.status = "done";
        } catch (e) {
          if (ctrl.signal.aborted) return;
          row.error =
            e instanceof Error ? e.message.slice(0, 1000) : "AI 응답 실패";
          row.status = "failed";
        }
        this.save(job);
      });
    void Promise.all(tasks)
      .then(() => {
        if (ctrl.signal.aborted) return;
        this.active.delete(job.id);
        job.status = rows.every((r) => r.status === "done")
          ? "ready"
          : "partial";
        this.save(job);
        if (job.status === "ready" && phase === "answers" && job.debate)
          this.control(job.id, "review");
        if (
          job.status === "ready" &&
          phase === "reviews" &&
          successful(rows).some((r) => r.member === job.chair)
        )
          this.control(job.id, "conclude");
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        ctrl.abort();
        this.active.delete(job.id);
        job.status = "stopped";
        for (const row of rows)
          if (row.status === "running" || row.status === "pending")
            row.status = "interrupted";
        this.index(job);
        // Keep the last in-memory answer accessible if the disk becomes full.
        // A durable "working" snapshot is reopened as interrupted after restart.
        try {
          this.save(job);
        } catch {}
        console.error(
          "Lab question persistence failed",
          job.id,
          e instanceof Error ? e.name : "Error",
        );
      });
  }
}

export function labQuestionRouter(
  lab: LabQuestions,
  allowedHosts?: (res: import("express").Response) => Set<string>,
) {
  const r = Router();
  function check(members: LabMember[], res: import("express").Response) {
    const hosts = allowedHosts?.(res);
    if (hosts && !members.every((m) => hosts.has(m.hostId)))
      throw Object.assign(Error("이 기기에서 열 수 없는 서버입니다."), {
        status: 403,
      });
  }
  r.get("/", (_req, res) => {
    const hosts = allowedHosts?.(res);
    res.json(lab.list().filter((j) => !hosts || lab.canRead(j.id, hosts)));
  });
  r.get("/:id", (req, res) => {
    const job = lab.get(req.params.id);
    check(job.members, res);
    res.json(job);
  });
  r.post("/", (req, res) => {
    const input = labQuestionInput.parse(req.body);
    check(input.members, res);
    res.json(lab.create(input));
  });
  r.post("/:id", (req, res) => {
    check(lab.get(req.params.id).members, res);
    const data = z
      .object({
        action: z.enum(["review", "conclude", "retry", "cancel"]),
        chair: z.number().int().min(0).max(2).optional(),
      })
      .strict()
      .parse(req.body);
    res.json(lab.control(req.params.id, data.action, data.chair));
  });
  return r;
}
