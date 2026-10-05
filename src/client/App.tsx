import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Folder,
  PanelLeftClose,
  PanelLeftOpen,
  ExternalLink,
  MessageSquare,
  Plus,
  Server,
  Settings2,
  Terminal,
  X,
  Bell,
  Inbox,
} from "lucide-react";
import { useHarbor } from "./useHarbor";
import { api } from "./api";
import type { HostView, TerminalInfo } from "../shared/types";
import TerminalWorkspace, { NewTerminalDialog } from "./TerminalWorkspace";
import DirectoryTree from "./DirectoryTree";
import FilesBrowser from "./FilesBrowser";
import HostManager from "./HostManager";
import WorkspaceInbox, { type InboxTab } from "./WorkspaceInbox";
import ConnectionOverview, { connectionLabel } from "./ConnectionOverview";
import CodexHistory from "./CodexHistory";
import ServerTreeHost from "./ServerTreeHost";
import { useServerOrder } from "./server-order";
import {
  focusTerminalWindow,
  useDetachedTerminals,
  useTerminalSelection,
} from "./terminalWindows";
import RuntimeUpdateNotice from "./RuntimeUpdateNotice";
import { PreviewProvider } from "./ResourcePreview";
import { useNotifications } from "./Notifications";
import { useTheme, terminalColors, type ThemeName } from "./Theme";
import "./harbor.css";
import "./workspace-inbox.css";
import "./workspace-layout.css";

