import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Router, type Request } from "express";
import { z } from "zod";
import type { TerminalInfo } from "../shared/types.js";
import type { WorkflowTemplate } from "../shared/research.js";
import type { ResearchLabs } from "./research-lab.js";

const template = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(160),
    steps: z.array(z.string().trim().min(1).max(800)).min(1).max(12),
  })
  .strict();
const selectedMember = z
  .object({
    id: z.string().min(1),
    nativeId: z.string().min(1),
    hostId: z.string().min(1),
    cwd: z.string().min(1),
  })
  .strict();
const start = z
  .object({
    requestId: z.string().uuid(),
    templateId: z.string().uuid(),
    goal: z.string().trim().min(1).max(7000),
    members: z.tuple([selectedMember, selectedMember]),
  })
  .strict();

/** Templates specify a native lab workflow. Each run keeps its own immutable copy. */
export function workflowRouter(
  directory: string,
  labs: ResearchLabs,
  terminal: (id: string) => TerminalInfo | undefined,
  authorize: (req: Request, id: string) => void,
) {
  const file = join(directory, "workflow-templates.json"),
    router = Router();
  let templates: WorkflowTemplate[] = [];
  try {
    templates = z
      .array(template)
      .max(100)
      .parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const save = (next: WorkflowTemplate[]) => {
    const temporary = file + "." + randomUUID() + ".tmp";
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    renameSync(temporary, file);
    templates = next;
  };
  router.get("/", (_req, res) => res.json(templates));
  router.post("/", (req, res) => {
    const input = template.parse(req.body);
    const previous = templates.find((t) => t.id === input.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(input))
      throw Error("같은 ID의 템플릿이 이미 있습니다.");
    if (!previous) {
      if (templates.length >= 100)
        throw Error("템플릿은 100개까지 저장할 수 있습니다.");
      save([...templates, input]);
    }
    res.json(input);
  });
  router.delete("/:id", (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    save(templates.filter((t) => t.id !== id));
    res.json({ ok: true });
  });
  router.post("/runs", (req, res) => {
    const input = start.parse(req.body),
      fingerprint = createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex");
    for (const m of input.members) authorize(req, m.id);
    const existing = labs
      .list()
      .find((l) => l.workflow?.requestId === input.requestId);
    if (existing) {
      if (existing.workflow?.fingerprint !== fingerprint)
        throw Error("기존 실행과 요청 내용이 다릅니다.");
      res.json(existing);
      return;
    }
    const saved = templates.find((t) => t.id === input.templateId);
    if (!saved) throw Error("템플릿을 찾을 수 없습니다.");
    const participants = input.members.map((m) => {
      const t = terminal(m.id);
      if (
        !t ||
        t.exited ||
        !t.agentConnected ||
        !t.agentKind ||
        t.hostId !== m.hostId ||
        t.cwd !== m.cwd ||
        t.agentSessionId !== m.nativeId
      )
        throw Error("실행할 AI 대화를 다시 선택하세요.");
      if (t.agentState === "working" || t.agentState === "waiting")
        throw Error("현재 작업 또는 확인이 끝난 후 사용할 수 있습니다.");
      return {
        terminalId: t.id,
        sessionId: m.nativeId,
        hostId: t.hostId,
        name: t.title,
        kind: t.agentKind,
        cwd: t.cwd,
        owned: false,
      };
    });
    const lead = participants[0];
    const result = labs.create(
      {
        hostId: lead.hostId,
        cwd: lead.cwd,
        title: saved.title,
        kind: "research",
        effort: "default",
        goal: input.goal,
        criteria: [
          "워크플로에 지정한 모든 단계의 결과와 산출물을 모아 검토한다.",
        ],
      },
      participants,
      undefined,
      undefined,
      { ...saved, requestId: input.requestId, fingerprint },
    );
    res.json(result);
  });
  return router;
}
