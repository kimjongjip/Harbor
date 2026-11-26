import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MessageCircle, Send, X, CornerDownLeft } from "lucide-react";
import { providerName } from "../shared/agent-provider";
import {
  sideTranscript,
  type SideBinding,
  type SideMessage,
  type SideReply,
} from "../shared/side-question";
import "./terminal-side-chat.css";

export function TerminalSideChat({
  binding,
  ask,
  insert,
  renderAnswer,
  disabled = false,
  active = true,
}: {
  binding: SideBinding;
  disabled?: boolean;
  active?: boolean;
  ask: (messages: SideMessage[], signal: AbortSignal) => Promise<SideReply>;
  insert: (text: string) => void;
  renderAnswer: (text: string) => ReactNode;
}) {
  const [open, setOpen] = useState(false),
    [messages, setMessages] = useState<SideMessage[]>([]);
  const [draft, setDraft] = useState(""),
    [pending, setPending] = useState(""),
    [error, setError] = useState("");
  const [model, setModel] = useState("");
  const [contextMissing, setContextMissing] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null),
    log = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(
    () => () => {
      request.current?.abort();
      request.current = undefined;
    },
    [],
  );
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  useEffect(() => {
    if (open && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [open, messages, pending, error]);
  const name = providerName(binding.provider);
  function close() {
    if (request.current) {
      request.current.abort();
      request.current = undefined;
      setDraft(pending);
      setPending("");
    }
    setError("");
    setOpen(false);
  }
  async function send() {
    if (request.current || !draft.trim() || disabled) return;
    const question = draft,
      next: SideMessage[] = [...messages, { role: "user", text: question }];
    const controller = new AbortController();
    request.current = controller;
    setDraft("");
    setPending(question);
    setError("");
    try {
      const answer = await ask(next, controller.signal);
      if (request.current !== controller) return;
      setMessages([...next, { role: "assistant", text: answer.text }]);
      setContextMissing(!answer.context);
      setModel([answer.model, answer.effort].filter(Boolean).join(" · "));
    } catch (cause) {
      if (request.current !== controller) return;
      setDraft(question);
      setError((cause as Error).message);
    } finally {
      if (request.current === controller) {
        request.current = undefined;
        setPending("");
      }
    }
  }
  return (
    <>
      <button
        type="button"
        ref={launcher}
        className="terminal-footer-button side-chat-launch"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <MessageCircle size={15} />옆 대화
      </button>
      {active && open &&
        createPortal(
          <section
            role="dialog"
            aria-label="옆 대화"
            className="terminal-side-chat"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                close();
              }
            }}
          >
            <header>
              <MessageCircle size={17} />
              <strong>옆 대화</strong>
              <small>
                {name}
                {model && " · " + model}
              </small>
              <button type="button" aria-label="옆 대화 닫기" onClick={close}>
                <X size={17} />
              </button>
            </header>
            <div className="side-chat-log" role="log" ref={log}>
              {!messages.length && !pending && (
                <p>
                  {binding.sessionId
                    ? "본 대화의 최근 기록을 참고합니다."
                    : "최근 터미널 출력에서 문맥을 확인합니다."}
                </p>
              )}
              {messages.map((m, i) => (
                <article
                  key={i}
                  data-speaker={m.role}
                  aria-label={m.role === "user" ? "나" : name}
                >
                  {m.role === "user" ? m.text : renderAnswer(m.text)}
                </article>
              ))}
              {pending && (
                <>
                  <article data-speaker="user">{pending}</article>
                  <small role="status">{name} 답변 중…</small>
                </>
              )}
            </div>
            {contextMissing && (
              <small>본 대화 문맥을 읽을 수 없어 옆 대화만 참고했습니다.</small>
            )}
            {error && <p role="alert">{error}</p>}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <textarea
                aria-label="옆 질문"
                placeholder="옆 질문…"
                ref={input}
                value={draft}
                rows={2}
                maxLength={32000}
                readOnly={!!pending}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing &&
                    e.nativeEvent.keyCode !== 229
                  ) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <button
                type="submit"
                aria-label="옆 질문 보내기"
                disabled={disabled || !!pending || !draft.trim()}
              >
                <Send size={16} />
              </button>
            </form>
            <footer>
              <button
                type="button"
                disabled={!messages.length || !!pending || disabled}
                onClick={() => {
                  try {
                    insert(sideTranscript(messages, binding.provider));
                    close();
                  } catch (cause) {
                    setError((cause as Error).message);
                  }
                }}
              >
                <CornerDownLeft size={15} />본 대화에 넣기
              </button>
            </footer>
          </section>,
          launcher.current?.closest(".terminal-instance") || document.body,
        )}
    </>
  );
}
