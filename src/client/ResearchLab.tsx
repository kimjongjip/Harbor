import { useEffect, useState } from "react";
import {
  FlaskConical,
  Plus,
  Play,
  Pause,
  RotateCcw,
  X,
  ExternalLink,
  Send,
  Check,
  Clock,
  MessageSquare,
  Trash2,
} from "lucide-react";
import type { AppState } from "../shared/types";
import type { ResearchLab, ResearchLabView } from "../shared/research";
import {
  researchPhaseLabel,
  researchStatusLabel,
  researchDecisionLabel,
} from "../shared/research";
import { api } from "./api";
import { NewResearchDialog, PreparationPanel } from "./ResearchPreparation";
import { DeleteResearchDialog } from "./ResearchRecords";
import { ResearchSettingsSummary } from "./ResearchSettings";
import { ResearchReceive } from "./ResearchReceive";
import { Markdown } from "./RichMarkdown";
import { usePreview } from "./ResourcePreview";
import "./research-lab.css";

const connectionLabels = {
  connecting: "CLI 연결 대기",
  automatic: "자동 수신 연결",
  boundary: "기존 대화 · 다음 활동에서 수신",
  manual: "받은함 확인 필요",
  offline: "연결 종료",
  changed: "다른 대화로 변경됨",
};
const deliveryLabels = {
  queued: "전달 대기",
  offered: "CLI 전달 · AI 확인 대기",
  consumed: "AI 확인 · 결과 대기",
  reported: "결과 제출",
};

