import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Circle,
  Copy,
  ExternalLink,
  FileCode2,
  FolderOpen,
  ImagePlus,
  GitBranch,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  X,
} from "lucide-react";
import { Markdown } from "./RichMarkdown";
export { Markdown } from "./RichMarkdown";
import { ResourceContext } from "./ResourcePreview";
import type {
  Approval,
  HostView,
  MessageItem,
  SessionSummary,
  SessionView,
} from "../shared/types";
import { api, sid } from "./api";
import {
  ImageAttachments,
  readImages,
  type AttachedImage,
} from "./ImageAttachments";

const drafts = new Map<string, { text: string; images: AttachedImage[] }>();

export const statusLabels = {
  idle: "대기",
  running: "작업 중",
  waiting: "확인 필요",
  error: "오류",
  offline: "연결 끊김",
};
export function Status({ status }: { status: keyof typeof statusLabels }) {
  return (
    <span className={`status-badge ${status}`}>
      <span className="status-dot" />
      {statusLabels[status]}
    </span>
  );
}
function Item({ item }: { item: MessageItem }) {
  if (item.kind === "command" || item.kind === "change" || item.kind === "tool")
    return (
      <details className={`tool-item ${item.kind}`}>
        <summary>
          {item.kind === "command" ? (
            <Terminal size={13} />
          ) : item.kind === "change" ? (
            <FileCode2 size={13} />
          ) : (
            <Sparkles size={13} />
          )}
          <span>{item.text || "실행 중…"}</span>
          {item.status === "inProgress" ? (
            <LoaderCircle size={12} className="spin" />
          ) : (
            <ChevronDown size={12} />
          )}
        </summary>
        {item.detail && <pre>{item.detail}</pre>}
      </details>
    );
  if (item.kind === "notice")
    return <div className="message-notice">{item.text}</div>;
  if (item.kind === "plan")
    return (
      <div className="plan-item">
        <span className="message-label">
          <CheckCheck size={13} />
          작업 계획
        </span>
        <Markdown text={item.text} />
      </div>
    );
  return (
    <article
      className={`message ${item.kind} ${item.phase === "commentary" ? "commentary" : ""}`}
    >
      <div className="message-label">
        {item.kind === "user" ? (
          <>
            <span className="user-avatar">나</span>나
          </>
        ) : (
          <>
            <span className="agent-avatar">✳</span>Codex
            {item.phase === "commentary" && <small>진행 상황</small>}
          </>
        )}
      </div>
      {item.imageCount ? (
        <div className="message-image-note">
          <ImagePlus size={14} />
          이미지 {item.imageCount}개 첨부
        </div>
      ) : null}
      {item.text && <Markdown text={item.text} />}
    </article>
  );
}

function ApprovalCard({
  approval,
  onAnswer,
}: {
  approval: Approval;
  onAnswer: (value: {
    approved?: boolean;
    answers?: Record<string, string>;
  }) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  return (
    <div className="approval-card">
      <div className="approval-title">
        <ShieldCheck size={16} />
        <b>{approval.title}</b>
      </div>
      {approval.detail && <pre>{approval.detail}</pre>}
      {approval.kind === "question" &&
        approval.questions?.map((q) => (
          <div className="approval-question" key={q.id}>
            <label>{q.question}</label>
            <div className="answer-options">
              {q.options?.map((o) => (
                <button
                  key={o.label}
                  className={answers[q.id] === o.label ? "selected" : ""}
                  title={o.description}
                  onClick={() => setAnswers((a) => ({ ...a, [q.id]: o.label }))}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <input
              aria-label={q.question}
              value={answers[q.id] || ""}
              onChange={(e) =>
                setAnswers((a) => ({ ...a, [q.id]: e.target.value }))
              }
              placeholder="답변 입력"
            />
          </div>
        ))}
      <div className="approval-actions">
        {approval.kind !== "question" && (
          <button
            className="button secondary small"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onAnswer({ approved: false });
              } finally {
                setBusy(false);
              }
            }}
          >
            거절
          </button>
        )}
        {approval.kind !== "permissions" && (
          <button
            className="button primary small"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onAnswer(
                  approval.kind === "question"
                    ? { answers }
                    : { approved: true },
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Check size={14} />
            )}
            {approval.kind === "question" ? "답변 보내기" : "이번 작업 승인"}
          </button>
        )}
      </div>
      {approval.kind === "permissions" && (
        <small>세부 권한 승인은 Codex CLI에서 처리할 수 있습니다.</small>
      )}
    </div>
  );
}

