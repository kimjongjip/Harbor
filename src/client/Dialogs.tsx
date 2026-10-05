import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  FolderOpen,
  GitBranch,
  Globe2,
  HardDrive,
  Import,
  LoaderCircle,
  MessageSquare,
  Network,
  Plus,
  Search,
  Send,
  Server,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import type {
  AppState,
  HostConfig,
  HostView,
  PermissionMode,
  SessionSummary,
  SessionView,
} from "../shared/types";
import { api, sid } from "./api";

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const root = ref.current!;
    const first = root.querySelector<HTMLElement>(
      "input:not([type=hidden]),textarea,select,button",
    );
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key !== "Tab") return;
      const focusable = [
        ...root.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex]:not([tabindex="-1"]):not(:disabled)',
        ),
      ].filter((el) => el.getClientRects().length);
      const first = focusable[0],
        last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      }
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop">
      <div
        ref={ref}
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
      >
        <header className="modal-header">
          <div>
            <div className="eyebrow">HARBOR WORKSPACE</div>
            <h2 id={id}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="창 닫기"
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
function FormError({ error }: { error: string }) {
  return error ? (
    <div className="form-error" role="alert">
      {error}
    </div>
  ) : null;
}
function Submit({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <button className="button primary" disabled={busy} type="submit">
      {busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
      {busy ? "처리 중…" : children}
    </button>
  );
}

export function HostDialog({
  aliases,
  localCwd,
  existing,
  onClose,
  onAdded,
}: {
  aliases: string[];
  localCwd: string;
  existing?: HostView;
  onClose: () => void;
  onAdded: (host: HostView) => void;
}) {
  const [kind, setKind] = useState<"ssh" | "local">(existing?.kind || "ssh");
  const [name, setName] = useState(existing?.name || "");
  const [address, setAddress] = useState(existing?.address || "");
  const [username, setUsername] = useState(existing?.username || "");
  const [port, setPort] = useState(String(existing?.port || 22));
  const [cwd, setCwd] = useState(existing?.defaultCwd || "");
  const [identity, setIdentity] = useState(existing?.identityFile || "");
  const [codex, setCodex] = useState(existing?.codexPath || "codex");
  const [mode, setMode] = useState<HostConfig["mode"]>(
    existing?.mode || "auto",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title={existing ? "서버 설정" : "서버 추가"}
      subtitle="작업이 있는 곳을 워크스페이스에 연결하세요."
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const value = {
              name: name.trim(),
              kind,
              address: kind === "local" ? "localhost" : address.trim(),
              username,
              port: Number(port),
              defaultCwd: cwd || (kind === "local" ? localCwd : ""),
              identityFile: identity,
              codexPath: codex,
              mode,
              color:
                existing?.color || (kind === "ssh" ? "#93baf0" : "#c5ed92"),
            };
            const host = await api<HostView>(
              existing ? `/hosts/${existing.id}` : "/hosts",
              value,
              existing ? "PATCH" : "POST",
            );
            onAdded(host);
            onClose();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          <div className="choice-row">
            <button
              type="button"
              className={kind === "ssh" ? "choice active" : "choice"}
              onClick={() => setKind("ssh")}
            >
              <Globe2 size={20} />
              <span>
                <b>SSH 서버</b>
                <small>원격 개발 환경</small>
              </span>
              {kind === "ssh" && <Check size={16} />}
            </button>
            <button
              type="button"
              className={kind === "local" ? "choice active" : "choice"}
              onClick={() => {
                setKind("local");
                if (!cwd) setCwd(localCwd);
              }}
            >
              <HardDrive size={20} />
              <span>
                <b>로컬 환경</b>
                <small>이 컴퓨터의 Codex</small>
              </span>
              {kind === "local" && <Check size={16} />}
            </button>
          </div>
          <label className="field">
            서버 이름
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: 연구 서버, 개발 서버"
              maxLength={100}
            />
          </label>
          {kind === "ssh" && (
            <>
              <label className="field">
                SSH 호스트 또는 별칭
                <input
                  required
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="devbox 또는 192.168.0.10"
                  list="ssh-aliases"
                />
                <datalist id="ssh-aliases">
                  {aliases.map((alias) => (
                    <option key={alias} value={alias} />
                  ))}
                </datalist>
                <small>기존 SSH 설정의 별칭을 그대로 사용할 수 있어요.</small>
              </label>
              <div className="field-row">
                <label className="field">
                  사용자 이름
                  <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="SSH 설정 사용"
                  />
                </label>
                <label className="field short-field">
                  포트
                  <input
                    required
                    type="number"
                    min={1}
                    max={65535}
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                  />
                </label>
              </div>
            </>
          )}
          <label className="field">
            기본 프로젝트 경로
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder={
                kind === "ssh" ? "/home/user/projects/my-app" : localCwd
              }
            />
            <small>
              같은 서버에서도 세션마다 다른 폴더를 선택할 수 있어요.
            </small>
          </label>
          <details className="advanced">
            <summary>
              고급 연결 설정
              <ChevronDown size={15} />
            </summary>
            <div className="advanced-content">
              {kind === "ssh" && (
                <label className="field">
                  SSH 키 파일 경로
                  <input
                    value={identity}
                    onChange={(e) => setIdentity(e.target.value)}
                    placeholder="비워두면 SSH 설정과 에이전트 사용"
                  />
                </label>
              )}
              <label className="field">
                Codex 실행 파일
                <input
                  value={codex}
                  onChange={(e) => setCodex(e.target.value)}
                  placeholder="codex"
                />
              </label>
              <label className="field">
                세션 연결 방식
                <select
                  value={mode}
                  onChange={(e) =>
                    setMode(e.target.value as HostConfig["mode"])
                  }
                >
                  <option value="auto">자동 — 기존 세션 연결 우선</option>
                  <option value="shared">기존 백그라운드 Codex에 연결</option>
                  <option value="isolated">별도 Codex 프로세스 사용</option>
                </select>
                <small>
                  별도 프로세스는 Harbor 종료 또는 SSH 연결 종료 시 작업이
                  중단될 수 있습니다.
                </small>
              </label>
            </div>
          </details>
          {kind === "ssh" && (
            <div className="notice-box">
              <ShieldCheck size={17} />
              <span>
                SSH 키와 비밀번호 연결을 지원합니다. 비밀번호는 연결할 때
                입력하며 설정 파일에 저장하지 않습니다. 처음 접속하는 서버는
                터미널에서 서버 키를 확인해 주세요.
              </span>
            </div>
          )}
          <FormError error={error} />
        </div>
        <footer className="modal-footer">
          <button type="button" className="button ghost" onClick={onClose}>
            취소
          </button>
          <Submit busy={busy}>{existing ? "설정 저장" : "서버 추가"}</Submit>
        </footer>
      </form>
    </Modal>
  );
}

export function SessionDialog({
  hosts,
  initialHostId,
  onClose,
  onCreated,
}: {
  hosts: HostView[];
  initialHostId?: string;
  onClose: () => void;
  onCreated: (session: SessionView) => void;
}) {
  const [hostId, setHostId] = useState(
    initialHostId || hosts[0]?.id || "local",
  );
  const host = hosts.find((h) => h.id === hostId)!;
  const [title, setTitle] = useState("");
  const [cwd, setCwd] = useState(host?.defaultCwd || "");
  const [model, setModel] = useState("");
  const [permission, setPermission] =
    useState<PermissionMode>("workspace-write");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title="새 세션"
      subtitle="하나의 작업에 하나의 세션. 필요한 만큼 나란히 열어보세요."
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            if (host.status !== "connected")
              await api(`/hosts/${hostId}/connect`, {});
            const session = await api<SessionView>(
              `/hosts/${hostId}/sessions`,
              {
                title: title.trim(),
                cwd,
                model: model || undefined,
                permission,
              },
            );
            onCreated(session);
            onClose();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          <label className="field">
            서버
            <select
              value={hostId}
              onChange={(e) => {
                setHostId(e.target.value);
                setCwd(
                  hosts.find((h) => h.id === e.target.value)?.defaultCwd || "",
                );
                setModel("");
              }}
            >
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name} · {h.kind === "local" ? "로컬" : h.address}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            세션 이름
            <input
              required
              autoComplete="off"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="예: API 구현, 프론트엔드 검토"
              maxLength={100}
            />
          </label>
          <label className="field">
            프로젝트 경로
            <input
              required
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder={
                host?.kind === "ssh"
                  ? "/home/user/projects/my-app"
                  : "C:\\projects\\my-app"
              }
            />
            <small>
              동시에 코드를 수정하는 세션은 서로 다른 작업 폴더나 worktree를
              사용하세요.
            </small>
          </label>
          <div className="field-row">
            <label className="field">
              모델
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">서버의 기본 모델</option>
                {host?.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              작업 권한
              <select
                value={permission}
                onChange={(e) =>
                  setPermission(e.target.value as PermissionMode)
                }
              >
                <option value="workspace-write">프로젝트 파일 수정</option>
                <option value="read-only">읽기 전용 · 검토</option>
              </select>
            </label>
          </div>
          <div className="notice-box">
            <GitBranch size={17} />
            <span>
              세션마다 독립된 대화를 유지합니다. 화면에서 세션을 닫아도 대화
              기록은 남습니다.
            </span>
          </div>
          <FormError error={error} />
        </div>
        <footer className="modal-footer">
          <button type="button" className="button ghost" onClick={onClose}>
            취소
          </button>
          <Submit busy={busy}>세션 만들기</Submit>
        </footer>
      </form>
    </Modal>
  );
}