export function ResearchSidebar({
  state,
  selectedId,
  onSelect,
  onOpen,
  onPair,
  onDetails,
  onCreated,
  initialCwd,
  initialHostId,
  initialTerminalId,
  onError,
}: {
  state: AppState;
  selectedId: string;
  onSelect(id: string): void;
  onOpen(id: string): void;
  onPair(lab: ResearchLab): void;
  onDetails(): void;
  onCreated(lab: ResearchLab): void;
  initialCwd: string;
  initialHostId: string;
  initialTerminalId?: string;
  onError(message: string): void;
}) {
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [directive, setDirective] = useState("");
  const [reopened, setReopened] = useState<string[]>([]);
  const labs = state.researchLabs || [];
  const lab = labs.find((l) => l.id === selectedId);
  const managerTerminal =
    lab?.manager &&
    state.terminals.find(
      (t) =>
        !t.exited &&
        t.hostId === lab.manager!.hostId &&
        t.agentKind === lab.manager!.kind &&
        t.agentSessionId === lab.manager!.sessionId,
    );
  useEffect(() => {
    setReopened([]);
    setDirective("");
  }, [selectedId, lab?.pendingDecision?.assignmentId]);
  async function control(
    action: "pause" | "resume" | "retry" | "answer",
    text?: string,
  ) {
    if (!lab) return;
    setBusy(true);
    try {
      await api(`/research/${lab.id}/control`, {
        action,
        ...(text ? { directive: text } : {}),
        ...(action === "answer"
          ? { decisionAssignmentId: lab.pendingDecision?.assignmentId }
          : {}),
      });
      if (text) setDirective("");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="research-sidebar" aria-label="연구실">
      <div className="research-heading">
        <b>
          <FlaskConical size={16} /> 연구실
        </b>
        <div className="research-heading-actions">
          <button
            className="icon-button"
            aria-label="연구실 기록 모두 삭제"
            title="연구실 기록 모두 삭제"
            disabled={!labs.length}
            onClick={() => setRemoving(labs.map((item) => item.id))}
          >
            <Trash2 size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="새 연구실"
            title="새 연구실"
            onClick={() => setCreating(true)}
          >
            <Plus size={17} />
          </button>
        </div>
      </div>
      <div className="research-list" aria-label="연구 과제 목록">
        {labs.map((item) => (
          <div className="research-room-row" key={item.id}>
            <button
              className={`research-room ${item.id === selectedId ? "active" : ""}`}
              onClick={() => onSelect(item.id)}
            >
              <span>{item.title}</span>
              <small>
                {researchStatusLabel[item.status]} ·{" "}
                {researchPhaseLabel[item.phase]}
              </small>
            </button>
            <button
              className="icon-button"
              aria-label={`연구실 기록 삭제: ${item.title}`}
              title="이 연구실 기록 삭제"
              onClick={() => setRemoving([item.id])}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {!labs.length && (
          <button className="research-empty" onClick={() => setCreating(true)}>
            <Plus size={22} />
            <span>첫 연구실 만들기</span>
          </button>
        )}
      </div>
      {lab && (
        <div className="research-summary">
          <div className="research-heading">
            <b>{lab.title}</b>
            <span className={`research-status ${lab.status}`}>
              {researchStatusLabel[lab.status]}
            </span>
          </div>
          {lab.manager && (
            <p className="research-caption">
              관리자 · {lab.manager.name}
              {managerTerminal && (
                <button
                  className="research-manager-link"
                  onClick={() => onOpen(managerTerminal.id)}
                >
                  관리자 대화 열기
                </button>
              )}
              <br />새 Claude·Codex가 참여하며, 아래에서 직접 제어할 수도
              있습니다.
            </p>
          )}
          {lab.status === "preparing" ? (
            <PreparationPanel
              state={state}
              lab={lab}
              onOpen={onOpen}
              onStarted={onCreated}
              onRemove={() => setRemoving([lab.id])}
              onError={onError}
            />
          ) : (
            <>
              <p className="research-goal">{lab.goal}</p>
              {lab.proposal && (
                <details className="research-report">
                  <summary>공유한 준비 맥락</summary>
                  <p>
                    {lab.proposal.context ||
                      "추가 배경 없이 주 대화 기록을 공유했습니다."}
                  </p>
                  {lab.conversation && (
                    <>
                      <small>
                        주 대화 기록 · {lab.conversation.items}개 메시지
                        {lab.conversation.truncated
                          ? " · 최근 내용만 공유"
                          : ""}
                      </small>
                      <pre className="research-shared-conversation">
                        {lab.conversation.text}
                      </pre>
                    </>
                  )}
                </details>
              )}
              <p className="research-caption">
                {researchPhaseLabel[lab.phase]} · 검토 {lab.cycle + 1}차{" "}
                <span title="검토 횟수로 자동 종료하지 않습니다.">
                  · 완료 기준으로 진행
                </span>
              </p>
              <p className="research-caption">
                후보·연구 방향·다음 실험은 두 AI가 결정합니다. 고정 제약과 실행
                승인은 유지합니다.
              </p>
              {lab.participants.map((p, i) => (
                <div key={i}>
                  <button
                    className="research-participant"
                    onClick={() => onOpen(p.terminalId)}
                  >
                    <span className={`research-dot ${p.connection}`} />
                    <span>
                      <b>{p.name}</b>
                      <small>
                        {
                          state.hosts.find(
                            (h) => h.id === (p.hostId || lab.hostId),
                          )?.name
                        }
                      </small>
                      <small>
                        {p.kind === "claude" && p.connection === "automatic"
                          ? "채널 수신 요청"
                          : connectionLabels[p.connection]}
                        {p.activity === "waiting"
                          ? " · 입력·승인 대기"
                          : p.activity === "working"
                            ? " · 작업 중"
                            : ""}
                      </small>
                      <small>{p.delivery && deliveryLabels[p.delivery]}</small>
                    </span>
                    <ExternalLink size={13} />
                  </button>
                  <ResearchSettingsSummary
                    kind={p.kind}
                    settings={p.settings}
                    onOpen={() => onOpen(p.terminalId)}
                  />
                </div>
              ))}
              <button
                className="research-details-button"
                onClick={() => onPair(lab)}
              >
                두 터미널 함께 보기
              </button>
              {lab.attention && (
                <div className="research-attention">{lab.attention}</div>
              )}
              {lab.pendingDecision && (
                <div
                  className="research-decision"
                  aria-label="사용자 결정 요청"
                >
                  <b>{researchDecisionLabel[lab.pendingDecision.kind]}</b>
                  <p>{lab.pendingDecision.reason}</p>
                  {lab.pendingDecision.constraintChange && (
                    <div>
                      <b>바꾸려는 고정 제약</b>
                      <p>{lab.pendingDecision.constraintChange.constraint}</p>
                      <p>
                        {lab.pendingDecision.constraintChange.proposedChange}
                      </p>
                    </div>
                  )}
                  <p className="research-caption">
                    두 AI가 검토한 뒤 사용자에게 요청한 결정입니다.
                  </p>
                  {(() => {
                    const question = state.mailbox?.find(
                      (m) => m.id === lab.pendingDecision!.peerMessageId,
                    );
                    const reply = state.mailbox?.find(
                      (m) => m.id === question?.replyMessageId,
                    );
                    return (
                      reply && (
                        <details>
                          <summary>동료 AI의 답변</summary>
                          <p>{reply.text}</p>
                        </details>
                      )
                    );
                  })()}
                </div>
              )}
              <PeerQuestions lab={lab} state={state} />
              {lab.status !== "completed" &&
                lab.participants
                  .filter((p) => ["manual", "boundary"].includes(p.connection))
                  .map((p) => (
                    <ResearchReceive
                      key={p.terminalId}
                      lab={lab}
                      participant={p}
                      state={state}
                      onOpen={onOpen}
                    />
                  ))}
              <div className="research-controls">
                <button
                  disabled={
                    busy || lab.status === "completed" || !!lab.pendingDecision
                  }
                  onClick={() =>
                    void control(
                      ["running", "connecting"].includes(lab.status)
                        ? "pause"
                        : "resume",
                    )
                  }
                >
                  {["running", "connecting"].includes(lab.status) ? (
                    <>
                      <Pause size={14} /> 일시정지
                    </>
                  ) : (
                    <>
                      <Play size={14} /> 계속 진행
                    </>
                  )}
                </button>
                <button
                  disabled={busy || lab.status !== "running"}
                  title="현재 배정을 다시 알립니다. 완료된 실험을 재실행하는 버튼이 아닙니다."
                  onClick={() => void control("retry")}
                >
                  <RotateCcw size={14} /> 배정 알림
                </button>
              </div>
              {["paused", "needs-input"].includes(lab.status) &&
                lab.participants.some(
                  (p) =>
                    p.connection === "offline" || p.connection === "changed",
                ) && (
                  <div className="research-reconnect">
                    <button
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          const result = await api<{ terminalIds: string[] }>(
                            `/research/${lab.id}/reopen`,
                            {},
                          );
                          setReopened(result.terminalIds);
                          result.terminalIds.forEach(onOpen);
                        } catch (e) {
                          onError((e as Error).message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      원래 대화 다시 열기
                    </button>
                    {reopened.length === 2 && (
                      <button
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          try {
                            await api(`/research/${lab.id}/rebind`, {
                              terminalIds: reopened,
                            });
                            setReopened([]);
                            if (!lab.pendingDecision) await control("resume");
                          } catch (e) {
                            onError((e as Error).message);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        {lab.pendingDecision
                          ? "원래 대화 연결 확인"
                          : "연결 확인 후 계속"}
                      </button>
                    )}
                  </div>
                )}
              <div className="research-criteria">
                <b>완료 기준</b>
                {lab.criteria.map((c) => {
                  const assessments = lab.assignments
                    .filter((a) => a.revision === lab.revision && a.report)
                    .slice()
                    .reverse();
                  const votes = [0, 1].map((i) =>
                    assessments
                      .find((a) => a.participant === i)
                      ?.report?.criteria.find((a) => a.id === c.id),
                  );
                  const met = votes.every((v) => v?.met);
                  return (
                    <div key={c.id}>
                      {met ? <Check size={14} /> : <Clock size={14} />}
                      <span>{c.text}</span>
                    </div>
                  );
                })}
              </div>
              <button className="research-details-button" onClick={onDetails}>
                <MessageSquare size={15} /> 토론·실험·결과 보기
              </button>
              <form
                className="research-directive"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (directive.trim())
                    void control(
                      lab.pendingDecision ? "answer" : "resume",
                      directive,
                    );
                }}
              >
                <label htmlFor="research-directive">
                  {lab.pendingDecision
                    ? "사용자 결정에 답변"
                    : "방향 변경 · 추가 지시"}
                </label>
                <textarea
                  id="research-directive"
                  value={directive}
                  onChange={(e) => setDirective(e.target.value)}
                  maxLength={4000}
                  rows={3}
                  placeholder={
                    lab.pendingDecision
                      ? "두 AI가 이어갈 수 있도록 필요한 결정이나 정보를 입력하세요."
                      : "예: 후보 B에 집중해줘. 비용 조건을 추가하고 검증 실험까지 진행해줘."
                  }
                />
                <button disabled={busy || !directive.trim()}>
                  <Send size={14} />{" "}
                  {lab.pendingDecision ? "답변하고 이어가기" : "두 AI에게 전달"}
                </button>
                <p className="research-caption">
                  {lab.pendingDecision
                    ? "기존 분석과 단계에서 이어갑니다."
                    : "후보 선택과 일반 질문은 AI끼리 검토합니다. 새 지시는 분석을 갱신합니다."}
                </p>
                {lab.directives.length > 0 && (
                  <details>
                    <summary>전달한 지시 {lab.directives.length}개</summary>
                    {lab.directives.map((d, i) => (
                      <p key={i}>{d}</p>
                    ))}
                  </details>
                )}
              </form>
            </>
          )}
        </div>
      )}
      {!!removing.length && (
        <DeleteResearchDialog
          state={state}
          ids={removing}
          onClose={() => setRemoving([])}
          onRemoved={() => {
            if (removing.includes(selectedId)) onSelect("");
            setRemoving([]);
          }}
        />
      )}
      {creating && (
        <NewResearchDialog
          state={state}
          initialCwd={initialCwd}
          initialHostId={initialHostId}
          initialTerminalId={initialTerminalId}
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            onCreated(created);
          }}
        />
      )}
    </section>
  );
}

function PeerQuestions({ lab, state }: { lab: ResearchLab; state: AppState }) {
  const since = Math.min(
    ...lab.assignments
      .filter((a) => a.revision === lab.revision)
      .map((a) => a.createdAt),
  );
  const questions = (state.mailbox || []).filter(
    (m) =>
      m.labId === lab.id &&
      m.purpose === "question" &&
      (m.questionSource
        ? m.questionSource.revision === lab.revision
        : m.labRevision !== undefined
          ? m.labRevision === lab.revision
          : m.createdAt >= since),
  );
  return (
    <details className="research-report research-peer-questions">
      <summary>
        AI끼리 질문·검토 {questions.length > 0 && `(${questions.length})`}
      </summary>
      {!questions.length && (
        <p className="research-caption">
          각자 분석을 제출한 뒤, 일반 질문을 상대 AI에게 전달합니다.
        </p>
      )}
      {questions.slice(0, 8).map((q) => {
        const reply = state.mailbox?.find(
          (m) => m.id === q.replyMessageId && m.author === "agent",
        );
        return (
          <article key={q.id}>
            <b>
              {q.sender.title} → {q.recipient.title}
            </b>
            <small>
              {reply
                ? "답변 도착"
                : q.consumedAt
                  ? "AI 확인 · 답변 대기"
                  : q.offeredAt
                    ? "CLI 전달 · 확인 대기"
                    : "전달 대기"}
            </small>
            <p>{q.text}</p>
            {reply && (
              <details>
                <summary>답변 보기</summary>
                <p>{reply.text}</p>
              </details>
            )}
          </article>
        );
      })}
    </details>
  );
}

export function ResearchDetails({
  lab,
  state,
  onClose,
  onOpen,
  onError,
}: {
  lab: ResearchLabView;
  state: AppState;
  onClose(): void;
  onOpen(id: string): void;
  onError(message: string): void;
}) {
  const [tab, setTab] = useState<"discussion" | "work" | "result">(
    "discussion",
  );
  const preview = usePreview();
  const messages = (state.mailbox || []).filter((m) => m.labId === lab.id);
  return (
    <aside className="research-details" aria-label="공동 연구 상세">
      <div className="research-heading">
        <b>{lab.title}</b>
        <button
          className="icon-button"
          aria-label="연구 상세 닫기"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <div className="research-detail-tabs">
        {(["discussion", "work", "result"] as const).map((t) => (
          <button
            key={t}
            className={t === tab ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t === "discussion"
              ? "토론"
              : t === "work"
                ? "작업·실험"
                : "현재 결과"}
          </button>
        ))}
      </div>
      <div className="research-detail-body">
        {tab === "discussion" && (
          <>
            <p className="research-caption">
              각 AI가 실제 제출한 결론과 질문입니다. 원래 대화는 해당 터미널에서
              이어집니다.
            </p>
            {lab.assignments
              .filter((a) => a.report)
              .slice()
              .reverse()
              .map((a) => (
                <details
                  className="research-report"
                  key={a.id}
                  open={a.phase === lab.phase && a.cycle === lab.cycle}
                >
                  <summary>
                    <b>{lab.participants[a.participant].name}</b>
                    <small>
                      {researchPhaseLabel[a.phase]} · {a.cycle + 1}차
                    </small>
                  </summary>
                  <Markdown
                    text={a.report!.summary}
                    location={{
                      hostId:
                        lab.participants[a.participant].hostId || lab.hostId,
                      cwd: lab.participants[a.participant].cwd,
                    }}
                  />
                  {a.report!.issues.length > 0 && (
                    <div className="research-report-issues">
                      <b>남은 쟁점</b>
                      <ul>
                        {a.report!.issues.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {a.report!.nextActions.length > 0 && (
                    <div>
                      <b>제안한 다음 작업</b>
                      <ul>
                        {a.report!.nextActions.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {!!(
                    a.report!.peerQuestions?.length || a.report!.userQuestion
                  ) && (
                    <div>
                      <b>동료 AI에게 질문</b>
                      <ul>
                        {[
                          ...(a.report!.peerQuestions || []),
                          ...(a.report!.userQuestion
                            ? [a.report!.userQuestion]
                            : []),
                        ].map((q, i) => (
                          <li key={i}>{q}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {a.report!.userDecision && (
                    <div className="research-decision">
                      <b>사용자 결정 요청</b>
                      <p>{a.report!.userDecision.question}</p>
                      <p>{a.report!.userDecision.reason}</p>
                      {a.decisionAnswer && (
                        <p>사용자 답변: {a.decisionAnswer.text}</p>
                      )}
                    </div>
                  )}
                  <button
                    onClick={() =>
                      onOpen(lab.participants[a.participant].terminalId)
                    }
                  >
                    원래 터미널 보기
                  </button>
                </details>
              ))}
            {messages.length > 0 && (
              <details className="research-report">
                <summary>서로 주고받은 질문·답장 ({messages.length})</summary>
                {messages
                  .slice()
                  .reverse()
                  .map((m) => (
                    <article key={m.id}>
                      <b>
                        {m.sender.title} → {m.recipient.title}
                      </b>
                      <Markdown
                        text={m.text}
                        location={{
                          hostId: m.sender.hostId || lab.hostId,
                          cwd: m.sender.cwd || lab.cwd,
                        }}
                      />
                      <small>
                        {m.repliedAt
                          ? "답장 도착"
                          : m.consumedAt
                            ? "AI 확인"
                            : m.offeredAt
                              ? "CLI 전달 · 확인 대기"
                              : "전달 대기"}
                      </small>
                    </article>
                  ))}
              </details>
            )}
            <details className="research-report">
              <summary>진행 기록</summary>
              {lab.events
                .slice()
                .reverse()
                .map((e) => (
                  <p key={e.id}>
                    <small>{new Date(e.at).toLocaleTimeString()}</small>{" "}
                    {e.text}
                  </p>
                ))}
            </details>
          </>
        )}
        {tab === "work" && (
          <>
            <p className="research-caption">
              작업 기록은 AI가 보고한 실행 결과입니다. 상대의 검토와 실제 로그를
              함께 확인하세요.
            </p>
            {!lab.works.length && (
              <p className="research-caption">아직 등록된 작업이 없습니다.</p>
            )}
            {lab.works
              .slice()
              .reverse()
              .map((w) => (
                <article className="research-work" key={w.id}>
                  <b>{w.title}</b>
                  <small>
                    {lab.participants[w.participant].name} ·{" "}
                    {w.status === "running"
                      ? "실행 중"
                      : w.status === "completed"
                        ? "결과 기록"
                        : "실패"}
                  </small>
                  {w.command && <pre>{w.command}</pre>}
                  {w.cwd && (
                    <p>
                      <small>실행 폴더</small> {w.cwd}
                    </p>
                  )}
                  {w.revision && (
                    <p>
                      <small>코드 버전</small> {w.revision}
                    </p>
                  )}
                  {w.exitCode !== undefined && <p>종료 코드: {w.exitCode}</p>}
                  {w.resource && <p>사용 자원: {w.resource}</p>}
                  {w.metrics && <Markdown text={w.metrics} />}
                  {w.result && (
                    <Markdown
                      text={w.result}
                      location={{
                        hostId:
                          lab.participants[w.participant].hostId || lab.hostId,
                        cwd: w.cwd || lab.participants[w.participant].cwd,
                      }}
                    />
                  )}
                  {w.artifacts.map((path) => (
                    <button
                      className="research-artifact"
                      key={path}
                      onClick={() =>
                        preview(path, {
                          hostId:
                            lab.participants[w.participant].hostId ||
                            lab.hostId,
                          cwd: w.cwd || lab.participants[w.participant].cwd,
                        })
                      }
                    >
                      <ExternalLink size={13} /> {path}
                    </button>
                  ))}
                </article>
              ))}
          </>
        )}
        {tab === "result" && (
          <>
            <p className="research-caption">
              {lab.status === "completed"
                ? "완료 기준에 따라 상대 AI가 검토한 결과입니다."
                : "현재까지의 추천안입니다. 추가 작업과 검토에 따라 바뀔 수 있습니다."}
            </p>
            {lab.bestResult ? (
              <>
                <button
                  className="research-export"
                  onClick={async () => {
                    try {
                      const result = await api<{
                        path: string;
                        hostId: string;
                      }>(`/research/${lab.id}/export`, {});
                      preview(result.path, {
                        hostId: result.hostId,
                        cwd: lab.cwd,
                      });
                    } catch (e) {
                      onError((e as Error).message);
                    }
                  }}
                >
                  <ExternalLink size={14} /> 문서로 새 창에서 보기
                </button>
                <Markdown
                  text={lab.bestResult}
                  location={{
                    hostId: lab.participants[0].hostId || lab.hostId,
                    cwd: lab.participants[0].cwd,
                  }}
                />
              </>
            ) : (
              <p className="research-caption">
                첫 결과가 제출되면 여기에 저장됩니다.
              </p>
            )}
            {lab.workspace && (
              <div className="research-work">
                <b>코드 작업 폴더</b>
                <p>기준 버전: {lab.workspace.baseline}</p>
                {lab.participants.map((p, i) => (
                  <p key={i}>
                    {p.kind}: {p.cwd}
                    <br />
                    <small>{lab.workspace!.branches[i]}</small>
                  </p>
                ))}
                <p className="research-caption">
                  원래 작업 폴더는 덮어쓰지 않습니다. 최종 결과에 적용할 변경과
                  검증 내용을 기록합니다.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
