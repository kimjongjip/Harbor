import { useState } from "react";
import {
  ArrowUpRight,
  Bell,
  CheckCheck,
  CircleHelp,
  Inbox,
  LoaderCircle,
  MessageSquare,
  Send,
  X,
} from "lucide-react";
import type { AppState } from "../shared/types";
import type { HarborRequest } from "../shared/requests";
import { api } from "./api";
import SessionMessages from "./SessionMessages";
import { useNotifications } from "./Notifications";

export type InboxTab = "requests" | "messages" | "notifications";
function RequestCard({
  request,
  onOpen,
}: {
  request: HarborRequest;
  onOpen: (id: string) => void;
}) {
  const [text, setText] = useState("");
  const [optionId, setOptionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = request.status === "pending";
  return (
    <article className={`inbox-request ${pending ? "pending" : "resolved"}`}>
      <div className="inbox-source">
        <span>{request.terminal.hostName}</span>
        <span> / </span>
        <button
          onClick={() =>
            request.terminal.terminalId && onOpen(request.terminal.terminalId)
          }
        >
          {request.terminal.title}
          <ArrowUpRight size={12} />
        </button>
      </div>
      <h3>{request.title}</h3>
      {request.kind === "permission" && (
        <div className="inbox-permission">
          <b>실행 승인 요청 · {request.permission?.toolName}</b>
          {request.permission?.cwd && <small>{request.permission.cwd}</small>}
          {request.permission?.command && (
            <pre>{request.permission.command}</pre>
          )}
          {request.permission?.detail && <p>{request.permission.detail}</p>}
        </div>
      )}
      <p className="inbox-question">{request.question}</p>
      {pending ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await api(`/requests/${request.id}/respond`, {
                text,
                ...(optionId ? { optionId } : {}),
              });
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {!!request.options.length && (
            <fieldset disabled={busy} aria-label="답변 선택">
              {request.options.map((option) => (
                <label
                  key={option.id}
                  className={optionId === option.id ? "selected" : ""}
                >
                  <input
                    type="radio"
                    name={request.id}
                    value={option.id}
                    checked={optionId === option.id}
                    onChange={() => setOptionId(option.id)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </fieldset>
          )}
          <textarea
            rows={3}
            value={text}
            disabled={busy}
            maxLength={16000}
            onChange={(e) => setText(e.target.value)}
            aria-label={`${request.title} 답변`}
            placeholder={
              request.kind === "permission"
                ? "추가 설명 (선택 사항)"
                : "직접 답변하거나 선택지에 설명을 더하세요"
            }
          />
          {error && (
            <p className="inbox-error" role="alert">
              {error}
            </p>
          )}
          <div className="inbox-request-actions">
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(`/requests/${request.id}/cancel`, {});
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {request.kind === "permission" ? "터미널에서 처리" : "요청 취소"}
            </button>
            <button
              className="button primary"
              disabled={
                busy ||
                (request.kind === "permission"
                  ? !optionId
                  : !text.trim() && !optionId)
              }
            >
              {busy ? (
                <LoaderCircle className="spin" size={13} />
              ) : (
                <Send size={13} />
              )}
              {request.kind === "permission" ? "선택 적용" : "답변 보내기"}
            </button>
          </div>
        </form>
      ) : (
        <div className="inbox-request-result">
          <b>
            {request.status === "consumed"
              ? "세션에서 답변을 확인했습니다"
              : request.status === "answered"
                ? "답변 전송 · 세션 확인 대기"
                : "요청 종료"}
          </b>
          <p>{request.answer?.text || request.cancellationReason}</p>
        </div>
      )}
    </article>
  );
}
export default function WorkspaceInbox({
  state,
  tab,
  onTab,
  terminalId,
  onOpen,
  onError,
  onClose,
}: {
  state: AppState;
  tab: InboxTab;
  onTab: (tab: InboxTab) => void;
  terminalId: string;
  onOpen: (id: string) => void;
  onError: (message: string) => void;
  onClose: () => void;
}) {
  const { notices, read } = useNotifications();
  const [showDone, setShowDone] = useState(false);
  const requests = state.requests || [];
  const pending = requests.filter((r) => r.status === "pending");
  const visible = showDone ? requests : pending;
  const unread = notices.filter((n) => !n.read).length;
  return (
    <section className="workspace-inbox" aria-label="왼쪽 받은함">
      <header>
        <div>
          <Inbox size={17} />
          <h2>받은함</h2>
          <button
            className="icon-button inbox-close"
            aria-label="받은함 닫기"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        <small>질문에 답하고, 세션 사이의 전달을 확인하세요</small>
      </header>
      <div className="inbox-tabs" role="tablist" aria-label="받은함 종류">
        <button
          role="tab"
          aria-selected={tab === "requests"}
          onClick={() => onTab("requests")}
        >
          <CircleHelp size={14} />
          요청{pending.length > 0 && <b>{pending.length}</b>}
        </button>
        <button
          role="tab"
          aria-selected={tab === "messages"}
          onClick={() => onTab("messages")}
        >
          <MessageSquare size={14} />
          메시지
        </button>
        <button
          role="tab"
          aria-selected={tab === "notifications"}
          onClick={() => onTab("notifications")}
        >
          <Bell size={14} />
          알림{unread > 0 && <b>{unread}</b>}
        </button>
      </div>
      {tab === "requests" && (
        <>
          <label className="inbox-history-toggle">
            <input
              type="checkbox"
              checked={showDone}
              onChange={(e) => setShowDone(e.target.checked)}
            />
            처리한 요청 함께 보기
          </label>
          <div className="inbox-scroll">
            {visible.map((request) => (
              <RequestCard key={request.id} request={request} onOpen={onOpen} />
            ))}
            {!visible.length && (
              <div className="inbox-empty">
                <CircleHelp size={27} />
                <b>
                  {state.requests
                    ? "대기 중인 요청이 없습니다"
                    : "요청 기능 업데이트 대기"}
                </b>
                <p>
                  {state.requests
                    ? "Codex의 질문과 Codex·Claude의 실행 승인 요청을 여기에서 처리합니다. Claude의 일반 질문은 알림에서 해당 터미널로 이동해 답변하세요."
                    : "열려 있는 작업을 마친 뒤 Harbor를 완전히 종료하고 다시 실행하면, 이곳에서 질문과 실행 승인을 처리할 수 있습니다."}
                </p>
                {state.requests && (
                  <small>
                    터미널에서 “질문은 Harbor로 보내줘”라고 요청할 수 있습니다.
                  </small>
                )}
              </div>
            )}
          </div>
        </>
      )}
      {tab === "messages" && (
        <SessionMessages
          terminalId={terminalId}
          terminals={state.terminals}
          hosts={state.hosts}
          messages={state.mailbox || []}
          onClose={() => onTab("requests")}
          onError={onError}
          onOpen={onOpen}
        />
      )}
      {tab === "notifications" && (
        <>
          <div className="inbox-notice-toolbar">
            <span>터미널에서 보낸 알림</span>
            <button onClick={() => read()}>
              <CheckCheck size={13} />
              모두 읽음
            </button>
          </div>
          <div className="inbox-scroll">
            {notices.map((notice) => (
              <button
                className={`inbox-notice ${notice.read ? "" : "unread"}`}
                key={notice.id}
                onClick={() => {
                  read(notice.targetId);
                  onOpen(notice.targetId);
                }}
              >
                <b>{notice.title}</b>
                <p>{notice.body}</p>
                <footer>
                  <time>
                    {new Date(notice.at).toLocaleTimeString("ko-KR", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                  <span>
                    터미널 열기 <ArrowUpRight size={12} />
                  </span>
                </footer>
              </button>
            ))}
            {!notices.length && (
              <div className="inbox-empty">
                <Bell size={27} />
                <b>아직 알림이 없습니다</b>
                <p>입력 요청과 작업 완료 등 터미널 알림을 이곳에 모읍니다.</p>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