interface Discovered {
  id: string;
  title: string;
  cwd: string;
  status: string;
  updatedAt: number;
}
export function ImportDialog({
  hosts,
  initialHostId,
  onClose,
  onImported,
}: {
  hosts: HostView[];
  initialHostId?: string;
  onClose: () => void;
  onImported: (session: SessionView) => void;
}) {
  const [hostId, setHostId] = useState(
    initialHostId || hosts[0]?.id || "local",
  );
  const [items, setItems] = useState<Discovered[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(true);
  const [importing, setImporting] = useState("");
  const [error, setError] = useState("");
  const generation = useRef(0);
  async function load(more = false) {
    const gen = ++generation.current;
    setBusy(true);
    setError("");
    try {
      await api(`/hosts/${hostId}/connect`, {});
      const params = new URLSearchParams();
      if (more && cursor) params.set("cursor", cursor);
      if (query) params.set("search", query);
      const result = await api<{
        data: Discovered[];
        nextCursor: string | null;
      }>(`/hosts/${hostId}/threads?${params}`, undefined, "GET");
      if (gen !== generation.current) return;
      setItems((prev) => (more ? [...prev, ...result.data] : result.data));
      setCursor(result.nextCursor);
    } catch (err) {
      if (gen === generation.current) setError((err as Error).message);
    } finally {
      if (gen === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    setItems([]);
    setCursor(null);
    void load();
    return () => {
      generation.current++;
    };
  }, [hostId, query]);
  return (
    <Modal
      title="기존 세션 불러오기"
      subtitle="서버에 저장된 Codex 대화를 워크스페이스에 추가합니다."
      onClose={onClose}
      wide
    >
      <div className="modal-body">
        <div className="field-row">
          <label className="field">
            서버
            <select value={hostId} onChange={(e) => setHostId(e.target.value)}>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </label>
          <form
            className="field"
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(search);
            }}
          >
            <label htmlFor="history-search">세션 이름 검색</label>
            <div className="input-button">
              <input
                id="history-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="찾고 싶은 작업"
              />
              <button aria-label="기록 검색" className="icon-button">
                <Search size={17} />
              </button>
            </div>
          </form>
        </div>
        <FormError error={error} />
        <div className="discover-list">
          {items.map((item) => (
            <button
              className="discover-row"
              disabled={Boolean(importing)}
              key={item.id}
              onClick={async () => {
                setImporting(item.id);
                setError("");
                try {
                  const s = await api<SessionView>(`/hosts/${hostId}/import`, {
                    threadId: item.id,
                  });
                  onImported(s);
                  onClose();
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setImporting("");
                }
              }}
            >
              <span className="discover-icon">
                <MessageSquare size={18} />
              </span>
              <span>
                <b>{item.title}</b>
                <small title={item.cwd}>{item.cwd}</small>
              </span>
              <time>
                {new Date(item.updatedAt).toLocaleDateString("ko-KR", {
                  month: "short",
                  day: "numeric",
                })}
              </time>
              {importing === item.id ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <ArrowRight size={16} />
              )}
            </button>
          ))}
          {busy && (
            <div className="list-empty">
              <LoaderCircle className="spin" size={20} /> 세션을 찾고 있습니다…
            </div>
          )}
          {!busy && !items.length && !error && (
            <div className="list-empty">저장된 세션이 없습니다.</div>
          )}
          {cursor && !busy && (
            <button
              className="button ghost load-more"
              onClick={() => void load(true)}
            >
              이전 세션 더 보기
            </button>
          )}
        </div>
        <p className="helper">
          기존 백그라운드 Codex에 연결하면 실행 상태도 함께 확인할 수 있습니다.
          다른 별도 프로세스에서 같은 대화를 실행 중이라면 먼저 그 작업을 마쳐
          주세요.
        </p>
      </div>
      <footer className="modal-footer">
        <span className="footer-note">
          <Import size={15} /> 원본 대화 기록 유지
        </span>
        <button className="button secondary" onClick={onClose}>
          닫기
        </button>
      </footer>
    </Modal>
  );
}

