import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  Columns2,
  ExternalLink,
  Folder,
  Globe2,
  HardDrive,
  LayoutDashboard,
  LoaderCircle,
  Plus,
  Pencil,
  MessageSquare,
  Square,
  Terminal,
  X,
} from "lucide-react";
import type { HostView, TerminalInfo } from "../shared/types";
import { api } from "./api";
import { Modal } from "./Dialogs";
import TerminalPane from "./TerminalPane";
import TerminalAutoApproval from "./TerminalAutoApproval";
import { useNotifications } from "./Notifications";
import { useTheme, terminalColors } from "./Theme";
import {
  useDetachedTerminals,
  useTabDetach,
  focusTerminalWindow,
} from "./terminalWindows";
import "./terminal-windows.css";
import "./terminal-layout.css";
import {
  decodeTree,
  paneIds,
  placeInTree,
  presetTree,
  reconcileTree,
  resizeTree,
  splitJunctions,
  treeRects,
  type TerminalTree,
  type TerminalPlacement,
  type DropEdge,
  type DropScope,
  type PaneRect,
} from "./terminal-tree";
import TerminalSplitHandle from "./TerminalSplitHandle";
import type { DragEvent } from "react";

export function terminalLabel(info: TerminalInfo, _terminals?: TerminalInfo[]) {
  return info.title;
}