const noSessions: string[] = [];
const popoutId = new URLSearchParams(location.search).get("terminal");
const initialFocusId = new URLSearchParams(location.search).get("focus");
type HistoryDrop = {
  provider?: "codex" | "claude";
  hostId: string;
  threadId: string;
  targetTerminalId?: string;
  slot?: unknown;
};
export default function App() {
  const [error, setError] = useState("");
  const onError = useCallback((message: string) => setError(message), []);
  const {
    state,
    connected,
    ready,
    credentialStorageAvailable,
    terminalColorsSupported,
    terminalInputOptimized,
    terminalReplayState,
    claudeIntegration,
  } = useHarbor(noSessions, onError);
  const { hosts: orderedHosts, moveHost, moveBy } = useServerOrder(state.hosts);
  const { theme, setTheme } = useTheme();
  const { notices, push, read, sync } = useNotifications();
  const [page, setPage] = useState<"hosts" | "terminals" | "files">(
    "terminals",
  );
  const [activeId, setActiveId] = useState(() => {
    if (popoutId || initialFocusId) return popoutId || initialFocusId || "";
    try { return sessionStorage.getItem("harbor.activeTerminal") || ""; }
    catch { return ""; }
  });
  const startupDone = useRef(false);
  const focusRequest = useRef(0);
  const hostTerminals = useRef(new Map<string, string>());
  const pendingSelection = useRef<string | null>(null);
  const [hostId, setHostId] = useState("");
  const [sidebar, setSidebar] = useState<"servers" | "files" | "activity">(
    "servers",
  );
  const [inboxTab, setInboxTab] = useState<InboxTab>("requests");
  const [sidebarVisible, setSidebarVisible] = useState(!popoutId);
  const [query, setQuery] = useState("");
  const [editorId, setEditorId] = useState<string | null>(null);
  const [newTerminal, setNewTerminal] = useState<{
    hostId?: string;
    cwd?: string;
  } | null>(null);
  const [filePath, setFilePath] = useState("");
  const [messageId, setMessageId] = useState<string | null>(null);
  const [opening, setOpening] = useState("");
  const historyOpening = useRef(new Set<string>());
  const [historyPlacements, setHistoryPlacements] = useState<
    Array<{ terminalId: string; targetTerminalId?: string; slot?: unknown }>
  >([]);
  const active = state.terminals.find((item) => item.id === activeId);
  const detached = useDetachedTerminals();
  useEffect(() => {
    if (!ready || startupDone.current) return;
    startupDone.current = true;
    if (popoutId) return;
    const available = state.terminals.filter(t => !t.exited && !detached.includes(t.id));
    const selected = available.find(t => t.id === activeId) || available[0];
    if (selected) void focus(selected.id);
    else if (!state.terminals.some(t => !t.exited)) {
      const local = state.hosts.find(h => h.kind === "local");
      if (local) void connect(local);
    }
  }, [ready, state.terminals, state.hosts, detached]);
  useEffect(() => {
    if (active) {
      hostTerminals.current.set(active.hostId, active.id);
      if (!popoutId) {
        try { sessionStorage.setItem("harbor.activeTerminal", active.id); } catch {}
      }
    }
  }, [active?.id, active?.hostId]);
  useTerminalSelection((id) => {
    if (popoutId) {
      if (id === popoutId) activateTerminalInput(id, ++focusRequest.current);
      return;
    }
    if (state.terminals.some((terminal) => terminal.id === id)) void focus(id);
    else {
      ++focusRequest.current;
      pendingSelection.current = id;
    }
  });
  useEffect(() => {
    const id = pendingSelection.current;
    if (id && state.terminals.some((terminal) => terminal.id === id)) {
      pendingSelection.current = null;
      void focus(id);
    }
  }, [state.terminals]);
  const host =
    state.hosts.find((item) => item.id === (hostId || active?.hostId)) ||
    state.hosts[0];
  const messages = state.mailbox || [];
  const seenMessages = useRef(new Set<string>());
  const initializedMessages = useRef(false);
  const seenRequests = useRef(new Set<string>());
  const requestCount = (state.requests || []).filter(
    (request) => request.status === "pending",
  ).length;
  const unreadCount = notices.filter((notice) => !notice.read).length;
  useEffect(() => {
    if (state.notices) sync(state.notices);
  }, [state.notices, sync]);
  useEffect(() => {
    if (!ready) return;
    for (const request of state.requests || []) {
      if (
        !seenRequests.current.has(request.id) &&
        request.status === "pending" &&
        (!popoutId || request.terminal.terminalId === popoutId)
      ) {
        setSidebar("activity");
        setInboxTab("requests");
        setSidebarVisible(true);
      }
      seenRequests.current.add(request.id);
    }
  }, [ready, state.requests]);
  function openInbox(tab: InboxTab, id?: string) {
    setSidebar("activity");
    setInboxTab(tab);
    if (id) setMessageId(id);
    setSidebarVisible(true);
  }
  useEffect(() => {
    const preventNavigation = (event: DragEvent) => {
      if (
        event.dataTransfer?.types.some(
          (type) =>
            type === "Files" ||
            type === "application/x-harbor-file" ||
            type === "application/x-harbor-history",
        )
      )
        event.preventDefault();
    };
    window.addEventListener("dragover", preventNavigation);
    window.addEventListener("drop", preventNavigation);
    return () => {
      window.removeEventListener("dragover", preventNavigation);
      window.removeEventListener("drop", preventNavigation);
    };
  }, []);
  useEffect(() => {
    const drop = (event: Event) => {
      const detail = (event as CustomEvent<HistoryDrop>).detail;
      if (
        !detail ||
        typeof detail.hostId !== "string" ||
        typeof detail.threadId !== "string" ||
        !detail.threadId ||
        !state.hosts.some((item) => item.id === detail.hostId)
      )
        return;
      const key = `${detail.provider || "codex"}:${detail.hostId}:${detail.threadId}`;
      if (historyOpening.current.has(key)) return;
      historyOpening.current.add(key);
      setError("");
      void (async () => {
        try {
          const terminal = await api<TerminalInfo>(
            `/hosts/${encodeURIComponent(detail.hostId)}/history/${encodeURIComponent(detail.threadId)}/resume`,
            { provider: detail.provider || "codex", colors: terminalColors(theme) },
          );
          if (!popoutId && !detached.includes(terminal.id)) {
            // Placement owns focus: changing activeId first would replace the
            // currently focused pane before the requested drop target is known.
            setPage("terminals");
            setHistoryPlacements((current) => [
              ...current,
              {
                terminalId: terminal.id,
                targetTerminalId: detail.targetTerminalId,
                slot: detail.slot,
              },
            ]);
          } else await created(terminal);
        } catch (error) {
          setError((error as Error).message);
        } finally {
          historyOpening.current.delete(key);
        }
      })();
    };
    window.addEventListener("harbor-history-drop", drop);
    return () => window.removeEventListener("harbor-history-drop", drop);
  }, [state.hosts, state.terminals, theme, detached]);
  useEffect(() => {
    if (page !== "terminals" || !historyPlacements.length) return;
    const available = historyPlacements.filter((placement) =>
      state.terminals.some((terminal) => terminal.id === placement.terminalId),
    );
    if (!available.length) return;
    const frame = requestAnimationFrame(() => {
      for (const detail of available)
        window.dispatchEvent(
          new CustomEvent("harbor-terminal-place", { detail }),
        );
      setHistoryPlacements((current) =>
        current.filter((item) => !available.includes(item)),
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [page, historyPlacements, state.terminals]);
  useEffect(() => {
    if (!ready) return;
    for (const message of messages) {
      if (
        !seenMessages.current.has(message.id) &&
        initializedMessages.current
      ) {
        const targetId =
          message.recipient.terminalId || message.sender.terminalId;
        if (targetId)
          push({
            id: `mail-${message.id}`,
            target: "terminal",
            targetId,
            title: `${message.sender.title} → ${message.recipient.title}`,
            body: message.text.slice(0, 200),
          });
      }
      seenMessages.current.add(message.id);
    }
    initializedMessages.current = true;
  }, [messages, ready, push]);
  async function focus(id: string) {
    pendingSelection.current = null;
    const request = ++focusRequest.current;
    const terminal = state.terminals.find((item) => item.id === id);
    if (terminal) hostTerminals.current.set(terminal.hostId, id);
    if (popoutId && id !== popoutId) {
      const moved = await focusTerminalWindow(id).catch(() => false);
      if (request !== focusRequest.current) return;
      if (!moved)
        setError(
          "이 창은 분리한 세션 전용입니다. Harbor 기본 창에서 해당 세션을 선택하세요. 최신 창 연결 기능은 앱을 완전히 종료한 뒤 다시 열면 적용됩니다.",
        );
      else read(id);
      return;
    }
    if (popoutId) void focusTerminalWindow(id).catch(() => false);
    // Attached panes switch synchronously. An older desktop IPC reply must
    // never replace the user's newer selection.
    if (!popoutId && detached.includes(id)) {
      const moved = await focusTerminalWindow(id).catch(() => false);
      if (request !== focusRequest.current) return;
      if (moved) {
        read(id);
        return;
      }
    }
    setActiveId(id);
    setPage("terminals");
    if (terminal) {
      setHostId(terminal.hostId);
      setFilePath(terminal.cwd);
    }
    read(id);
    activateTerminalInput(id, request);
  }
  function activateTerminalInput(id: string, request: number) {
    requestAnimationFrame(() => {
      if (
        request !== focusRequest.current ||
        document.querySelector('[role="dialog"]')
      )
        return;
      const input = document.querySelector<HTMLTextAreaElement>(
        `[data-terminal-id="${CSS.escape(id)}"] .xterm-helper-textarea`,
      );
      if (input?.getClientRects().length) input.focus({ preventScroll: true });
    });
  }
  async function created(terminal: TerminalInfo) {
    pendingSelection.current = null;
    const request = ++focusRequest.current;
    hostTerminals.current.set(terminal.hostId, terminal.id);
    if (popoutId && terminal.id !== popoutId) {
      const moved = await focusTerminalWindow(terminal.id).catch(() => false);
      if (request !== focusRequest.current) return;
      if (!moved)
        setError(
          "새 세션을 만들었습니다. Harbor 기본 창에서 해당 세션을 선택하세요. 이 창은 분리한 세션을 그대로 표시합니다.",
        );
      return;
    }
    if (!popoutId && detached.includes(terminal.id)) {
      const moved = await focusTerminalWindow(terminal.id).catch(() => false);
      if (request !== focusRequest.current || moved) return;
    }
    setActiveId(terminal.id);
    setHostId(terminal.hostId);
    setFilePath(terminal.cwd);
    setPage("terminals");
    setSidebar("servers");
    setEditorId(null);
    activateTerminalInput(terminal.id, request);
  }
  function selectHost(id: string) {
    pendingSelection.current = null;
    ++focusRequest.current;
    const candidates = state.terminals.filter(
      (terminal) => terminal.hostId === id && !terminal.exited,
    );
    const remembered = candidates.find(
      (terminal) => terminal.id === hostTerminals.current.get(id),
    );
    const selected = remembered || candidates.at(-1);
    if (
      page === "terminals" &&
      popoutId &&
      selected &&
      selected.id !== popoutId
    ) {
      void focus(selected.id);
      return;
    }
    setHostId(id);
    setFilePath("");
    if (page !== "terminals") return;
    if (selected) void focus(selected.id);
    else if (!popoutId) setNewTerminal({ hostId: id });
  }
  async function connect(target: HostView) {
    if (opening) return;
    setOpening(target.id);
    setError("");
    try {
      created(
        await api<TerminalInfo>("/terminals", {
          hostId: target.id,
          cwd: target.defaultCwd,
          program: "shell",
          colors: terminalColors(theme),
        }),
      );
    } catch (err) {
      setError((err as Error).message);
      if (target.kind === "ssh") {
        setHostId(target.id);
        setEditorId(target.id);
        setPage("hosts");
      }
    } finally {
      setOpening("");
    }
  }
  function files(id: string, cwd: string, full = false) {
    pendingSelection.current = null;
    ++focusRequest.current;
    setHostId(id);
    setFilePath(cwd);
    setSidebar("files");
    setSidebarVisible(true);
    if (full) setPage("files");
  }
  function navigate(next: "hosts" | "terminals" | "files") {
    pendingSelection.current = null;
    ++focusRequest.current;
    setPage(next);
  }
  const pending = (id: string) =>
    notices.filter((n) => n.targetId === id && !n.read).length;
  return (
    <PreviewProvider
      hosts={orderedHosts}
      onFolder={(id, cwd) => files(id, cwd, true)}
    >
      <div
        className={`harbor-app ${popoutId ? "is-popout" : ""} ${page === "terminals" ? "terminal-view" : ""}`}
      >
        {sidebarVisible && (
          <aside
            className={`harbor-sidebar ${sidebar === "activity" ? "with-inbox" : ""}`}
          >
            <button className="harbor-brand" onClick={() => navigate("terminals")}>
              <img src="/harbor.svg" alt="" />
              <b>Harbor</b>
              <span>workspace</span>
            </button>
            <div className="harbor-side-switch">
              <button
                className={sidebar === "servers" ? "active" : ""}
                onClick={() => setSidebar("servers")}
              >
                <Server size={15} />
                서버
              </button>
              <button
                className={sidebar === "files" ? "active" : ""}
                onClick={() => setSidebar("files")}
              >
                <Folder size={15} />
                파일
              </button>
              <button
                className={sidebar === "activity" ? "active" : ""}
                onClick={() => openInbox(requestCount ? "requests" : inboxTab)}
                aria-label={`받은함 ${requestCount}개 요청`}
              >
                <Inbox size={15} />
                받은함
                {requestCount > 0 && (
                  <b className="harbor-count">{requestCount}</b>
                )}
              </button>
            </div>
            {sidebar !== "activity" && (
              <ConnectionOverview
                state={state}
                terminal={active}
                onMessages={() =>
                  openInbox("messages", active?.id || "__all__")
                }
              />
            )}
            {sidebar !== "activity" && requestCount > 0 && (
              <button
                className="sidebar-pending"
                onClick={() => openInbox("requests")}
              >
                <Inbox size={14} />
                {requestCount}개 요청이 답변을 기다립니다
                <ArrowLeft size={13} />
              </button>
            )}
            {sidebar === "servers" ? (
              <>
                <div className="harbor-side-label">
                  <span>내 서버</span>
                  <button
                    className="icon-button compact"
                    aria-label="서버 추가"
                    onClick={() => {
                      setEditorId("new");
                      setPage("hosts");
                    }}
                  >
                    <Plus size={15} />
                  </button>
                </div>
                <div className="harbor-host-tree">
                  {orderedHosts.map((item) => (
                    <div key={item.id}>
                      <ServerTreeHost
                        host={item}
                        selected={host?.id === item.id}
                        opening={!!opening}
                        onSelect={() => selectHost(item.id)}
                        onConnect={() => void connect(item)}
                        onMove={moveHost}
                        onMoveBy={moveBy}
                      />
                      {state.terminals
                        .filter((t) => t.hostId === item.id)
                        .map((terminal) => (
                          <button
                            key={terminal.id}
                            className={`harbor-session-row ${activeId === terminal.id && page === "terminals" ? "active" : ""}`}
                            onClick={() => focus(terminal.id)}
                          >
                            <Terminal size={13} />
                            <span>{terminal.title}</span>
                            {pending(terminal.id) > 0 ? (
                              <b className="harbor-count">
                                {pending(terminal.id)}
                              </b>
                            ) : detached.includes(terminal.id) ? (
                              <ExternalLink
                                size={12}
                                aria-label="별도 창에서 열림"
                              />
                            ) : (
                              <small>{connectionLabel(terminal)}</small>
                            )}
                          </button>
                        ))}
                    </div>
                  ))}
                </div>
                <CodexHistory
                  hosts={orderedHosts}
                  initialHostId={host?.id}
                  onResume={created}
                  onConnect={(h) => {
                    setHostId(h.id);
                    setEditorId(h.id);
                    setPage("hosts");
                  }}
                />
                {claudeIntegration ? <CodexHistory
                  provider="claude"
                  hosts={orderedHosts}
                  initialHostId={host?.id}
                  onResume={created}
                  onConnect={(h) => {
                    setHostId(h.id);
                    setEditorId(h.id);
                    setPage("hosts");
                  }}
                />
                : <p className="history-error">Claude 연동은 작업을 마친 뒤 Harbor를 완전히 재실행하면 사용할 수 있습니다.</p>}
                <div className="harbor-side-bottom">
                  <button
                    onClick={() => {
                      setEditorId(host?.id || null);
                      setPage("hosts");
                    }}
                  >
                    <Settings2 size={15} />
                    서버 관리
                  </button>
                </div>
              </>
            ) : sidebar === "files" ? (
              <>
                <div className="harbor-explorer-host">
                  <select
                    aria-label="탐색할 서버"
                    value={host?.id || ""}
                    onChange={(e) => {
                      setHostId(e.target.value);
                      setFilePath("");
                    }}
                  >
                    {orderedHosts.map((h) => (
                      <option value={h.id} key={h.id}>
                        {h.name}
                      </option>
                    ))}
                  </select>
                </div>
                <DirectoryTree
                  key={`${host?.id}-${filePath}`}
                  host={host}
                  initialPath={filePath || host?.defaultCwd}
                  onTerminal={(id, cwd) => setNewTerminal({ hostId: id, cwd })}
                  onBrowse={(id, cwd) => files(id, cwd, true)}
                  onConnect={(h) => {
                    setHostId(h.id);
                    setEditorId(h.id);
                    setPage("hosts");
                  }}
                />
              </>
            ) : (
              <WorkspaceInbox
                state={state}
                tab={inboxTab}
                onTab={setInboxTab}
                terminalId={messageId || active?.id || "__all__"}
                onOpen={focus}
                onError={onError}
                onClose={() => {
                  setSidebar("servers");
                  if (popoutId) setSidebarVisible(false);
                }}
              />
            )}
            <button
              className="sidebar-collapse"
              onClick={() => setSidebarVisible(false)}
            >
              <PanelLeftClose size={14} /> 왼쪽 패널 접기
            </button>
          </aside>
        )}
        <div className="harbor-main">
          <header className="harbor-topbar">
            <button
              className="icon-button sidebar-toggle"
              aria-label={sidebarVisible ? "사이드바 접기" : "사이드바 펼치기"}
              title={
                sidebarVisible
                  ? "사이드바 접기 · 터미널 넓게 보기"
                  : "서버 · 파일 · 받은함 열기"
              }
              aria-expanded={sidebarVisible}
              onClick={() => setSidebarVisible((value) => !value)}
            >
              {sidebarVisible ? (
                <PanelLeftClose size={17} />
              ) : (
                <PanelLeftOpen size={17} />
              )}
            </button>
            {popoutId ? (
              <a href="/" target="_blank" className="harbor-back">
                <ArrowLeft size={16} />
                Harbor
              </a>
            ) : (
              <div className="harbor-breadcrumb">
                <span>
                  {page === "hosts"
                    ? "내 서버"
                    : (page === "terminals"
                        ? state.hosts.find((h) => h.id === active?.hostId)?.name
                        : host?.name) ||
                      host?.name ||
                      "워크스페이스"}
                </span>
                {page !== "hosts" && (
                  <>
                    <span>/</span>
                    <b>
                      {page === "files" ? "파일" : active?.title || "터미널"}
                    </b>
                  </>
                )}
              </div>
            )}
            <div className="harbor-top-actions">
              <RuntimeUpdateNotice
                ready={ready}
                optimized={terminalInputOptimized && terminalReplayState}
              />
              <span
                className={`harbor-service ${connected ? "connected" : ""}`}
                title={connected ? "Harbor 연결됨" : "Harbor 다시 연결 중"}
              >
                <i />
              </span>
              <select
                aria-label="테마"
                value={theme}
                onChange={(e) => setTheme(e.target.value as ThemeName)}
              >
                <option value="light">라이트</option>
                <option value="dark">다크</option>
                <option value="paper">페이퍼</option>
              </select>
              <button
                className="icon-button"
                aria-label="메시지 기록"
                title="세션 메시지 기록"
                onClick={() => openInbox("messages", active?.id || "__all__")}
              >
                <MessageSquare size={17} />
              </button>
              <button
                className={`icon-button sidebar-alert-button ${unreadCount || requestCount ? "has-unread" : ""}`}
                aria-label={`알림 ${unreadCount}개`}
                title="왼쪽 받은함 열기"
                onClick={() =>
                  openInbox(requestCount ? "requests" : "notifications")
                }
              >
                <Bell size={17} />
                {unreadCount + requestCount > 0 && (
                  <b>{unreadCount + requestCount}</b>
                )}
              </button>
              {!popoutId && (
                <button
                  className="button primary"
                  disabled={!ready}
                  onClick={() => setNewTerminal({ hostId: host?.id })}
                >
                  <Plus size={15} />새 터미널
                </button>
              )}
            </div>
          </header>
          {error && (
            <div className="harbor-error" role="alert">
              <span>{error}</span>
              <button aria-label="오류 닫기" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          <div className="harbor-content">
            <div className="harbor-page">
              {page === "hosts" && (
                <HostManager
                  hosts={orderedHosts}
                  onMoveHost={moveHost}
                  onMoveHostBy={moveBy}
                  selectedId={host?.id}
                  editorId={editorId}
                  setEditorId={setEditorId}
                  onSelect={setHostId}
                  onConnect={connect}
                  onCreated={created}
                  ready={ready}
                  opening={opening}
                  credentialStorageAvailable={credentialStorageAvailable}
                  query={query}
                  setQuery={setQuery}
                />
              )}
              <TerminalWorkspace
                terminals={state.terminals}
                hosts={orderedHosts}
                activeId={activeId}
                visible={page === "terminals"}
                popoutId={popoutId}
                ready={ready}
                onFocus={focus}
                terminalColorsSupported={terminalColorsSupported}
                onNew={(id, cwd) => setNewTerminal({ hostId: id, cwd })}
                onFiles={(id, cwd) => files(id, cwd)}
                onError={onError}
                onMessages={(id) => openInbox("messages", id)}
              />
              {page === "files" && (
                <FilesBrowser
                  key={`${host?.id}-${filePath}`}
                  hosts={orderedHosts}
                  initialHostId={host?.id}
                  initialPath={filePath}
                  onTerminal={(h, cwd) => setNewTerminal({ hostId: h.id, cwd })}
                  onConnect={(h) => {
                    setHostId(h.id);
                    setEditorId(h.id);
                    setPage("hosts");
                  }}
                />
              )}
            </div>
          </div>
          <footer className="harbor-statusbar">
            <span>
              {state.terminals.filter((t) => !t.exited).length}개 터미널 ·{" "}
              {
                state.terminals.filter((t) => t.agentConnected && !t.exited)
                  .length
              }
              개 AI 연결
            </span>
            <span>Ctrl+클릭 링크 열기 · 이미지 붙여넣기</span>
          </footer>
        </div>
        {newTerminal && (
          <NewTerminalDialog
            claudeIntegration={claudeIntegration}
            hosts={orderedHosts}
            initialHostId={newTerminal.hostId}
            initialCwd={newTerminal.cwd}
            onClose={() => setNewTerminal(null)}
            onCreated={created}
            credentialStorageAvailable={credentialStorageAvailable}
          />
        )}
      </div>
    </PreviewProvider>
  );
}
