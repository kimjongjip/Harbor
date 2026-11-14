import { useEffect, useState } from "react";
import { MessageSquare, Play, Send } from "lucide-react";
import type { AppState } from "../shared/types";
import type {
  ResearchLab,
  ResearchLabView,
  ResearchConversation,
  ResearchEffort,
  ResearchPlanRequest,
} from "../shared/research";
import { api } from "./api";
import { insertTerminalDraft } from "./terminalDraft";
import { writeLocalClipboard } from "./terminalSelection";
import { Modal } from "./Dialogs";
import { researchEffortsFor } from "../shared/research";
import {
  ResearchSettingsFields,
  ResearchSettingsSummary,
} from "./ResearchSettings";

const criteriaFor = {
  ideas: [
    "서로 다른 접근을 비교하고 추천 이유를 설명한다",
    "가정·한계와 검증할 다음 단계를 정리한다",
  ],
  code: ["요구한 동작을 구현한다", "관련 검증 결과와 변경 위치를 기록한다"],
  research: [
    "질문에 대한 근거와 재현 가능한 결과를 제시한다",
    "한계와 남은 불확실성을 명시한다",
  ],
};
function available(state: AppState) {
  return state.terminals.filter(
    (t) =>
      !t.exited &&
      !!t.agentKind &&
      !state.researchLabs?.some(
        (l) =>
          l.status !== "completed" &&
          l.participants.some((p) => p.terminalId === t.id),
      ),
  );
}