export function NewTerminalDialog({
  claudeIntegration = false,
  hosts,
  initialHostId,
  onClose,
  onCreated,
  credentialStorageAvailable,
}: {
  claudeIntegration?: boolean;
  hosts: HostView[];
  initialHostId?: string;
  initialCwd?: string;
  onClose: () => void;
  onCreated: (terminal: TerminalInfo) => void;
  credentialStorageAvailable: boolean;
}) {
  const { theme } = useTheme();
  const [hostId, setHostId] = useState(
    initialHostId || hosts[0]?.id || "local",
  );
  const host = hosts.find((h) => h.id === hostId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [password, setPassword] = useState("");
  const [savePassword, setSavePassword] = useState(credentialStorageAvailable);
  const [autoApprove, setAutoApprove] = useState(false);
  const [sshSessionMode, setSshSessionMode] = useState<"direct" | "tmux">(
    "direct",
  );
  const [launch, setLaunch] = useState<
    "shell" | "codex" | "resume" | "claude" | "claude-resume"
  >("shell");
  return (
    <Modal
      title="새 터미널"
      subtitle="서버를 고르면 홈 디렉터리(~)에서 터미널을 시작합니다."
      backdropClassName="new-terminal-dialog"
      onClose={onClose}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            const terminal = await api<TerminalInfo>("/terminals", {
              hostId,
              title: title || undefined,
              program: launch,
              autoApprove,
              sshSessionMode: host?.kind === "ssh" ? sshSessionMode : undefined,
              password: password || undefined,
              savePassword: savePassword && credentialStorageAvailable,
              colors: terminalColors(theme),
            });
            onCreated(terminal);
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
              aria-label="세션 이름"
              placeholder="예: 프론트엔드, 백엔드, 리뷰"
              maxLength={100}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <small>다른 Codex에서 이 이름으로 메시지를 보낼 수 있습니다.</small>
          </label>
          <label className="field">
            서버
            <select
              aria-label="서버"
              value={hostId}
              onChange={(event) => {
                setHostId(event.target.value);
                setPassword("");
                setSshSessionMode("direct");
                setAutoApprove(false);
              }}
            >
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name} · {h.kind === "local" ? "로컬" : h.address}
                </option>
              ))}
            </select>
          </label>
          {host?.kind === "ssh" && (
            <label className="field">
              SSH 세션 방식
              <select
                aria-label="SSH 세션 방식"
                aria-describedby="ssh-session-mode-help"
                value={sshSessionMode}
                disabled={busy}
                onChange={(event) =>
                  setSshSessionMode(event.target.value as "direct" | "tmux")
                }
              >
                <option value="direct">일반 SSH (기본)</option>
                <option value="tmux">서버에서 세션 유지 (tmux)</option>
              </select>
              <small id="ssh-session-mode-help">
                {sshSessionMode === "tmux"
                  ? "Harbor를 종료해도 서버 작업을 유지하고 재실행 시 다시 연결합니다. 터미널 탭의 X → 터미널 종료는 서버 작업도 종료합니다. 서버에 tmux와 bash가 필요합니다."
                  : "tmux 없이 연결합니다. SSH 연결이나 Harbor가 종료되면 원격 작업도 종료될 수 있습니다."}
              </small>
            </label>
          )}
          {host?.kind === "ssh" && (
            <label className="field">
              SSH 비밀번호
              <input
                aria-label="SSH 비밀번호"
                type="password"
                autoComplete="new-password"
                placeholder={
                  host.hasSavedPassword
                    ? "저장된 비밀번호 사용"
                    : "키 인증은 비워두세요"
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {credentialStorageAvailable && (
                <span className="host-check">
                  <input
                    type="checkbox"
                    checked={savePassword}
                    onChange={(e) => setSavePassword(e.target.checked)}
                  />
                  이 컴퓨터에 로그인 저장
                </span>
              )}
            </label>
          )}
          <label className="field">
            시작 폴더
            <input
              aria-label="시작 폴더"
              value="~ (홈 디렉터리)"
              readOnly
              autoComplete="off"
              spellCheck={false}
            />
            <small>
              항상 해당 계정의 홈에서 시작합니다. 이후 cd 명령으로 이동하세요.
            </small>
          </label>
          <label className="field">
            시작할 프로그램
            <select
              aria-label="시작할 프로그램"
              value={launch}
              onChange={(event) =>
                setLaunch(event.target.value as typeof launch)
              }
            >
              <option value="shell">터미널 셸</option>
              <option value="codex">Codex · 새 대화</option>
              {claudeIntegration && (
                <option value="claude">Claude · 새 대화</option>
              )}
              {claudeIntegration && (
                <option value="claude-resume">
                  Claude · 대화 선택해 이어가기
                </option>
              )}
              <option value="resume">Codex · 이전 대화 이어하기</option>
            </select>
            <small>
              {launch === "shell"
                ? "셸에서 원하는 명령을 직접 실행합니다."
                : "선택한 CLI를 실행하고 작업 상태와 알림을 연결합니다."}
            </small>
          </label>
          <label className="field">
            <span className="host-check">
              <input
                type="checkbox"
                checked={autoApprove}
                disabled={busy}
                onChange={(event) => setAutoApprove(event.target.checked)}
              />
              이 세션의 실행 승인 요청을 Harbor가 자동 수락
            </span>
            {autoApprove && (
              <small>
                명령 실행·파일 삭제도 자동 허용합니다. 다른 세션과 일반 질문에는
                적용하지 않습니다.
              </small>
            )}
          </label>
          <div className="terminal-start-guide">
            <Terminal size={17} />
            <div>
              <b>익숙한 셸에서 시작합니다</b>
              <p>
                <code>cd</code>로 이동하고 <code>codex</code>를 실행하세요. 이전
                대화는 <code>codex resume</code>으로 이어갈 수 있습니다.
              </p>
              {host?.kind === "ssh" && (
                <p>
                  저장된 로그인 정보로 접속합니다. 같은 서버에도 여러 세션을 열
                  수 있습니다.
                </p>
              )}
            </div>
          </div>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            취소
          </button>
          <button className="button primary" disabled={busy || !host}>
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Terminal size={16} />
            )}
            {busy ? "연결 중…" : "터미널 열기"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function savedTree(): TerminalTree {
  try {
    const tree = decodeTree(
      JSON.parse(localStorage.getItem("harbor.terminalTree") || "null"),
    );
    if (tree) return tree;
    const legacy = JSON.parse(
      localStorage.getItem("harbor.terminalPanes") || "null",
    );
    if (Array.isArray(legacy?.ids)) {
      const ids = legacy.ids
        .filter((id: unknown): id is string => typeof id === "string")
        .slice(0, 4);
      return presetTree(ids, legacy.focusedId || "");
    }
  } catch {}
  return { tree: null, focusedId: "" };
}

export default function TerminalWorkspace({
  terminals,
  hosts,
  activeId,
  visible,
  popoutId,
  ready,
  terminalColorsSupported = false,
  onFocus,
  onCloseTerminal,
  onNew,
  onFiles,
  onError,
  onMessages,
}: {
  terminals: TerminalInfo[];
  hosts: HostView[];
  activeId: string;
  visible: boolean;
  popoutId: string | null;
  ready: boolean;
  terminalColorsSupported?: boolean;
  onFocus: (id: string) => void;
  onCloseTerminal: (terminal: TerminalInfo) => void;
  onNew: (hostId?: string, cwd?: string) => void;
  onFiles: (hostId: string, cwd: string) => void;
  onError: (message: string) => void;
  onMessages: (id: string) => void;
}) {
  const [panes, setPanes] = useState<TerminalTree>(savedTree);
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridSize, setGridSize] = useState({ width: 0, height: 0 });
  const [resizing, setResizing] = useState(false);
  const [dropTarget, setDropTarget] = useState<{
    edge: DropEdge;
    scope: DropScope;
    targetTerminalId?: string;
    rect: PaneRect;
  } | null>(null);
  const [placements, setPlacements] = useState<TerminalPlacement[]>([]);
  const placement = placements[0];
  const [renaming, setRenaming] = useState<TerminalInfo | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const { notices, read } = useNotifications();
  const detachedIds = useDetachedTerminals();
  const {
    draggingId,
    startDrag,
    endDrag,
    open: openWindow,
  } = useTabDetach(onError);
  const attachedTerminals = popoutId
    ? terminals
    : terminals.filter((t) => !detachedIds.includes(t.id));
  const pending = (id: string) =>
    notices.find(
      (n) => n.target === "terminal" && n.targetId === id && !n.read,
    );
  const current = attachedTerminals.find(
    (t) => t.id === (popoutId || activeId),
  );
  const resolvedPanes = popoutId
    ? presetTree(
        terminals.some((t) => t.id === popoutId) ? [popoutId] : [],
        popoutId,
      )
    : reconcileTree(
        panes,
        attachedTerminals.map((t) => t.id),
        activeId,
      );
  const paneKey = JSON.stringify(resolvedPanes);
  useLayoutEffect(() => {
    if (!popoutId && ready && JSON.stringify(panes) !== paneKey)
      setPanes(resolvedPanes);
  }, [paneKey, popoutId, ready]);
  useEffect(() => {
    if (!popoutId && ready) {
      try {
        localStorage.setItem("harbor.terminalTree", paneKey);
      } catch {}
    }
  }, [paneKey, popoutId, ready]);
  const shownIds = paneIds(resolvedPanes.tree);
  const focusId = current?.id || resolvedPanes.focusedId || shownIds[0];
  const shown = terminals.filter((t) => shownIds.includes(t.id));
  const displayTerminals = popoutId
    ? terminals.filter((t) => t.id === popoutId)
    : attachedTerminals;
  const hasGrid = displayTerminals.length > 0;
  useEffect(() => {
    const element = gridRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setGridSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasGrid]);
  const geometry = treeRects(
    resolvedPanes.tree,
    gridSize.width,
    gridSize.height,
  );
  const junctions = splitJunctions(geometry.dividers);
  const layout = Math.min(shownIds.length || 1, 4);
  function changeRatios(ratios: Record<string, number>) {
    setPanes((previous) => ({
      ...previous,
      tree: resizeTree(previous.tree, ratios),
    }));
  }
  function chooseLayout(count: number) {
    const ids =
      count === 1
        ? [focusId]
        : [
            ...new Set([...shownIds, ...displayTerminals.map((t) => t.id)]),
          ].slice(0, count);
    setPanes(presetTree(ids.filter(Boolean), focusId));
  }
  useEffect(() => {
    if (popoutId) return;
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<TerminalPlacement>).detail;
      if (typeof detail?.terminalId === "string")
        setPlacements((previous) => [...previous, detail]);
    };
    window.addEventListener("harbor-terminal-place", receive);
    return () => window.removeEventListener("harbor-terminal-place", receive);
  }, [popoutId]);
  useEffect(() => {
    if (
      !placement ||
      !attachedTerminals.some((t) => t.id === placement.terminalId)
    )
      return;
    if (placement.pairTerminalIds?.length === 2) {
      if (
        !placement.pairTerminalIds.every((id) =>
          attachedTerminals.some((t) => t.id === id),
        )
      )
        return;
      setPanes(presetTree(placement.pairTerminalIds, placement.terminalId));
    } else {
      let previous = resolvedPanes;
      if (placement.layout === 1)
        previous = presetTree([placement.terminalId], placement.terminalId);
      if (placement.layout === 2) {
        const ids = [...new Set([...shownIds, placement.terminalId])].slice(
          0,
          2,
        );
        previous = presetTree(ids, focusId);
      }
      const target =
        placement.targetTerminalId ||
        (placement.slot === undefined
          ? previous.focusedId
          : paneIds(previous.tree)[placement.slot]);
      setPanes(
        placeInTree(
          previous,
          placement.terminalId,
          target,
          placement.edge,
          placement.scope,
        ),
      );
    }
    onFocus(placement.terminalId);
    setPlacements((previous) => previous.slice(1));
  }, [placement, paneKey, terminals]);
  function acceptsDrop(event: DragEvent) {
    return (
      !popoutId &&
      (event.dataTransfer.types.includes("application/x-harbor-history") ||
        event.dataTransfer.types.includes("application/x-harbor-terminal-tab"))
    );
  }
  function dropLocation(event: DragEvent, targetTerminalId?: string) {
    const grid = gridRef.current?.getBoundingClientRect();
    const rect = targetTerminalId
      ? geometry.panes[targetTerminalId]
      : undefined;
    if (!grid || !rect)
      return {
        edge: "center" as DropEdge,
        scope: "workspace" as DropScope,
        targetTerminalId,
        rect: { x: 0, y: 0, width: gridSize.width, height: gridSize.height },
      };
    const x = event.clientX - grid.left,
      y = event.clientY - grid.top;
    const outer = [
      { edge: "left", distance: x },
      { edge: "right", distance: grid.width - x },
      { edge: "top", distance: y },
      { edge: "bottom", distance: grid.height - y },
    ].sort((a, b) => a.distance - b.distance)[0];
    let edge: DropEdge = "center",
      scope: DropScope = "pane";
    let preview = { ...rect };
    if (outer.distance < 24) {
      edge = outer.edge as DropEdge;
      scope = "workspace";
      preview = { x: 0, y: 0, width: grid.width, height: grid.height };
    } else {
      const px = (x - rect.x) / Math.max(1, rect.width),
        py = (y - rect.y) / Math.max(1, rect.height);
      const closest = [
        { edge: "left", distance: px },
        { edge: "right", distance: 1 - px },
        { edge: "top", distance: py },
        { edge: "bottom", distance: 1 - py },
      ].sort((a, b) => a.distance - b.distance)[0];
      if (closest.distance < 0.27) edge = closest.edge as DropEdge;
    }
    if (edge === "left" || edge === "right") {
      preview.width /= 2;
      if (edge === "right") preview.x += preview.width;
    }
    if (edge === "top" || edge === "bottom") {
      preview.height /= 2;
      if (edge === "bottom") preview.y += preview.height;
    }
    return { edge, scope, targetTerminalId, rect: preview };
  }
  function dragOver(event: DragEvent, id?: string) {
    if (!acceptsDrop(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = event.dataTransfer.types.includes(
      "application/x-harbor-history",
    )
      ? "copy"
      : "move";
    setDropTarget(dropLocation(event, id));
  }
  function drop(event: DragEvent, id?: string) {
    if (!acceptsDrop(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const location = dropLocation(event, id);
    setDropTarget(null);
    const terminalId = event.dataTransfer.getData(
      "application/x-harbor-terminal-tab",
    );
    if (terminalId && attachedTerminals.some((t) => t.id === terminalId)) {
      setPanes(
        placeInTree(
          resolvedPanes,
          terminalId,
          location.targetTerminalId,
          location.edge,
          location.scope,
        ),
      );
      onFocus(terminalId);
      return;
    }
    try {
      const payload = JSON.parse(
        event.dataTransfer.getData("application/x-harbor-history"),
      );
      if (
        typeof payload.hostId !== "string" ||
        typeof payload.threadId !== "string"
      )
        return;
      window.dispatchEvent(
        new CustomEvent("harbor-history-drop", {
          detail: {
            ...payload,
            targetTerminalId: location.targetTerminalId,
            edge: location.edge,
            scope: location.scope,
          },
        }),
      );
    } catch {
      onError("대화 기록을 열지 못했습니다. 다시 끌어 놓아 주세요.");
    }
  }
  function nextPane() {
    const index = shownIds.indexOf(focusId);
    onFocus(shownIds[(index + 1) % shownIds.length]);
  }
  const renderActions = (info: TerminalInfo) => (
    <>
      <TerminalAutoApproval terminal={info} />
      {info.exited && (
        <span className="terminal-ended" title={info.disconnectReason}>
          {info.persistent === false &&
          info.connectionIssue &&
          info.connectionIssue !== "remote-exit"
            ? "SSH 연결 끊김"
            : "종료됨"}
        </span>
      )}
      {!info.exited && info.connectionState === "reconnecting" && (
        <span className="terminal-ended">재연결 중</span>
      )}
      {!info.exited && info.connectionState === "disconnected" && (
        <span className="terminal-ended" title={info.disconnectReason}>
          {info.connectionIssue === "remote-missing"
            ? "서버 세션 없음"
            : "세션 상태 확인 필요"}
        </span>
      )}
      {!info.exited &&
        !["disconnected", "reconnecting"].includes(
          info.connectionState || "",
        ) && (
          <span
            className={`terminal-agent-state ${info.agentConnected ? "connected" : ""}`}
            title={
              info.integration === "unavailable"
                ? "이 연결에서는 세션 메시지를 사용할 수 없습니다."
                : "codex 또는 claude를 실행하면 작업 상태가 연결됩니다."
            }
          >
            {info.agentConnected
              ? `${info.agentKind === "claude" ? "Claude" : "Codex"} · ${{ working: "작업 중", idle: "입력 대기", waiting: "승인 대기" }[info.agentState || "idle"]}`
              : "셸"}
          </span>
        )}
      <button
        className="icon-button compact"
        aria-label={`세션 이름 변경: ${info.title}`}
        title="세션 이름 변경"
        onClick={() => {
          setRenaming(info);
          setRenameTitle(info.title);
        }}
      >
        <Pencil size={14} />
      </button>
      <button
        className="icon-button compact"
        aria-label={`세션 메시지: ${info.title}`}
        title="세션 메시지"
        onClick={() => onMessages(info.id)}
      >
        <MessageSquare size={14} />
      </button>
      <button
        className="icon-button compact"
        title={`작업 폴더 열기 · ${info.cwd}`}
        aria-label={`파일 탐색: ${terminalLabel(info, terminals)}`}
        onClick={() => onFiles(info.hostId, info.cwd)}
      >
        <Folder size={14} />
      </button>
      {!popoutId && (
        <button
          className="icon-button compact"
          title="별도 창에서 열기"
          aria-label={`터미널 새 창: ${terminalLabel(info, terminals)}`}
          onClick={() => void openWindow(info.id)}
        >
          <ExternalLink size={14} />
        </button>
      )}
      <button
        className="icon-button compact"
        title="터미널 프로세스 종료"
        aria-label={`터미널 종료: ${terminalLabel(info, terminals)}`}
        onClick={() => onCloseTerminal(info)}
      >
        <X size={14} />
      </button>
    </>
  );
  return (
    <section
      className="terminal-workspace terminal-compact"
      aria-label="터미널 워크스페이스"
      hidden={!visible}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDropTarget(null);
      }}
      onDragEnd={() => setDropTarget(null)}
      onKeyDownCapture={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('[role="dialog"]')
        )
          return;
        if (
          event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          event.key === "PageDown" &&
          shownIds.length > 1
        ) {
          event.preventDefault();
          event.stopPropagation();
          nextPane();
        }
      }}
    >
      <div className="terminal-workspace-toolbar">
        <div className="terminal-tabs" aria-label="열린 터미널">
          {displayTerminals.map((t) => (
            <div
              className={`terminal-tab ${focusId === t.id ? "active" : ""} ${draggingId === t.id ? "is-dragging" : ""}`}
              key={t.id}
              data-terminal-tab={t.id}
              draggable={!popoutId}
              onDragStart={(event) => startDrag(event, t.id)}
              onDragEnd={(event) => void endDrag(event)}
            >
              <button
                title={`${hosts.find((h) => h.id === t.hostId)?.name || "터미널"} · ${t.cwd}${t.exited ? " · 종료됨" : ""}${!popoutId && window.harborDesktop?.startTabDrag ? " · 창 밖으로 끌어서 분리" : ""}`}
                aria-pressed={focusId === t.id}
                onClick={() => onFocus(t.id)}
              >
                <span
                  className={`connection-dot ${t.exited || (t.connectionState && t.connectionState !== "connected") ? "disconnected" : "connected"}`}
                />
                {terminalLabel(t, terminals)}
                {pending(t.id) && (
                  <span className="terminal-notice-badge">알림</span>
                )}
              </button>
            </div>
          ))}
          {!terminals.length && <span className="muted">열린 터미널 없음</span>}
        </div>
        {shown.length === 1 && (
          <div
            className="terminal-toolbar-actions"
            onPointerDown={() => {
              if (focusId !== shown[0].id) onFocus(shown[0].id);
            }}
          >
            {renderActions(shown[0])}
          </div>
        )}
        {!popoutId && (
          <div
            className="segmented layout-options"
            aria-label="터미널 화면 배치"
          >
            {shownIds.length > 1 && (
              <button
                title="다음 분할 창으로 이동 · Alt+PageDown"
                aria-label="다음 분할 창으로 이동"
                onClick={nextPane}
              >
                ⇄
              </button>
            )}
            {([1, 2, 3, 4] as const).map((n) => (
              <button
                key={n}
                aria-label={`터미널 ${n}분할 보기`}
                title={n === 3 ? "3분할 · 아래 창을 넓게" : `${n}분할 보기`}
                className={layout === n ? "active" : ""}
                aria-pressed={layout === n}
                onClick={() => chooseLayout(n)}
              >
                {n === 1 ? (
                  <Square size={14} />
                ) : n === 2 ? (
                  <Columns2 size={14} />
                ) : n === 3 ? (
                  <span className="terminal-layout-three">⊤</span>
                ) : (
                  <LayoutDashboard size={14} />
                )}
              </button>
            ))}
          </div>
        )}
      </div>
      {displayTerminals.length ? (
        <div
          ref={gridRef}
          className={"terminal-grid terminal-tree-grid"}
          data-resizing={resizing || undefined}
          data-layout={shownIds.length}
          onDragLeave={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            )
              setDropTarget(null);
          }}
        >
          {displayTerminals.map((info) => {
            const host = hosts.find((h) => h.id === info.hostId);
            const isShown = shownIds.includes(info.id);
            return (
              <article
                key={info.id}
                className={`terminal-card ${focusId === info.id ? "focused" : ""} ${pending(info.id) ? "has-notice" : ""}`}
                style={{
                  display: isShown ? "flex" : "none",
                  left: geometry.panes[info.id]?.x,
                  top: geometry.panes[info.id]?.y,
                  width: geometry.panes[info.id]?.width,
                  height: geometry.panes[info.id]?.height,
                }}
                data-terminal-id={info.id}
                onDragOverCapture={(event) => dragOver(event, info.id)}
                onDropCapture={(event) => drop(event, info.id)}
                onPointerDown={() => {
                  if (focusId !== info.id) onFocus(info.id);
                }}
                onFocusCapture={() => {
                  if (visible && isShown && focusId !== info.id)
                    onFocus(info.id);
                }}
              >
                {shown.length > 1 && (
                  <header
                    className="terminal-card-header"
                    draggable={!popoutId}
                    onDragStart={(event) => startDrag(event, info.id)}
                    onDragEnd={(event) => void endDrag(event)}
                  >
                    {host?.kind === "ssh" ? (
                      <Globe2 size={14} />
                    ) : (
                      <HardDrive size={14} />
                    )}
                    <div
                      className="terminal-card-title"
                      title={`${info.title} · ${host?.name || "터미널"} · ${info.cwd}`}
                    >
                      <b>{terminalLabel(info, terminals)}</b>
                      <span>{host?.name}</span>
                    </div>
                    {renderActions(info)}
                  </header>
                )}
                {pending(info.id) && (
                  <div className="terminal-attention" role="status">
                    <span title={pending(info.id)!.body}>
                      {pending(info.id)!.body}
                    </span>
                    <button onClick={() => read(info.id)}>읽음</button>
                  </div>
                )}
                <div className="terminal-card-body">
                  <TerminalPane
                    info={info}
                    hostName={host?.name}
                    active={visible && isShown}
                    focused={visible && focusId === info.id}
                    terminalColorsSupported={terminalColorsSupported}
                  />
                </div>
              </article>
            );
          })}
          {!popoutId &&
            geometry.dividers.map((divider) => (
              <TerminalSplitHandle
                key={divider.id}
                dividers={[divider]}
                grid={gridRef}
                onChange={changeRatios}
                onDragging={setResizing}
              />
            ))}
          {!popoutId &&
            junctions.map((junction) => (
              <TerminalSplitHandle
                key={junction.ids.join("-")}
                dividers={geometry.dividers.filter((d) =>
                  junction.ids.includes(d.id),
                )}
                grid={gridRef}
                x={junction.x}
                y={junction.y}
                onChange={changeRatios}
                onDragging={setResizing}
              />
            ))}
          {dropTarget && (
            <div
              className="terminal-drop-preview"
              style={{
                left: dropTarget.rect.x,
                top: dropTarget.rect.y,
                width: dropTarget.rect.width,
                height: dropTarget.rect.height,
              }}
            >
              <span>
                {dropTarget.edge === "center"
                  ? "이 창에서 열기"
                  : {
                      left: "왼쪽",
                      right: "오른쪽",
                      top: "위쪽",
                      bottom: "아래쪽",
                    }[dropTarget.edge] + "에 분할하여 열기"}
              </span>
            </div>
          )}
        </div>
      ) : (
        <div
          className="terminal-welcome"
          data-drop-active={!!dropTarget || undefined}
          onDragOver={(event) => dragOver(event)}
          onDrop={(event) => drop(event)}
        >
          <div className="terminal-welcome-icon">
            <Terminal size={30} />
          </div>
          <h2>
            {popoutId
              ? "종료된 터미널입니다"
              : detachedIds.length
                ? "터미널이 별도 창에 있습니다"
                : "첫 터미널을 열어보세요"}
          </h2>
          <p>
            {popoutId
              ? "전체 워크스페이스에서 새 터미널을 열 수 있습니다."
              : detachedIds.length
                ? "별도 창을 닫으면 이 작업 공간에 다시 표시됩니다."
                : "로컬과 SSH 서버를 한곳에. 각 터미널에서 codex, 셸, 개발 도구를 그대로 사용하세요."}
          </p>
          {!popoutId && detachedIds.length > 0 && (
            <div className="terminal-detached-list">
              {terminals
                .filter((t) => detachedIds.includes(t.id))
                .map((t) => (
                  <button
                    className="button secondary"
                    key={t.id}
                    onClick={() => void focusTerminalWindow(t.id)}
                  >
                    <ExternalLink size={15} />
                    {t.title} 창으로 이동
                  </button>
                ))}
            </div>
          )}
          {!popoutId && (
            <div className="terminal-host-shortcuts">
              {hosts.map((host) => (
                <button
                  key={host.id}
                  className="button secondary"
                  disabled={!ready}
                  onClick={() => onNew(host.id)}
                >
                  {host.kind === "local" ? (
                    <HardDrive size={17} />
                  ) : (
                    <Globe2 size={17} />
                  )}
                  <span>{host.name}</span>
                  <Plus size={15} />
                </button>
              ))}
            </div>
          )}
          <div className="terminal-command-example">
            <span>$</span> cd my-project <span>→</span> codex
          </div>
        </div>
      )}
      {renaming && (
        <Modal
          title="세션 이름 변경"
          subtitle="다른 Codex가 알아보기 쉬운 이름을 사용하세요."
          onClose={() => setRenaming(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api(`/terminals/${renaming.id}/rename`, {
                  title: renameTitle,
                });
                setRenaming(null);
              } catch (err) {
                onError((err as Error).message);
              }
            }}
          >
            <div className="modal-body">
              <label className="field">
                세션 이름
                <input
                  aria-label="새 세션 이름"
                  autoFocus
                  value={renameTitle}
                  maxLength={100}
                  required
                  onChange={(e) => setRenameTitle(e.target.value)}
                />
              </label>
            </div>
            <footer className="modal-footer">
              <button className="button primary" disabled={!renameTitle.trim()}>
                저장
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </section>
  );
}
