import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import type { AgentProvider } from "../shared/agent-provider";
import type {
  LabQuestion,
  LabMember,
  LabAction,
  LabPhase,
} from "../shared/lab-question";
import "./lab-questions.css";

type Host = {
  id: string;
  name: string;
  models?: { id: string }[];
  serverWorkspace?: boolean;
};
type Summary = Pick<
  LabQuestion,
  "id" | "question" | "createdAt" | "status" | "phase"
>;
type Request = <T>(path: string, body?: unknown, method?: string) => Promise<T>;
const providers: AgentProvider[] = ["codex", "claude", "antigravity"];
const names = {
  codex: "Codex",
  claude: "Claude",
  antigravity: "Gemini · Antigravity",
};
const steps = {
  pending: "대기",
  running: "응답 중",
  done: "완료",
  failed: "실패",
  interrupted: "중단",
};
const phases = {
  answers: "독립 답변",
  reviews: "상호 검토",
  conclusion: "종합 결과",
};
const states = {
  working: "진행 중",
  partial: "일부 응답 실패",
  ready: "완료",
  stopped: "중단됨",
};

function exportAnswers(job: LabQuestion) {
  const parts = ["# 연구실 질문", job.question];
  for (const phase of ["answers", "reviews", "conclusion"] as const) {
    const rows = job[phase].filter((reply) => reply.text);
    if (!rows.length) continue;
    parts.push("## " + phases[phase]);
    for (const row of rows)
      parts.push(
        "### " +
          names[job.members[row.member].provider] +
          (row.model ? " · " + row.model : ""),
        row.text!,
      );
  }
  const url = URL.createObjectURL(
    new Blob([parts.join("\n\n")], { type: "text/markdown;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "harbor-lab-" + job.id + ".md";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
interface LabQuestionProps {
  hosts: Host[];
  hostId: string;
  debate: boolean;
  request: Request;
  RenderAnswer: ComponentType<{ text: string }>;
  initialMaterial?: string;
}
export function LabQuestions(props: LabQuestionProps) {
  const enabled = props.hosts.filter((h) => h.serverWorkspace);
  const [owner, setOwner] = useState(() =>
    enabled.some((h) => h.id === props.hostId) ? props.hostId : "",
  );
  const remote = enabled.find((h) => h.id === owner);
  const request = useMemo<Request>(
    () =>
      remote
        ? (path, body, method) =>
            props.request(
              "/workspaces/" + encodeURIComponent(remote.id) + "/chat" + path,
              body,
              method,
            )
        : props.request,
    [remote?.id, props.request],
  );
  return (
    <>
      {enabled.length > 0 && (
        <label className="lab-owner">
          연구실 실행 위치
          <select
            value={remote?.id || ""}
            onChange={(e) => setOwner(e.target.value)}
          >
            <option value="">현재 Harbor</option>
            {enabled.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name} · 서버에서 계속 실행
              </option>
            ))}
          </select>
        </label>
      )}
      <LabQuestionForm
        key={remote?.id || "current"}
        {...props}
        request={request}
        hosts={remote ? [remote] : props.hosts}
        hostId={remote?.id || props.hostId}
      />
    </>
  );
}
function LabQuestionForm({
  hosts,
  hostId,
  debate,
  request,
  RenderAnswer,
  initialMaterial = "",
}: LabQuestionProps) {
  const [question, setQuestion] = useState(""),
    [material, setMaterial] = useState(initialMaterial);
  const [members, setMembers] = useState<LabMember[]>(() =>
    providers.slice(0, 2).map((provider) => ({
      provider,
      hostId: hostId || hosts[0]?.id || "local",
    })),
  );
  const [chair, setChair] = useState<AgentProvider>("codex");
  const [id, setId] = useState(""),
    [job, setJob] = useState<LabQuestion | null>(null);
  const [list, setList] = useState<Summary[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const key = useRef({ body: "", id: "" }),
    version = useRef(0);
  useEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const revision = version.current;
      try {
        const [history, detail] = await Promise.all([
          request<Summary[]>("/lab-questions", undefined, "GET"),
          id
            ? request<LabQuestion>("/lab-questions/" + id, undefined, "GET")
            : Promise.resolve(null),
        ]);
        if (active && revision === version.current) {
          setList(history);
          setJob(detail);
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
      if (active) timer = setTimeout(poll, id ? 1800 : 7000);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [request, id]);
  function change(p: AgentProvider, patch: Partial<LabMember>) {
    setMembers((old) =>
      old.map((m) => (m.provider === p ? { ...m, ...patch } : m)),
    );
  }
  async function perform(action?: LabAction, pick?: number) {
    setBusy(true);
    setError("");
    version.current++;
    try {
      let detail: LabQuestion;
      if (action)
        detail = await request("/lab-questions/" + id, { action, chair: pick });
      else {
        const input = {
          question,
          material,
          debate,
          members,
          chair: Math.max(
            0,
            members.findIndex((m) => m.provider === chair),
          ),
        };
        const identity = JSON.stringify(input);
        if (identity !== key.current.body)
          key.current = { body: identity, id: crypto.randomUUID() };
        detail = await request("/lab-questions", {
          ...input,
          requestId: key.current.id,
        });
      }
      version.current++;
      setJob(detail);
      setId(detail.id);
      setList((old) => [detail, ...old.filter((x) => x.id !== detail.id)]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="lab-questions">
      {list.length > 0 && (
        <label>
          질문 기록
          <select
            value={id}
            disabled={busy}
            onChange={(e) => {
              version.current++;
              setId(e.target.value);
              setJob(null);
              setError("");
              if (!e.target.value) {
                key.current = { body: "", id: "" };
                setQuestion("");
                setMaterial("");
              }
            }}
          >
            <option value="">새 질문</option>
            {list.map((j) => (
              <option value={j.id} key={j.id}>
                {j.question} · {states[j.status]}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <p role="alert">{error}</p>}
      {!id && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void perform();
          }}
        >
          <label>
            질문
            <textarea
              required
              rows={3}
              maxLength={12000}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </label>
          <label>
            함께 읽을 자료
            <textarea
              rows={2}
              maxLength={24000}
              value={material}
              placeholder="표·코드·대화에서 공유할 부분 붙여넣기"
              onChange={(e) => setMaterial(e.target.value)}
            />
          </label>
          <fieldset>
            <legend>참여할 AI</legend>
            {providers.map((p) => {
              const m = members.find((x) => x.provider === p),
                host = hosts.find((h) => h.id === m?.hostId);
              return (
                <div className="lab-member" key={p}>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!m}
                      onChange={() =>
                        setMembers((old) =>
                          m
                            ? old.filter((x) => x !== m)
                            : [
                                ...old,
                                {
                                  provider: p,
                                  hostId: hostId || hosts[0]?.id || "local",
                                },
                              ],
                        )
                      }
                    />
                    {names[p]}
                  </label>
                  {m && (
                    <>
                      <select
                        aria-label={names[p] + " 서버"}
                        value={m.hostId}
                        onChange={(e) =>
                          change(p, {
                            hostId: e.target.value,
                            model: undefined,
                          })
                        }
                      >
                        {hosts.map((h) => (
                          <option key={h.id} value={h.id}>
                            {h.name}
                          </option>
                        ))}
                      </select>
                      <input
                        aria-label={names[p] + " 모델"}
                        value={m.model || ""}
                        maxLength={160}
                        list={"lab-models-" + p}
                        placeholder={
                          p === "antigravity"
                            ? "서버의 Gemini 모델"
                            : "서버 기본 모델"
                        }
                        onChange={(e) =>
                          change(p, {
                            model: e.target.value.trim() || undefined,
                          })
                        }
                      />
                      {p === "codex" && (
                        <datalist id={"lab-models-" + p}>
                          {host?.models?.map((x) => (
                            <option key={x.id} value={x.id} />
                          ))}
                        </datalist>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </fieldset>
          {members.length >= 2 && (
            <label>
              종합 담당
              <select
                value={
                  members.find((m) => m.provider === chair)?.provider ||
                  members[0].provider
                }
                onChange={(e) => setChair(e.target.value as AgentProvider)}
              >
                {members.map((m) => (
                  <option key={m.provider} value={m.provider}>
                    {names[m.provider]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            className="button primary"
            disabled={busy || !question.trim() || members.length < 2}
          >
            {debate ? "함께 토론하기" : "각자에게 묻기"}
          </button>
        </form>
      )}
      {id && !job && <p role="status">질문 기록을 읽는 중…</p>}
      {job && (
        <section>
          <h3>{job.question}</h3>
          <p>
            {phases[job.phase]} · {states[job.status]}
          </p>
          {job.material && (
            <details>
              <summary>공유한 자료</summary>
              <pre>{job.material}</pre>
            </details>
          )}
          {(["answers", "reviews", "conclusion"] as LabPhase[]).map(
            (phase) =>
              job[phase].length > 0 && (
                <section key={phase}>
                  <h4>{phases[phase]}</h4>
                  {job[phase].map((row) => {
                    const m = job.members[row.member];
                    return (
                      <article key={row.member}>
                        <strong>{names[m.provider]}</strong>{" "}
                        <small>
                          {hosts.find((h) => h.id === m.hostId)?.name ||
                            m.hostId}{" "}
                          · {row.model || m.model || "기본 모델"} ·{" "}
                          {steps[row.status]}
                        </small>
                        {row.error && <p role="alert">{row.error}</p>}
                        {row.text && <RenderAnswer text={row.text} />}
                      </article>
                    );
                  })}
                </section>
              ),
          )}
          <div className="lab-actions">
            {job.answers.some((r) => r.text) && (
              <button onClick={() => exportAnswers(job)}>
                질문·답변 내보내기
              </button>
            )}
            {job.status === "working" && (
              <button disabled={busy} onClick={() => void perform("cancel")}>
                토론·응답 중단
              </button>
            )}
            {job.status !== "working" &&
              job[job.phase].some((r) => r.status !== "done") && (
                <button disabled={busy} onClick={() => void perform("retry")}>
                  미완료 응답 다시 요청
                </button>
              )}
            {job.status !== "working" &&
              job.phase === "answers" &&
              job.answers.filter((r) => r.status === "done").length >= 2 && (
                <button disabled={busy} onClick={() => void perform("review")}>
                  받은 답으로 토론하기
                </button>
              )}
            {job.status !== "working" &&
              job.phase === "reviews" &&
              job.reviews
                .filter((r) => r.status === "done")
                .map((r) => (
                  <button
                    key={r.member}
                    disabled={busy}
                    onClick={() => void perform("conclude", r.member)}
                  >
                    {names[job.members[r.member].provider]}에게 종합 요청
                  </button>
                ))}
          </div>
        </section>
      )}
    </div>
  );
}
