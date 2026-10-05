import { useEffect, useState } from "react";
import { ArrowRight, MessageSquare, Send, X } from "lucide-react";
import type { HostView, TerminalInfo } from "../shared/types";
import type { MailboxMessage } from "../shared/mailbox";
import { api } from "./api";

export default function SessionMessages({
  terminalId,
  terminals,
  hosts,
  messages,
  onClose,
  onError,
}: {
  terminalId: string;
  terminals: TerminalInfo[];
  hosts: HostView[];
  messages: MailboxMessage[];
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const terminal = terminals.find((t) => t.id === terminalId);
  const [to, setTo] = useState(terminalId);
  const recipient = terminals.find((t) => t.id === to);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<MailboxMessage | null>(null);
  const [allHistory, setAllHistory] = useState(terminalId === "__all__");
  useEffect(() => {
    setTo(
      terminalId === "__all__"
        ? terminals.find((t) => !t.exited)?.id || ""
        : terminalId,
    );
    setAllHistory(terminalId === "__all__");
    setReply(null);
  }, [terminalId]);
  const visible = messages
    .filter(
      (m) =>
        allHistory ||
        m.sender.terminalId === terminalId ||
        m.recipient.terminalId === terminalId,
    )
    .slice()
    .reverse();
  useEffect(() => {
    for (const message of visible)
      if (message.status === "queued")
        void api(`/mailbox/${message.id}/read`, {}).catch(() => {});
  }, [visible.map((m) => `${m.id}-${m.status}`).join(",")]);
  return (
    <aside className="session-mailbox" aria-label="세션 메시지">
      <header>
        <MessageSquare size={17} />
        <div>
          <b>메시지</b>
          <small>
            {allHistory ? "전체 기록" : terminal?.title || "종료된 세션"}
          </small>
        </div>
        <button
          className="icon-button"
          aria-label="메시지 닫기"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </header>
      <div className="mailbox-history-filter">
        <button
          className={!allHistory ? "active" : ""}
          disabled={terminalId === "__all__"}
          onClick={() => setAllHistory(false)}
        >
          이 세션
        </button>
        <button
          className={allHistory ? "active" : ""}
          onClick={() => setAllHistory(true)}
        >
          전체 기록
        </button>
      </div>
      <div className="mailbox-guide">
        <p>
          Codex에 <strong>“받은 메시지 확인해줘”</strong>라고 요청하세요.
        </p>
        <small>
          다른 세션에는 “
          {terminals.find((t) => t.id !== terminalId && !t.exited)?.title ||
            "백엔드"}{" "}
          세션에 변경 사항을 보내줘”처럼 말하면 됩니다.
        </small>
        <details>
          <summary>메시지는 언제 전달되나요?</summary>
          <p>
            메시지는 받은함에 보관됩니다. 받는 Codex가 메시지 도구를 호출하면
            ‘Codex 확인’으로 바뀝니다. 실행 중인 작업을 중단하거나 다음 명령을
            자동 실행하지 않습니다.
          </p>
        </details>
      </div>
      <div className="mailbox-history">
        {visible.length ? (
          visible.map((message) => (
            <article
              key={message.id}
              className={`mailbox-message ${message.author === "agent" ? "from-agent" : "from-user"}`}
            >
              <div className="mailbox-message-route">
                <b>{message.sender.title}</b>
                <ArrowRight size={12} />
                <span>{message.recipient.title}</span>
              </div>
              <div className="mailbox-host-route">
                {message.sender.hostName || "내가 보냄"} →{" "}
                {message.recipient.hostName || "나"}
              </div>
              <div className="mailbox-message-text">{message.text}</div>
              <footer>
                <time>
                  {new Date(message.createdAt).toLocaleTimeString("ko-KR", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
                <span>
                  {message.author === "agent" ? "Codex · " : "내가 보냄 · "}
                  {message.repliedAt
                    ? "답장 도착"
                    : message.status === "consumed"
                      ? "Codex 확인"
                      : message.recipient.kind === "user"
                        ? "받음"
                        : "받은함 대기"}
                </span>
                {message.sender.terminalId && (
                  <button
                    onClick={() => {
                      setTo(message.sender.terminalId!);
                      setReply(
                        message.recipient.kind === "user" ? message : null,
                      );
                    }}
                  >
                    {message.recipient.kind === "user"
                      ? "답장"
                      : "이 세션에 보내기"}
                  </button>
                )}
              </footer>
            </article>
          ))
        ) : (
          <div className="mailbox-empty">
            <MessageSquare size={28} />
            <b>세션 사이의 대화가 여기에</b>
            <p>작업 내용, 질문, 검토 결과를 주고받으세요.</p>
          </div>
        )}
      </div>
      <form
        className="mailbox-compose"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api("/mailbox", {
              toTerminalId: to,
              text,
              replyToId: reply?.id,
            });
            setText("");
            setReply(null);
          } catch (err) {
            onError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {reply && (
          <div className="mailbox-reply">
            <span>{reply.sender.title}에게 답장</span>
            <button
              type="button"
              aria-label="답장 취소"
              onClick={() => setReply(null)}
            >
              <X size={12} />
            </button>
          </div>
        )}
        <label>
          받는 세션
          <select
            aria-label="메시지 받을 세션"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setReply(null);
            }}
          >
            {terminals
              .filter((t) => !t.exited)
              .map((t) => (
                <option value={t.id} key={t.id}>
                  {t.title} · {hosts.find((h) => h.id === t.hostId)?.name}
                </option>
              ))}
          </select>
        </label>
        <p className="mailbox-delivery">
          {recipient?.agentConnected
            ? "Codex 연결됨 · 받은함에 전달하고, Codex가 읽으면 확인 상태를 표시합니다."
            : recipient && !recipient.exited
              ? "아직 Codex가 연결되지 않았습니다. 메시지는 보관되며, 해당 터미널에서 Codex 실행 후 확인할 수 있습니다."
              : "메시지를 보낼 실행 중인 세션을 선택하세요."}
        </p>
        <textarea
          aria-label="세션에 보낼 메시지"
          placeholder="전달할 작업이나 질문을 적으세요…"
          value={text}
          maxLength={16000}
          rows={4}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          className="button primary"
          disabled={
            busy ||
            !text.trim() ||
            !terminals.some((t) => t.id === to && !t.exited)
          }
        >
          <Send size={14} />
          받은함에 보내기
        </button>
      </form>
    </aside>
  );
}