export default function SessionPanel({
  session,
  detail,
  host,
  selected,
  focused,
  index,
  onSelect,
  onFocus,
  onClose,
  onExpand,
  onRename,
  onTransfer,
  onTerminal,
  onFiles,
  onError,
  onLoaded,
  onForked,
  onConnect,
}: {
  session: SessionSummary;
  detail?: SessionView;
  host: HostView;
  selected: boolean;
  focused: boolean;
  index: number;
  onSelect: () => void;
  onFocus: () => void;
  onClose: () => void;
  onExpand: () => void;
  onRename: () => void;
  onTransfer: () => void;
  onTerminal: () => void;
  onFiles: () => void;
  onError: (message: string) => void;
  onLoaded: (s: SessionView) => void;
  onForked: (s: SessionView) => void;
  onConnect: () => void;
}) {
  const [text, setText] = useState(drafts.get(session.id)?.text || "");
  const [images, setImages] = useState<AttachedImage[]>(
    drafts.get(session.id)?.images || [],
  );
  const [readingImages, setReadingImages] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const addingImages = useRef(false);
  const [imageDragging, setImageDragging] = useState(false);
  useEffect(() => {
    drafts.set(session.id, { text, images });
  }, [session.id, text, images]);
  const [sending, setSending] = useState(false);
  const [menu, setMenu] = useState(false);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const live = { ...detail, ...session };
  const connected = host.status === "connected";
  const busy = live.status === "running";
  const items = detail?.items || [];
  useEffect(() => {
    if (!connected || detail?.loaded) {
      setLoading(false);
      return;
    }
    let ignored = false;
    setLoading(true);
    api<SessionView>(`${sid(session.id)}/open`, {})
      .then((s) => {
        if (!ignored) onLoaded(s);
      })
      .catch((e) => {
        if (!ignored) onError(e.message);
      })
      .finally(() => {
        if (!ignored) setLoading(false);
      });
    return () => {
      ignored = true;
    };
  }, [session.id, connected, detail?.loaded]);
  useEffect(() => {
    if (nearBottom.current && scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [items, detail?.approvals, live.status]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menu]);
  async function send() {
    if (
      (!text.trim() && !images.length) ||
      sending ||
      readingImages ||
      !connected ||
      live.jobId ||
      live.status === "waiting"
    )
      return;
    const value = text;
    setSending(true);
    try {
      await api(`${sid(session.id)}/message`, {
        text: value,
        images: images.map((image) => image.url),
        mode: busy ? "steer" : "send",
      });
      setText("");
      setImages([]);
      nearBottom.current = true;
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSending(false);
      textarea.current?.focus();
    }
  }
  async function attach(files: File[]) {
    if (!files.length || addingImages.current || sending) return;
    addingImages.current = true;
    setReadingImages(true);
    try {
      const added = await readImages(files, images);
      setImages((prev) => [...prev, ...added]);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      addingImages.current = false;
      setReadingImages(false);
    }
  }
  async function act(action: () => Promise<unknown>) {
    try {
      await action();
    } catch (e) {
      onError((e as Error).message);
    }
  }
  return (
    <ResourceContext.Provider
      value={{ hostId: session.hostId, cwd: session.cwd }}
    >
      <section
        className={`session-panel ${focused ? "focused" : ""} ${selected ? "selected" : ""}`}
        data-testid={`session-panel-${session.id}`}
        onPointerDown={onFocus}
      >
        <header className="panel-header">
          <button
            className={`session-select ${selected ? "checked" : ""}`}
            aria-label={`선택: ${session.title}`}
            aria-pressed={selected}
            onClick={onSelect}
          >
            {selected ? (
              <Check size={13} />
            ) : (
              <span>{String(index + 1).padStart(2, "0")}</span>
            )}
          </button>
          <div className="panel-title">
            <h3 title={session.title}>{session.title}</h3>
            <div>
              <span className="host-dot" style={{ background: host.color }} />
              <span>{host.name}</span>
              <span className="dot-separator">·</span>
              <span>{shortPath(session.cwd)}</span>
            </div>
          </div>
          <Status status={live.status} />
          <div className="panel-actions">
            <button
              className="icon-button compact"
              title="이 세션 크게 보기"
              aria-label={`크게 보기: ${session.title}`}
              onClick={onExpand}
            >
              <Maximize2 size={14} />
            </button>
            <div className="menu-anchor">
              <button
                className="icon-button compact"
                aria-label={`메뉴: ${session.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenu(!menu);
                }}
              >
                <MoreHorizontal size={16} />
              </button>
              {menu && (
                <div className="dropdown" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => {
                      onRename();
                      setMenu(false);
                    }}
                  >
                    <Pencil size={14} />
                    이름 변경
                  </button>
                  <button
                    onClick={() => {
                      window.open(
                        `/?session=${encodeURIComponent(session.id)}`,
                        "_blank",
                        "noopener,noreferrer",
                      );
                      setMenu(false);
                    }}
                  >
                    <ExternalLink size={14} />새 창에서 열기
                  </button>
                  <button
                    disabled={!connected || busy}
                    onClick={() => {
                      setMenu(false);
                      void act(async () => {
                        const fork = await api<SessionView>(
                          `${sid(session.id)}/fork`,
                          { title: `${session.title} · 분기`.slice(0, 100) },
                        );
                        onForked(fork);
                      });
                    }}
                  >
                    <GitBranch size={14} />
                    대화 분기
                  </button>
                  <button
                    onClick={() => {
                      onTransfer();
                      setMenu(false);
                    }}
                  >
                    <Send size={14} />
                    맥락 전달
                  </button>
                  <button
                    onClick={() => {
                      onTerminal();
                      setMenu(false);
                    }}
                  >
                    <Terminal size={14} />이 폴더에서 터미널
                  </button>
                  <button
                    onClick={() => {
                      onFiles();
                      setMenu(false);
                    }}
                  >
                    <FolderOpen size={14} />이 폴더의 파일 보기
                  </button>
                </div>
              )}
            </div>
            <button
              className="icon-button compact"
              title="화면에서 닫기 · 작업은 유지됩니다"
              aria-label={`화면에서 닫기: ${session.title}`}
              onClick={onClose}
            >
              <X size={15} />
            </button>
          </div>
        </header>
        <div className="panel-meta">
          <span>
            <FolderIcon /> <span title={session.cwd}>{session.cwd}</span>
          </span>
          <span>{session.model || "기본 모델"}</span>
        </div>
        <div
          className="panel-messages"
          ref={scrollRef}
          onScroll={() => {
            const el = scrollRef.current!;
            nearBottom.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 100;
          }}
        >
          {detail?.historyCursor && (
            <button
              className="history-more"
              onClick={() =>
                void act(async () =>
                  onLoaded(await api(`${sid(session.id)}/history`, {})),
                )
              }
            >
              <ChevronUp size={13} />
              이전 대화 더 보기
            </button>
          )}
          {loading && (
            <div className="panel-loading">
              <LoaderCircle size={18} className="spin" />
              대화 불러오는 중…
            </div>
          )}
          {!loading && !items.length && (
            <div className="session-welcome">
              <div className="welcome-mark">✳</div>
              <h4>이 세션에서 무엇을 할까요?</h4>
              <p>
                다른 세션과 나란히 작업하거나
                <br />
                독립적으로 하나의 작업에 집중하세요.
              </p>
              <div className="suggestion-chips">
                <button
                  onClick={() => {
                    setText(
                      "프로젝트 구조를 살펴보고 주요 구성 요소를 요약해 주세요. 파일은 변경하지 마세요.",
                    );
                    textarea.current?.focus();
                  }}
                >
                  프로젝트 살펴보기
                </button>
                <button
                  onClick={() => {
                    setText(
                      "현재 변경 사항을 검토하고 확인할 항목을 정리해 주세요. 파일은 변경하지 마세요.",
                    );
                    textarea.current?.focus();
                  }}
                >
                  변경 사항 검토
                </button>
              </div>
            </div>
          )}
          {items.map((item) => (
            <Item key={item.id} item={item} />
          ))}
          {detail?.approvals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              onAnswer={(value) =>
                act(() =>
                  api(`${sid(session.id)}/approval`, {
                    approvalId: approval.id,
                    ...value,
                  }),
                )
              }
            />
          ))}
          {live.error && (
            <div className="inline-error" role="alert">
              {live.error}
            </div>
          )}
          {busy && (
            <div className="working-indicator">
              <span />
              <span />
              <span />
              <small>
                {live.jobId
                  ? "다른 세션과 검토 중"
                  : "Codex가 작업하고 있습니다"}
              </small>
            </div>
          )}
        </div>
        {!connected && (
          <div className="offline-strip">
            <span>서버에 다시 연결하면 대화를 이어갈 수 있어요.</span>
            <button onClick={onConnect}>연결</button>
          </div>
        )}
        <form
          className={`composer ${imageDragging ? "image-dragging" : ""}`}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              setImageDragging(true);
            }
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node))
              setImageDragging(false);
          }}
          onDrop={(e) => {
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              setImageDragging(false);
              void attach([...e.dataTransfer.files]);
            }
          }}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {images.length > 0 && (
            <ImageAttachments
              images={images}
              disabled={sending}
              onRemove={(id) =>
                setImages((prev) => prev.filter((image) => image.id !== id))
              }
            />
          )}
          {imageDragging && (
            <div className="image-drop-hint">
              <ImagePlus size={17} />
              이미지를 놓아 첨부하세요
            </div>
          )}
          <textarea
            ref={textarea}
            rows={2}
            aria-label={`메시지: ${session.title}`}
            value={text}
            disabled={!connected || sending || Boolean(live.jobId)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length) {
                e.preventDefault();
                void attach(files);
              }
            }}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={
              live.jobId
                ? "토론이 진행 중입니다…"
                : busy
                  ? "진행 중인 작업에 방향을 더해주세요…"
                  : "작업을 입력하거나 캡처를 붙여넣으세요…"
            }
          />
          <div className="composer-footer">
            <span className="permission-label">
              <button
                type="button"
                className="attach-image-button"
                title="이미지 첨부 · 캡처 후 Ctrl+V"
                aria-label={`이미지 첨부: ${session.title}`}
                disabled={sending || readingImages || Boolean(live.jobId)}
                onClick={() => imageInput.current?.click()}
              >
                {readingImages ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <ImagePlus size={15} />
                )}
              </button>
              <input
                type="file"
                ref={imageInput}
                data-testid={`image-input-${session.id}`}
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                hidden
                onChange={(e) => {
                  void attach([...(e.target.files || [])]);
                  e.target.value = "";
                }}
              />
              <ShieldCheck size={12} />
              {session.permission === "read-only"
                ? "읽기 전용"
                : "프로젝트 수정"}
              <span className="enter-hint">Shift ↵ 줄바꿈</span>
            </span>
            <div>
              {busy && (
                <button
                  type="button"
                  className="icon-button stop-button"
                  title="실행 중지"
                  aria-label={`중지: ${session.title}`}
                  onClick={() =>
                    void act(() => api(`${sid(session.id)}/interrupt`, {}))
                  }
                >
                  <Square size={12} fill="currentColor" />
                </button>
              )}
              <button
                className="send-button"
                aria-label={`보내기: ${session.title}`}
                disabled={
                  !connected ||
                  sending ||
                  (!text.trim() && !images.length) ||
                  readingImages ||
                  Boolean(live.jobId) ||
                  live.status === "waiting"
                }
              >
                {sending ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <ArrowUp size={17} />
                )}
              </button>
            </div>
          </div>
        </form>
      </section>
    </ResourceContext.Provider>
  );
}
const FolderIcon = () => <FileCode2 size={12} />;
export function shortPath(value: string) {
  return (
    value
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || value
  );
}
