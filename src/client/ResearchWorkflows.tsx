import { useEffect, useRef, useState } from "react";
import type { AppState } from "../shared/types";
import type { ResearchLab, WorkflowTemplate } from "../shared/research";
import { workflowResults } from "../shared/research";
import { api } from "./api";
import { Modal } from "./Dialogs";

export function ResearchWorkflows({
  state,
  onStarted,
}: {
  state: AppState;
  onStarted: (lab: ResearchLab) => void;
}) {
  const [open, setOpen] = useState(false),
    [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [selected, setSelected] = useState(""),
    [title, setTitle] = useState(""),
    [steps, setSteps] = useState("");
  const [goal, setGoal] = useState(""),
    [lead, setLead] = useState(""),
    [partner, setPartner] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const attempt = useRef({ fingerprint: "", id: "" });
  const terminals = state.terminals.filter(
    (t) => !t.exited && t.agentConnected && t.agentKind && t.agentSessionId,
  );
  useEffect(() => {
    if (!open) return;
    let active = true;
    api<WorkflowTemplate[]>("/research-workflows", undefined, "GET").then(
      (items) => {
        if (active) setTemplates(items);
      },
      (e) => {
        if (active) setError(e.message);
      },
    );
    return () => {
      active = false;
    };
  }, [open]);
  const selectedTemplate = templates.find((t) => t.id === selected);
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const requestId = (input: unknown) => {
    const fingerprint = JSON.stringify(input);
    if (attempt.current.fingerprint !== fingerprint)
      attempt.current = { fingerprint, id: crypto.randomUUID() };
    return attempt.current.id;
  };
  return (
    <>
      <button
        type="button"
        className="button secondary"
        onClick={() => setOpen(true)}
      >
        실험 워크플로
      </button>
      {open && (
        <Modal title="반복 실험 워크플로" onClose={() => setOpen(false)}>
          <div className="research-workflow-form">
            <label>
              템플릿
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="">새 템플릿</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
            </label>
            {!selectedTemplate ? (
              <>
                <label>
                  이름
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={160}
                  />
                </label>
                <label>
                  실행할 단계 (한 줄에 하나)
                  <textarea
                    rows={5}
                    value={steps}
                    onChange={(e) => setSteps(e.target.value)}
                    placeholder={"벤치마크 실행\n측정 결과 수집\n비교표 작성"}
                  />
                </label>
                <button
                  className="button secondary"
                  disabled={busy || !title.trim() || !steps.trim()}
                  onClick={() =>
                    void act(async () => {
                      const data = {
                        title: title.trim(),
                        steps: steps
                          .split(/\r?\n/)
                          .map((x) => x.trim())
                          .filter(Boolean),
                      };
                      const saved = await api<WorkflowTemplate>(
                        "/research-workflows",
                        { ...data, id: requestId(data) },
                      );
                      setTemplates((old) => [
                        ...old.filter((t) => t.id !== saved.id),
                        saved,
                      ]);
                      setSelected(saved.id);
                      setTitle("");
                      setSteps("");
                    })
                  }
                >
                  템플릿 저장
                </button>
              </>
            ) : (
              <>
                <ol>
                  {selectedTemplate.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await api(
                        "/research-workflows/" + selected,
                        undefined,
                        "DELETE",
                      );
                      setTemplates((old) =>
                        old.filter((t) => t.id !== selected),
                      );
                      setSelected("");
                    })
                  }
                >
                  템플릿 삭제
                </button>
                <label>
                  이번 실행의 대상·조건
                  <textarea
                    value={goal}
                    rows={3}
                    maxLength={7000}
                    onChange={(e) => setGoal(e.target.value)}
                  />
                </label>
                {(["실행 담당", "검토 담당"] as const).map((name, i) => (
                  <label key={name}>
                    {name}
                    <select
                      value={i === 0 ? lead : partner}
                      onChange={(e) =>
                        (i === 0 ? setLead : setPartner)(e.target.value)
                      }
                    >
                      <option value="">열린 AI 대화 선택</option>
                      {terminals.map((t) => (
                        <option value={t.id} key={t.id}>
                          {state.hosts.find((h) => h.id === t.hostId)?.name} ·{" "}
                          {t.title}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
                <button
                  className="button primary"
                  disabled={
                    busy ||
                    !goal.trim() ||
                    !lead ||
                    !partner ||
                    lead === partner
                  }
                  onClick={() =>
                    void act(async () => {
                      const data = {
                        templateId: selected,
                        goal: goal.trim(),
                        members: [lead, partner].map((id) => ({
                          id,
                          hostId: terminals.find((t) => t.id === id)?.hostId,
                          cwd: terminals.find((t) => t.id === id)?.cwd,
                          nativeId: terminals.find((t) => t.id === id)
                            ?.agentSessionId,
                        })),
                      };
                      const run = await api<ResearchLab>(
                        "/research-workflows/runs",
                        { ...data, requestId: requestId(data) },
                      );
                      attempt.current = { fingerprint: "", id: "" };
                      setOpen(false);
                      onStarted(run);
                    })
                  }
                >
                  선택한 세션에서 실행
                </button>
              </>
            )}
            {error && <p role="alert">{error}</p>}
          </div>
        </Modal>
      )}
    </>
  );
}

export function WorkflowProgress({ lab }: { lab: ResearchLab }) {
  return lab.workflow ? (
    <section aria-label="워크플로 단계">
      <b>{lab.workflow.title}</b>
      <ol>
        {workflowResults(lab).map(({ description: s, index: i, work }) => {
          return (
            <li key={i}>
              {s} ·{" "}
              {work
                ? {
                    running: "실행 중",
                    completed: "결과 기록됨",
                    failed: "실패",
                  }[work.status]
                : "대기"}
              {work?.metrics && <p>{work.metrics}</p>}
              {work?.result && <p>{work.result}</p>}
              {work?.artifacts.map((path) => (
                <code key={path}>{path} </code>
              ))}
            </li>
          );
        })}
      </ol>
    </section>
  ) : null;
}