export function NewResearchDialog({
  state,
  initialCwd,
  initialHostId,
  initialTerminalId,
  onClose,
  onCreated,
}: {
  state: AppState;
  initialCwd: string;
  initialHostId: string;
  initialTerminalId?: string;
  onClose(): void;
  onCreated(lab: ResearchLab): void;
}) {
  const sessions = available(state);
  const current = sessions.find((t) => t.id === initialTerminalId);
  const [mode, setMode] = useState(current ? "existing" : "new");
  const [terminalId, setTerminalId] = useState(
    current?.id || sessions[0]?.id || "",
  );
  const [title, setTitle] = useState("");
  const [hostId, setHostId] = useState(
    initialHostId || state.hosts[0]?.id || "",
  );
  const [cwd, setCwd] = useState(initialCwd || "~");
  const [leadKind, setLeadKind] = useState<"claude" | "codex">("claude");
  const [effort, setEffort] = useState<ResearchEffort>("low");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title="새 연구실"
      subtitle="먼저 한 AI와 대화하세요. 주제와 목표는 대화하며 정하고, 다른 AI는 준비됐을 때 참여시킵니다."
      onClose={onClose}
    >
      <form
        className="research-create"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            const selected = sessions.find((t) => t.id === terminalId);
            onCreated(
              await api<ResearchLab>("/research/prepare", {
                title: title.trim() || "새 연구실",
                cwd: mode === "existing" ? selected?.cwd : cwd,
                hostId: mode === "existing" ? selected?.hostId : hostId,
                leadKind,
                effort: "low",
                ...(mode === "new" ? { agentSettings: { model, effort } } : {}),
                ...(mode === "existing" ? { terminalId } : {}),
              }),
            );
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          연구실 이름{" "}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={180}
            placeholder="선택 사항 · 예: 새로운 연구 아이디어"
          />
        </label>
        <label>
          주 대화{" "}
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="new">새 AI 대화로 시작</option>
            <option value="existing" disabled={!sessions.length}>
              열려 있는 대화에서 이어서
            </option>
          </select>
        </label>
        {mode === "existing" ? (
          <>
            <label>
              기존 대화{" "}
              <select
                required
                value={terminalId}
                onChange={(e) => setTerminalId(e.target.value)}
              >
                <option value="">대화 선택</option>
                {sessions.map((t) => (
                  <option key={t.id} value={t.id}>
                    {state.hosts.find((h) => h.id === t.hostId)?.name} ·{" "}
                    {t.title} · {t.agentKind}
                  </option>
                ))}
              </select>
            </label>
            <p className="research-caption">
              선택한 CLI 대화와 작업 폴더를 그대로 유지합니다.
            </p>
            {sessions.find((t) => t.id === terminalId) && (
              <ResearchSettingsSummary
                kind={sessions.find((t) => t.id === terminalId)!.agentKind!}
                settings={
                  sessions.find((t) => t.id === terminalId)!.researchSettings
                }
              />
            )}
          </>
        ) : (
          <>
            <label>
              먼저 이야기할 AI{" "}
              <select
                value={leadKind}
                onChange={(e) => {
                  const next = e.target.value as "codex" | "claude";
                  setLeadKind(next);
                  setModel("");
                  if (!researchEffortsFor(next).includes(effort))
                    setEffort("low");
                }}
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <label>
              실행 서버{" "}
              <select
                value={hostId}
                onChange={(e) => {
                  setHostId(e.target.value);
                  setCwd(
                    state.hosts.find((h) => h.id === e.target.value)
                      ?.defaultCwd || "~",
                  );
                }}
              >
                {state.hosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              프로젝트 폴더{" "}
              <input
                required
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="~ 또는 선택한 서버의 프로젝트 경로"
              />
            </label>
            <ResearchSettingsFields
              kind={leadKind}
              hostId={hostId}
              label="주 대화"
              model={model}
              effort={effort}
              onModel={setModel}
              onEffort={setEffort}
            />
          </>
        )}
        {error && (
          <p className="research-attention" role="alert">
            {error}
          </p>
        )}
        <div className="research-controls">
          <button type="button" disabled={busy} onClick={onClose}>
            취소
          </button>
          <button
            className="primary"
            disabled={busy || (mode === "existing" && !terminalId)}
          >
            {busy ? "대화 준비 중…" : "대화부터 시작"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function PreparationPanel({
  state,
  lab,
  onOpen,
  onStarted,
  onRemove,
  onError,
}: {
  state: AppState;
  lab: ResearchLabView;
  onOpen(id: string): void;
  onStarted(lab: ResearchLab): void;
  onRemove(): void;
  onError(message: string): void;
}) {
  const [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const [reopened, setReopened] = useState<string[]>([]);
  const [insertedRequest, setInsertedRequest] = useState("");
  const [planError, setPlanError] = useState("");
  const lead = lab.participants[0];
  const connected = ["automatic", "boundary", "manual"].includes(
    lead.connection,
  );
  const planPrompt = `Harbor 연구실 ${JSON.stringify(lab.id)}의 작업 계획을 지금까지의 대화로 정리해줘. harbor_lab_context로 이 연구실을 확인한 뒤 harbor_lab_plan에 목표, 작업 종류, 완료 기준과 배경·결정을 저장해줘. 계획만 저장하고 공동 작업은 아직 시작하지 마.`;
  function insertPlanRequest(messageId: string) {
    if (insertedRequest === messageId) {
      setNotice(
        "이미 주 대화 입력칸에 추가했습니다. 내용을 확인하고 Enter로 보내세요. 지웠다면 요청문을 복사해 다시 붙여넣을 수 있습니다.",
      );
      return;
    }
    insertTerminalDraft({
      terminalId: lead.terminalId,
      sessionId: lead.sessionId || "",
      text: planPrompt,
    });
    setInsertedRequest(messageId);
    setNotice(
      "계획 요청문을 주 대화 입력칸에 추가했습니다. 기존 입력은 유지됩니다. 내용을 확인하고 Enter로 보내세요.",
    );
  }
  useEffect(() => {
    setNotice("");
    setReopened([]);
    setInsertedRequest("");
    setPlanError("");
    setEditing(false);
  }, [lab.id]);
  return (
    <div className="research-preparation">
      <button
        className="research-participant"
        onClick={() => onOpen(lead.terminalId)}
      >
        <span className={`research-dot ${lead.connection}`} />
        <span>
          <b>{lead.name}</b>
          <small>
            {
              state.hosts.find((h) => h.id === (lead.hostId || lab.hostId))
                ?.name
            }{" "}
            · {lead.kind} · 주 대화
          </small>
          <small>
            {connected
              ? "이 대화에서 주제 준비"
              : lead.connection === "connecting"
                ? "CLI 로그인·연결을 기다리는 중"
                : "원래 대화 연결 필요"}
          </small>
        </span>
        <MessageSquare size={15} />
      </button>
      {!connected && lead.sessionId && (
        <div className="research-controls">
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api<{ terminalIds: string[] }>(
                  `/research/${lab.id}/reopen`,
                  {},
                );
                setReopened(r.terminalIds);
                r.terminalIds.forEach(onOpen);
              } catch (e) {
                onError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            원래 대화 다시 열기
          </button>
          {reopened.length === 1 && (
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(`/research/${lab.id}/rebind`, {
                    terminalIds: reopened,
                  });
                  setReopened([]);
                } catch (e) {
                  onError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              연결 확인
            </button>
          )}
        </div>
      )}
      <ResearchSettingsSummary
        kind={lead.kind}
        settings={lead.settings}
        onOpen={() => onOpen(lead.terminalId)}
      />
      {lab.attention && (
        <p className="research-attention" role="alert">
          {lab.attention}
        </p>
      )}
      <div className="research-preparation-steps">
        <b>1. 주 대화에서 이야기하기</b>
        <p>“이런 문제를 연구해 보고 싶어. 방향을 같이 정해보자.”</p>
        <b>2. 계획 정리하기</b>
        <p>
          AI에게 지금까지의 대화로 계획을 정리해 달라고 요청하거나 직접 작성할
          수 있습니다.
        </p>
        <b>3. 공동 작업 시작하기</b>
        <p>
          공유할 맥락과 지시를 확인한 뒤 추가 AI를 선택합니다. 시작 후 후보·연구
          방향·다음 실험은 두 AI가 결정하며 고정 제약과 실행 승인은 유지합니다.
        </p>
      </div>
      <button
        className="research-details-button"
        disabled={busy || !connected}
        onClick={async () => {
          setBusy(true);
          setPlanError("");
          try {
            const request = await api<ResearchPlanRequest>(
              `/research/${lab.id}/plan-request`,
              {},
            );
            await onOpen(lead.terminalId);
            if (
              lead.connection === "manual" ||
              (lead.connection === "boundary" && lead.activity !== "working")
            )
              insertPlanRequest(request.messageId);
            else
              setNotice(
                "계획 요청을 저장했습니다. 아래에서 전달·AI 확인·계획 저장 상태를 확인할 수 있습니다.",
              );
          } catch (e) {
            setPlanError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Send size={14} /> 대화로 계획 정리
      </button>
      {lab.planRequest && (
        <section
          className="research-plan-status"
          aria-label="계획 정리 요청 상태"
          role="status"
        >
          <b>
            {lab.planRequest.state === "saved"
              ? "계획 저장 완료"
              : lab.planRequest.state === "consumed"
                ? "AI가 요청 확인 · 계획 작성 대기"
                : lab.planRequest.state === "offered"
                  ? "CLI 전달 · AI 확인 대기"
                  : ["manual", "boundary"].includes(lead.connection)
                    ? lead.connection === "boundary"
                      ? "다음 활동에서 수신 · 입력 대기 중이면 확인 요청"
                      : "자동 수신 꺼짐 · 직접 전달 필요"
                    : "계획 요청 전달 대기"}
          </b>
          <p>
            {lab.planRequest.state === "saved"
              ? "아래 계획을 확인하고 공동 작업을 시작할 수 있습니다."
              : ["manual", "boundary"].includes(lead.connection)
                ? lead.connection === "boundary"
                  ? "기존 Claude를 종료할 필요가 없습니다. 작업 중이면 다음 도구·응답 완료 때 전달합니다. 이미 입력 대기 중이면 요청문을 확인하고 Enter로 한 번 보내세요."
                  : "이 Claude·Codex 대화는 요청을 자동으로 받지 않습니다. 요청문을 입력칸에 추가하거나 복사해 붙여넣고 Enter로 보내세요."
                : lead.activity === "working" && lead.kind === "claude"
                  ? "Claude의 현재 답변이 끝난 뒤 요청을 전달합니다."
                  : "전달 알림과 AI의 실제 확인을 구분합니다. 계획은 AI가 저장한 뒤 아래에 나타납니다."}
          </p>
          {lab.planRequest.state !== "saved" &&
            ["manual", "boundary"].includes(lead.connection) && (
              <div className="research-controls">
                <button
                  type="button"
                  disabled={
                    busy || insertedRequest === lab.planRequest.messageId
                  }
                  onClick={async () => {
                    setPlanError("");
                    try {
                      await onOpen(lead.terminalId);
                      insertPlanRequest(lab.planRequest!.messageId);
                    } catch (e) {
                      setPlanError((e as Error).message);
                    }
                  }}
                >
                  {insertedRequest === lab.planRequest.messageId
                    ? "입력에 추가됨 · Enter로 전송"
                    : "계획 요청문 입력에 추가"}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await writeLocalClipboard(planPrompt);
                      setNotice(
                        "계획 요청문을 복사했습니다. 주 대화에 Ctrl+V로 붙여넣고 Enter로 보내세요.",
                      );
                    } catch (e) {
                      setPlanError((e as Error).message);
                    }
                  }}
                >
                  요청문 복사
                </button>
              </div>
            )}
        </section>
      )}
      {planError && (
        <p className="research-attention" role="alert">
          {planError}
        </p>
      )}
      {notice && (
        <p className="research-caption" role="status">
          {notice}
        </p>
      )}
      {lab.proposal && (
        <div className="research-proposal">
          <b>준비한 계획</b>
          <p>{lab.proposal.goal}</p>
          <ul>
            {lab.proposal.criteria.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
          <small>
            {lab.proposal.source === "agent"
              ? "주 대화의 AI가 제안"
              : "사용자가 작성"}{" "}
            · 공동 작업 시작 전
          </small>
        </div>
      )}
      <button
        className="research-details-button primary"
        disabled={busy}
        onClick={() => setEditing(true)}
      >
        <Play size={14} />{" "}
        {lab.proposal
          ? "계획 확인 · 공동 작업 시작"
          : "직접 계획 작성 · 공동 작업 시작"}
      </button>
      <button
        className="research-details-button subtle"
        disabled={busy}
        onClick={onRemove}
      >
        연구실 기록 삭제
      </button>
      {editing && (
        <StartResearchDialog
          state={state}
          lab={lab}
          onOpen={onOpen}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setNotice(
              "작업 계획을 저장했습니다. 아래 준비한 계획을 확인한 뒤 공동 작업을 시작하세요.",
            );
          }}
          onStarted={(started) => {
            setEditing(false);
            onStarted(started);
          }}
        />
      )}
    </div>
  );
}

function StartResearchDialog({
  state,
  lab,
  onClose,
  onStarted,
  onOpen,
  onSaved,
}: {
  state: AppState;
  lab: ResearchLabView;
  onClose(): void;
  onStarted(lab: ResearchLab): void;
  onOpen(id: string): void;
  onSaved(): void;
}) {
  const [goal, setGoal] = useState(lab.proposal?.goal || ""),
    [kind, setKind] = useState(lab.proposal?.kind || "ideas");
  const [criteria, setCriteria] = useState(
    (lab.proposal?.criteria || criteriaFor.ideas).join("\n"),
  );
  const [context, setContext] = useState(lab.proposal?.context || ""),
    [revision, setRevision] = useState(lab.revision);
  const [mode, setMode] = useState("new"),
    [partnerKind, setPartnerKind] = useState<"codex" | "claude">(
      lab.participants[0].kind === "claude" ? "codex" : "claude",
    );
  const [partnerModel, setPartnerModel] = useState("");
  const [partnerEffort, setPartnerEffort] = useState<ResearchEffort>(
    lab.effort,
  );
  const [partnerHostId, setPartnerHostId] = useState(lab.hostId),
    [partnerCwd, setPartnerCwd] = useState(lab.cwd),
    [partnerTerminalId, setPartnerTerminalId] = useState("");
  const [snapshot, setSnapshot] = useState<ResearchConversation>(),
    [contextError, setContextError] = useState("");
  const [manualContext, setManualContext] = useState(false),
    [loading, setLoading] = useState(true);
  const [contextAttempt, setContextAttempt] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const sessions = available(state),
    stale = revision !== lab.revision;
  const connected = ["automatic", "boundary", "manual"].includes(
    lab.participants[0].connection,
  );
  useEffect(() => {
    let active = true;
    setLoading(true);
    setSnapshot(undefined);
    setContextError("");
    api<ResearchConversation>(
      `/research/${lab.id}/preparation-context`,
      undefined,
      "GET",
    )
      .then((value) => {
        if (active) setSnapshot(value);
      })
      .catch((e) => {
        if (active) setContextError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [lab.id, contextAttempt]);
  const payload = () => ({
    goal,
    kind,
    criteria: criteria
      .split("\n")
      .map((c) => c.trim())
      .filter(Boolean),
    context,
    revision,
  });
  const criteriaLines = payload().criteria;
  const planIssue = !goal.trim()
    ? "‘지금 두 AI에게 맡길 일’을 입력하세요."
    : !criteriaLines.length
      ? "완료 기준을 한 줄 이상 입력하세요."
      : criteriaLines.length > 12
        ? "완료 기준은 최대 12개까지 입력할 수 있습니다."
        : criteriaLines.some((line) => line.length > 1000)
          ? "각 완료 기준은 1,000자 이내로 입력하세요."
          : "";
  const startIssue = stale
    ? "계획이 바뀌었습니다. ‘최신 계획 가져오기’로 확인하세요."
    : !connected
      ? "원래 주 대화를 다시 연결하면 공동 작업을 시작할 수 있습니다."
      : planIssue ||
        (lab.participants[0].activity === "working"
          ? "주 대화의 답변이 끝난 뒤 시작할 수 있습니다."
          : mode === "existing" && !partnerTerminalId
            ? "참여할 추가 AI 대화를 선택하세요."
            : mode === "new" && !partnerHostId
              ? "추가 AI 실행 서버를 선택하세요."
              : mode === "new" &&
                  (partnerHostId !== lab.hostId || kind === "code") &&
                  !partnerCwd.trim()
                ? "추가 AI 서버의 프로젝트 폴더를 입력하세요."
                : !manualContext && loading
                  ? "주 대화 기록을 불러오는 중입니다. 계획만 저장하는 것은 지금도 가능합니다."
                  : !manualContext && !snapshot
                    ? "대화 기록을 다시 불러오거나, ‘대화 기록 대신 위에 작성한 배경만 공유’를 선택하고 배경을 입력하세요."
                    : manualContext && !context.trim()
                      ? "대화 기록 대신 공유할 배경·결정·조건을 입력하세요."
                      : "");
  return (
    <Modal
      title="공동 작업 준비"
      subtitle="주 대화는 그대로 이어갑니다. 목표·맥락·추가 AI를 확인한 뒤 시작하세요."
      onClose={onClose}
      wide
    >
      <form
        className="research-create research-start-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          if (startIssue) {
            setError(startIssue);
            return;
          }
          setBusy(true);
          setError("");
          try {
            onStarted(
              await api<ResearchLab>(`/research/${lab.id}/start`, {
                ...payload(),
                manualContext,
                partnerKind,
                ...(mode === "existing"
                  ? { partnerTerminalId }
                  : { partnerHostId, partnerCwd }),
                ...(mode === "new"
                  ? {
                      partnerSettings: {
                        model: partnerModel,
                        effort: partnerEffort,
                      },
                    }
                  : {}),
              }),
            );
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {!connected && (
          <p className="research-attention" role="status">
            주 대화가 연결되지 않아도 계획을 작성하고 저장할 수 있습니다. 공동
            작업을 시작하려면 원래 대화를 다시 연결하세요.
          </p>
        )}
        {stale && (
          <div className="research-attention" role="alert">
            대화에서 계획이 변경되었습니다. 최신 계획을 확인하세요.
            <button
              type="button"
              onClick={() => {
                setGoal(lab.proposal?.goal || "");
                setKind(lab.proposal?.kind || "ideas");
                setCriteria(
                  (lab.proposal?.criteria || criteriaFor.ideas).join("\n"),
                );
                setContext(lab.proposal?.context || "");
                setRevision(lab.revision);
              }}
            >
              최신 계획 가져오기
            </button>
          </div>
        )}
        <div className="research-plan-fields">
          <label>
            지금 두 AI에게 맡길 일{" "}
            <textarea
              required
              rows={6}
              value={goal}
              maxLength={8000}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="예: 방금 논의한 방향으로 연구 아이디어를 만들고 서로 비판해줘. 후보를 비교해 추천안과 검증 실험을 정리해줘."
            />
          </label>
          <label>
            작업 종류{" "}
            <select
              value={kind}
              onChange={(e) => {
                const next = e.target.value as typeof kind;
                setKind(next);
                setCriteria(criteriaFor[next].join("\n"));
              }}
            >
              <option value="ideas">아이디어 생성·검토</option>
              <option value="research">조사·실험</option>
              <option value="code">코드 수정·평가</option>
            </select>
          </label>
          <label>
            공유할 배경 · 결정 · 조건{" "}
            <textarea
              rows={4}
              value={context}
              maxLength={16000}
              onChange={(e) => setContext(e.target.value)}
              placeholder="주 대화에서 정한 방향, 중요한 조건, 아직 결정하지 않은 점"
            />
          </label>
          <label>
            완료 기준 · 한 줄에 하나{" "}
            <textarea
              required
              rows={3}
              value={criteria}
              maxLength={12000}
              onChange={(e) => setCriteria(e.target.value)}
            />
          </label>
        </div>
        <div className="research-partner-fields">
          <div className="research-proposal">
            <b>주 대화 유지</b>
            <p>{lab.participants[0].name}</p>
            <small>
              {state.hosts.find((h) => h.id === lab.hostId)?.name} ·{" "}
              {lab.participants[0].kind}
            </small>
            <p>먼저 나눈 대화에 추가 AI를 참여시킵니다.</p>
            <ResearchSettingsSummary
              kind={lab.participants[0].kind}
              settings={lab.participants[0].settings}
              onOpen={() => {
                onClose();
                onOpen(lab.participants[0].terminalId);
              }}
            />
          </div>
          <label>
            추가 AI{" "}
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="new">새 AI 참여시키기</option>
              <option value="existing" disabled={!sessions.length}>
                열려 있는 다른 대화 선택
              </option>
            </select>
          </label>
          {mode === "existing" ? (
            <>
              <label>
                참여할 대화{" "}
                <select
                  required
                  value={partnerTerminalId}
                  onChange={(e) => setPartnerTerminalId(e.target.value)}
                >
                  <option value="">대화 선택</option>
                  {sessions.map((t) => (
                    <option key={t.id} value={t.id}>
                      {state.hosts.find((h) => h.id === t.hostId)?.name} ·{" "}
                      {t.title} · {t.agentKind}
                    </option>
                  ))}
                </select>
              </label>
              {sessions.find((t) => t.id === partnerTerminalId) && (
                <ResearchSettingsSummary
                  kind={
                    sessions.find((t) => t.id === partnerTerminalId)!.agentKind!
                  }
                  settings={
                    sessions.find((t) => t.id === partnerTerminalId)!
                      .researchSettings
                  }
                  onOpen={() => {
                    onClose();
                    onOpen(partnerTerminalId);
                  }}
                />
              )}
            </>
          ) : (
            <>
              <label>
                AI 종류{" "}
                <select
                  value={partnerKind}
                  onChange={(e) => {
                    const next = e.target.value as "codex" | "claude";
                    setPartnerKind(next);
                    setPartnerModel("");
                    if (!researchEffortsFor(next).includes(partnerEffort))
                      setPartnerEffort("low");
                  }}
                >
                  <option value="codex">Codex</option>
                  <option value="claude">Claude</option>
                </select>
              </label>
              <ResearchSettingsFields
                kind={partnerKind}
                hostId={partnerHostId}
                label="추가 AI"
                model={partnerModel}
                effort={partnerEffort}
                onModel={setPartnerModel}
                onEffort={setPartnerEffort}
              />
              <label>
                추가 AI 실행 서버{" "}
                <select
                  value={partnerHostId}
                  onChange={(e) => {
                    setPartnerHostId(e.target.value);
                    setPartnerCwd(
                      e.target.value === lab.hostId
                        ? lab.cwd
                        : state.hosts.find((h) => h.id === e.target.value)
                            ?.defaultCwd || "~",
                    );
                  }}
                >
                  {state.hosts.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>
              </label>
              {(partnerHostId !== lab.hostId || kind === "code") && (
                <label>
                  추가 AI 서버의 프로젝트 폴더{" "}
                  <input
                    required
                    value={partnerCwd}
                    onChange={(e) => setPartnerCwd(e.target.value)}
                  />
                </label>
              )}
            </>
          )}
          <details className="research-conversation-preview">
            <summary>
              주 대화 기록 공유{" "}
              {loading
                ? "· 불러오는 중"
                : snapshot
                  ? `· ${snapshot.items}개 메시지${snapshot.truncated ? " · 최근 내용" : ""}`
                  : "· 기록 확인 필요"}
            </summary>
            <p className="research-caption">
              시작 시 선택한 주 대화의 사용자·AI 메시지를 읽어 함께 전달합니다.
              최대 32,000자이며 이전 결정은 위 배경에도 정리하세요.
            </p>
            {snapshot && <pre>{snapshot.text}</pre>}
            {contextError && (
              <p className="research-attention">{contextError}</p>
            )}
          </details>
          <button
            type="button"
            disabled={loading || busy}
            onClick={() => setContextAttempt((n) => n + 1)}
          >
            대화 기록 다시 불러오기
          </button>
          {!loading && contextError && (
            <p className="research-attention">
              기록을 읽지 못했습니다. 대화를 더 나누고 창을 다시 열거나,
              아래에서 배경을 직접 공유하도록 선택하세요.
            </p>
          )}
          <label className="research-checkbox">
            <input
              type="checkbox"
              checked={manualContext}
              onChange={(e) => setManualContext(e.target.checked)}
            />{" "}
            대화 기록 대신 위에 작성한 배경만 공유
          </label>
          <p className="research-caption">
            {kind === "code"
              ? "주 대화는 현재 작업 폴더에서 수정합니다. 새 추가 AI는 선택한 Git 프로젝트의 깨끗한 기준 버전에서 별도 worktree를 사용합니다. 기존 대화끼리는 서로 다른 작업 폴더가 필요합니다."
              : "처음에는 각자 판단하고, 이후 결과를 공유하며 검토합니다."}{" "}
            새 추가 AI는 위에서 선택한 모델·추론 노력으로 실행합니다.
          </p>
          {lab.participants[0].activity === "working" && (
            <p className="research-attention">
              주 대화의 답변이 끝난 뒤 공동 작업을 시작할 수 있습니다.
            </p>
          )}
        </div>
        <div className="research-controls research-plan-footer">
          {error && (
            <p className="research-attention" role="alert">
              {error}
            </p>
          )}
          {startIssue && (
            <p className="research-start-reason" role="status">
              {startIssue}
            </p>
          )}
          <button type="button" disabled={busy} onClick={onClose}>
            계속 대화하기
          </button>
          <button
            type="button"
            disabled={busy || stale}
            onClick={async () => {
              if (planIssue) {
                setError(planIssue);
                return;
              }
              setBusy(true);
              setError("");
              try {
                await api(`/research/${lab.id}/proposal`, payload());
                onSaved();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            계획만 저장
          </button>
          <button className="primary" disabled={busy || !!startIssue}>
            {busy ? "공동 작업 준비 중…" : "공동 작업 시작"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