export function TransferDialog({
  sessions,
  initialIds,
  onClose,
  onSent,
}: {
  sessions: SessionSummary[];
  initialIds: string[];
  onClose: () => void;
  onSent: (id: string) => void;
}) {
  const [fromId, setFrom] = useState(initialIds[0] || sessions[0]?.id || "");
  const [toId, setTo] = useState(
    initialIds[1] || sessions.find((s) => s.id !== fromId)?.id || "",
  );
  const [kind, setKind] = useState<"context" | "review">("context");
  const [request, setRequest] = useState(
    "이 기록을 바탕으로 현재 상태를 파악하고, 다음에 할 일을 제안해 주세요.",
  );
  const [context, setContext] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let ignore = false;
    setLoading(true);
    setContext("");
    setError("");
    api<{ text: string }>(`${sid(fromId)}/context`, {})
      .then((r) => {
        if (!ignore) setContext(r.text);
      })
      .catch((e) => {
        if (!ignore) setError(e.message);
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [fromId]);
  const source = sessions.find((s) => s.id === fromId);
  const target = sessions.find((s) => s.id === toId);
  return (
    <Modal
      title="세션에 맥락 전달"
      subtitle="다른 세션이 작업을 이해하는 데 필요한 기록을 골라 보내세요."
      onClose={onClose}
      wide
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api("/transfers", {
              fromId,
              toId,
              kind,
              text: `${kind === "review" ? "읽기 전용으로 검토해 주세요. 파일을 변경하지 마세요.\n" : ""}사용자의 요청:\n${request}\n\n--- 다른 세션의 참고 기록 ---\n${context}`,
            });
            onSent(toId);
            onClose();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          <div className="transfer-route">
            <label className="field">
              보내는 세션
              <select
                value={fromId}
                onChange={(e) => {
                  setFrom(e.target.value);
                  if (toId === e.target.value)
                    setTo(
                      sessions.find((s) => s.id !== e.target.value)?.id || "",
                    );
                }}
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </label>
            <ArrowRight size={20} />
            <label className="field">
              받는 세션
              <select value={toId} onChange={(e) => setTo(e.target.value)}>
                {sessions
                  .filter((s) => s.id !== fromId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div className="segmented wide-segment">
            <button
              type="button"
              className={kind === "context" ? "active" : ""}
              onClick={() => setKind("context")}
            >
              <Send size={15} /> 맥락 전달
            </button>
            <button
              type="button"
              className={kind === "review" ? "active" : ""}
              onClick={() => setKind("review")}
            >
              <ShieldCheck size={15} /> 읽기 전용 검토
            </button>
          </div>
          <label className="field">
            받는 세션에게 할 요청
            <textarea
              rows={2}
              required
              value={request}
              onChange={(e) => setRequest(e.target.value)}
            />
          </label>
          <label className="field">
            전달할 기록{" "}
            <span className="label-aside">보내기 전에 수정할 수 있어요</span>
            <textarea
              className="context-editor"
              rows={9}
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder={
                loading
                  ? "최근 작업 기록을 불러오는 중…"
                  : "전달할 내용을 입력하세요."
              }
            />
          </label>
          <div className="notice-box">
            <Network size={17} />
            <span>
              {source?.hostId === target?.hostId
                ? "같은 서버의 세션입니다."
                : "다른 서버의 세션으로 전달합니다."}{" "}
              대화 맥락만 전달하며, 코드 파일·의존성·실행 환경은 이동하지
              않습니다.
            </span>
          </div>
          <FormError error={error} />
        </div>
        <footer className="modal-footer">
          <button type="button" className="button ghost" onClick={onClose}>
            취소
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={busy || loading || !toId || !context}
          >
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Send size={16} />
            )}
            전달하기
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function DiscussionDialog({
  sessions,
  initialIds,
  onClose,
  onStarted,
}: {
  sessions: SessionSummary[];
  initialIds: string[];
  onClose: () => void;
  onStarted: () => void;
}) {
  const [a, setA] = useState(initialIds[0] || sessions[0]?.id || "");
  const [b, setB] = useState(
    initialIds[1] || sessions.find((s) => s.id !== a)?.id || "",
  );
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title="두 세션과 함께 검토"
      subtitle="각 세션의 맥락을 활용해 의견을 교환하고 결론을 남깁니다."
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api("/discussions", { sessionIds: [a, b], topic });
            onStarted();
            onClose();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          <div className="field-row">
            <label className="field">
              세션 A
              <select
                value={a}
                onChange={(e) => {
                  setA(e.target.value);
                  if (b === e.target.value)
                    setB(
                      sessions.find((s) => s.id !== e.target.value)?.id || "",
                    );
                }}
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              세션 B
              <select value={b} onChange={(e) => setB(e.target.value)}>
                {sessions
                  .filter((s) => s.id !== a)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <label className="field">
            함께 검토할 주제
            <textarea
              required
              rows={4}
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="예: 두 구현의 API 규약을 비교하고, 합의할 인터페이스와 남은 쟁점을 정리해 주세요."
            />
          </label>
          <div className="discussion-flow">
            <span>
              <b>01</b> A의 관점
            </span>
            <ArrowRight size={15} />
            <span>
              <b>02</b> B의 검토
            </span>
            <ArrowRight size={15} />
            <span>
              <b>03</b> A의 정리
            </span>
          </div>
          <p className="helper">
            총 3회 응답하는 읽기 전용 토론입니다. 토론 중에는 두 세션의 일반
            메시지 전송이 잠시 제한됩니다. 진행 상황과 결론은 협업 기록에
            저장합니다.
          </p>
          <FormError error={error} />
        </div>
        <footer className="modal-footer">
          <button type="button" className="button ghost" onClick={onClose}>
            취소
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={busy || !b}
          >
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Sparkles size={16} />
            )}
            검토 시작
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function RenameDialog({
  session,
  onClose,
  onRenamed,
}: {
  session: SessionSummary;
  onClose: () => void;
  onRenamed: (session: SessionView) => void;
}) {
  const [title, setTitle] = useState(session.title);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="세션 이름 변경" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            onRenamed(
              await api<SessionView>(`${sid(session.id)}/rename`, { title }),
            );
            onClose();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          <label className="field">
            세션 이름
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
            />
          </label>
          <FormError error={error} />
        </div>
        <footer className="modal-footer">
          <button type="button" className="button ghost" onClick={onClose}>
            취소
          </button>
          <Submit busy={busy}>저장</Submit>
        </footer>
      </form>
    </Modal>
  );
}

export function ConnectDialog({
  host,
  onClose,
  onConnected,
}: {
  host: HostView;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title={`${host.name} 연결`}
      subtitle={`${host.username ? host.username + "@" : ""}${host.address}:${host.port}`}
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api(
              `/hosts/${host.id}/connect`,
              password ? { password } : {},
            );
            setPassword("");
            onConnected();
            onClose();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          <label className="field">
            SSH 비밀번호 · 선택
            <input
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="SSH 키를 사용하면 비워두세요"
            />
            <small>
              비밀번호는 연결 중 메모리에서만 사용하고, 설정 파일에는 저장하지
              않습니다.
            </small>
          </label>
          <div className="notice-box">
            <ShieldCheck size={17} />
            <span>기존 SSH 설정과 등록된 서버 키를 확인한 뒤 연결합니다.</span>
          </div>
          <FormError error={error} />
        </div>
        <footer className="modal-footer">
          <button className="button ghost" type="button" onClick={onClose}>
            취소
          </button>
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Network size={16} />
            )}
            {busy ? "서버 연결 중…" : "연결하기"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
