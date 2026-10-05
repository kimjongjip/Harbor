import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronRight,
  Folder,
  History as HistoryIcon,
  LoaderCircle,
  RefreshCw,
  Search,
  Terminal,
} from "lucide-react";
import type { HostView, TerminalInfo } from "../shared/types";
import type {
  HistoryThread,
  HistoryPage,
  HistoryDetail,
} from "../shared/history";
import { api } from "./api";
import { Markdown } from "./RichMarkdown";
import { Modal } from "./Dialogs";
import { useTheme, terminalColors } from "./Theme";
import "./history.css";

export default function CodexHistory({
  hosts,
  provider = "codex",
  initialHostId,
  onResume,
  onConnect,
}: {
  hosts: HostView[];
  provider?: "codex" | "claude";
  initialHostId?: string;
  onResume: (terminal: TerminalInfo) => void;
  onConnect: (host: HostView) => void;
}) {
  const label = provider === "claude" ? "Claude" : "Codex";
  const { theme } = useTheme();
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(`harbor-history-expanded-${provider}`) === "true";
    } catch {
      return false;
    }
  });
  const contentId = useId();
  const loadedKey = useRef<string | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem(`harbor-history-expanded-${provider}`, String(expanded));
    } catch {
      // The toggle remains usable when browser storage is unavailable.
    }
  }, [expanded]);
  const [hostId, setHostId] = useState(initialHostId || "all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [automation, setAutomation] = useState(false);
  const [archived, setArchived] = useState(false);
  const [threads, setThreads] = useState<HistoryThread[]>([]);
  const [cursors, setCursors] = useState<Record<string, string | null>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<HistoryThread | null>(null);
  const [detail, setDetail] = useState<HistoryDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [reading, setReading] = useState(false);
  const [resuming, setResuming] = useState(false);
  const generation = useRef(0),
    readingGeneration = useRef(0),
    loadLock = useRef(false);
  useEffect(() => setHostId(initialHostId || "all"), [initialHostId]);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const hostKey = hosts
    .map((h) => h.id)
    .sort()
    .join(",");
  const queryKey = JSON.stringify([
    hostId,
    query,
    automation,
    archived,
    hostKey,
  ]);
  useEffect(() => {
    if (hostId !== "all" && !hosts.some((host) => host.id === hostId))
      setHostId("all");
  }, [hostKey, hostId]);
  async function load(more = false) {
    if (more && loadLock.current) return;
    const current = ++generation.current;
    loadLock.current = true;
    setBusy(true);
    const targets = hosts.filter(
      (h) => (hostId === "all" || h.id === hostId) && (!more || cursors[h.id]),
    );
    if (!more) {
      loadedKey.current = queryKey;
      setThreads([]);
      setCursors({});
      setErrors({});
    }
    const results = await Promise.allSettled(
      targets.map(async (host) => ({
        hostId: host.id,
        page: await api<HistoryPage>(
          `/hosts/${host.id}/history?${new URLSearchParams({ provider, search: query, includeAutomation: String(automation), archived: String(archived), ...(more && cursors[host.id] ? { cursor: cursors[host.id]! } : {}) })}`,
          undefined,
          "GET",
        ),
      })),
    );
    if (generation.current !== current) return;
    const entries: HistoryThread[] = [],
      next: Record<string, string | null> = {},
      failed: Record<string, string> = {};
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        entries.push(...result.value.page.data);
        next[result.value.hostId] = result.value.page.nextCursor;
      } else {
        failed[targets[index].id] = String(
          result.reason?.message || result.reason,
        );
      }
    });
    setThreads((prev) =>
      [
        ...new Map(
          [...(more ? prev : []), ...entries].map((t) => [
            `${t.hostId}:${t.id}`,
            t,
          ]),
        ).values(),
      ].sort((a, b) => b.updatedAt - a.updatedAt),
    );
    setCursors((prev) => (more ? { ...prev, ...next } : next));
    setErrors((prev) => (more ? { ...prev, ...failed } : failed));
    setBusy(false);
    loadLock.current = false;
  }
  useEffect(() => {
    loadedKey.current = null;
    loadLock.current = false;
    setBusy(false);
    setThreads([]);
    setCursors({});
    setErrors({});
    readingGeneration.current++;
    setSelected(null);
    setDetail(null);
    setDetailError("");
    setReading(false);
    return () => {
      generation.current++;
    };
  }, [hostId, query, automation, archived, hostKey]);
  useEffect(() => {
    if (expanded && loadedKey.current !== queryKey) void load();
  }, [expanded, hostId, query, automation, archived, hostKey]);
  useEffect(
    () => () => {
      readingGeneration.current++;
    },
    [],
  );
  async function read(thread: HistoryThread, more = false) {
    const current = ++readingGeneration.current;
    setSelected(thread);
    setReading(true);
    setDetailError("");
    if (!more) setDetail(null);
    try {
      const result = await api<HistoryDetail>(
        `/hosts/${thread.hostId}/history/${thread.id}?${new URLSearchParams({ provider, ...(more && detail?.nextCursor ? { cursor: detail.nextCursor } : {}) })}`,
        undefined,
        "GET",
      );
      if (readingGeneration.current !== current) return;
      setDetail((prev) =>
        more && prev
          ? {
              ...result,
              items: [
                ...new Map(
                  [...result.items, ...prev.items].map((item) => [
                    item.id,
                    item,
                  ]),
                ).values(),
              ],
            }
          : result,
      );
    } catch (error) {
      if (readingGeneration.current === current)
        setDetailError((error as Error).message);
    } finally {
      if (readingGeneration.current === current) setReading(false);
    }
  }
  const selectedHost = hosts.find((h) => h.id === selected?.hostId);
  function closePreview() {
    readingGeneration.current++;
    setSelected(null);
    setDetail(null);
    setDetailError("");
    setReading(false);
  }
  return (
    <section
      className={`codex-history ${expanded ? "is-expanded" : "is-collapsed"}`}
      aria-label={`${label} 대화 기록`}
    >
      <header className="history-heading">
        <button
          className="history-toggle"
          aria-label={expanded ? "대화 기록 접기" : "대화 기록 펼치기"}
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronRight size={14} className="history-chevron" />
          <HistoryIcon size={14} />
          <b>{label} 대화 기록</b>
        </button>
        {expanded && (
          <button
            className="icon-button"
            aria-label="대화 기록 새로고침"
            disabled={busy}
            onClick={() => void load()}
          >
            <RefreshCw size={14} className={busy ? "spin" : ""} />
          </button>
        )}
      </header>
      <div className="history-content" id={contentId} hidden={!expanded}>
        <div className="history-filters">
          <div className="history-search">
            <Search size={16} />
            <input
              aria-label="대화 제목 검색"
              placeholder="대화 제목 검색"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            aria-label="대화 기록 서버"
            value={hostId}
            onChange={(e) => setHostId(e.target.value)}
          >
            <option value="all">모든 서버</option>
            {hosts.map((host) => (
              <option key={host.id} value={host.id}>
                {host.name}
              </option>
            ))}
          </select>
          {provider === "codex" && <details className="history-advanced">
            <summary>필터{automation || archived ? " · 적용 중" : ""}</summary>
            <div>
              <label>
                <input
                  type="checkbox"
                  checked={automation}
                  onChange={(e) => setAutomation(e.target.checked)}
                />
                자동화 기록 포함
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={archived}
                  onChange={(e) => setArchived(e.target.checked)}
                />
                보관된 대화
              </label>
            </div>
          </details>}
        </div>
        <div className="history-list" aria-label="모든 프로젝트 대화 목록">
          {Object.entries(errors).map(([id, error]) => (
            <div className="history-error" role="alert" key={id}>
              <b>{hosts.find((h) => h.id === id)?.name}</b>
              <p>{error}</p>
              <button
                onClick={() => {
                  const host = hosts.find((h) => h.id === id);
                  if (host) onConnect(host);
                }}
              >
                서버 설정
              </button>
            </div>
          ))}
          {threads.map((thread) => (
            <button
              className={`history-row ${selected?.id === thread.id && selected.hostId === thread.hostId ? "selected" : ""}`}
              key={`${thread.hostId}:${thread.id}`}
              draggable={!archived}
              title={
                archived
                  ? "보관된 대화"
                  : "터미널 영역으로 끌어 놓아 이어서 열기"
              }
              onDragStart={(event) => {
                if (archived) {
                  event.preventDefault();
                  return;
                }
                event.dataTransfer.effectAllowed = "copy";
                event.dataTransfer.setData(
                  "application/x-harbor-history",
                  JSON.stringify({
                    hostId: thread.hostId,
                    threadId: thread.id,
                    provider,
                  }),
                );
              }}
              onClick={() => void read(thread)}
            >
              <b>{thread.title}</b>
              <span className="history-row-folder" title={thread.cwd}>
                <Folder size={12} />
                <span>{thread.cwd || "폴더 정보 없음"}</span>
              </span>
              <span className="history-row-meta">
                <span>{hosts.find((h) => h.id === thread.hostId)?.name}</span>
                <time>
                  {new Date(thread.updatedAt).toLocaleDateString("ko-KR")}
                </time>
              </span>
            </button>
          ))}
          {busy && (
            <div className="history-loading">
              <LoaderCircle size={18} className="spin" />
              대화 기록을 불러오는 중…
            </div>
          )}
          {!busy && !threads.length && !Object.keys(errors).length && (
            <div className="history-empty">
              <HistoryIcon size={20} />
              <b>{query ? "검색 결과가 없습니다" : "저장된 대화가 없습니다"}</b>
              <p>모든 프로젝트의 {label} 대화가 표시됩니다.</p>
            </div>
          )}
          {Object.values(cursors).some(Boolean) && (
            <button
              className="button secondary history-more"
              disabled={busy}
              onClick={() => void load(true)}
            >
              이전 대화 더 보기
            </button>
          )}
        </div>
      </div>
      {selected &&
        createPortal(
          <div className="history-modal-root">
            <Modal
              title={selected.title}
              subtitle={`${selectedHost?.name || "서버"} · ${selected.cwd}`}
              onClose={closePreview}
              wide
            >
              <div className="history-preview">
                <div className="history-preview-actions">
                  <span>기록 미리보기</span>
                  <button
                    className="button primary"
                    disabled={reading || resuming || archived}
                    title={
                      archived
                        ? "보관된 대화는 Codex에서 보관을 해제한 후 이어갈 수 있습니다."
                        : "저장된 프로젝트 폴더에서 이 대화를 이어갑니다."
                    }
                    onClick={async () => {
                      setResuming(true);
                      setDetailError("");
                      try {
                        const terminal = await api<TerminalInfo>(
                          `/hosts/${selected.hostId}/history/${selected.id}/resume`,
                          { provider, colors: terminalColors(theme) },
                        );
                        closePreview();
                        onResume(terminal);
                      } catch (error) {
                        setDetailError((error as Error).message);
                      } finally {
                        setResuming(false);
                      }
                    }}
                  >
                    {resuming ? (
                      <LoaderCircle size={15} className="spin" />
                    ) : (
                      <Terminal size={15} />
                    )}
                    터미널에서 이어가기
                  </button>
                </div>
                <div className="history-transcript">
                  {detailError && (
                    <div className="history-error" role="alert">
                      {detailError}
                    </div>
                  )}
                  {detail?.nextCursor && (
                    <button
                      className="button secondary history-more"
                      disabled={reading}
                      onClick={() => void read(selected, true)}
                    >
                      이전 메시지 더 보기
                    </button>
                  )}
                  {reading && (
                    <div className="history-loading">
                      <LoaderCircle size={18} className="spin" />
                      대화를 읽는 중…
                    </div>
                  )}
                  {detail?.items.map((item, index) => (
                    <article
                      key={`${item.id}-${index}`}
                      className={`history-message ${item.kind}`}
                    >
                      <b>
                        {item.kind === "user"
                          ? "나"
                          : item.kind === "assistant"
                            ? label
                            : "기록"}
                      </b>
                      {item.imageCount && (
                        <small>이미지 {item.imageCount}개</small>
                      )}
                      <Markdown
                        text={item.text}
                        location={{
                          hostId: selected.hostId,
                          cwd: selected.cwd,
                        }}
                      />
                    </article>
                  ))}
                  {detail && !detail.items.length && !reading && (
                    <p className="history-no-messages">
                      표시할 대화 메시지가 없습니다.
                    </p>
                  )}
                </div>
                <footer>
                  {archived
                    ? "보관된 대화입니다. Codex에서 보관을 해제하면 이어갈 수 있습니다."
                    : "이어가기를 누르면 원래 프로젝트 폴더에서 이 대화를 엽니다."}
                </footer>
              </div>
            </Modal>
          </div>,
          document.body,
        )}
    </section>
  );
}
