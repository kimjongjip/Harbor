import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
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
import { useNotifications } from "./Notifications";
import { useTheme, terminalColors } from "./Theme";
import {
  useDetachedTerminals,
  useTabDetach,
  focusTerminalWindow,
} from "./terminalWindows";
import "./terminal-windows.css";
import "./terminal-layout.css";
import { reconcileTerminalPanes, type TerminalPanes } from "./terminal-panes";
import { placeTerminalPane } from "./terminal-panes";
import TerminalJunction from "./TerminalJunction";
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
  const [launch, setLaunch] = useState<
    "shell" | "codex" | "resume" | "claude" | "claude-resume"
  >("shell");
  return (
    <Modal
      title="새 터미널"
      subtitle="서버를 고르면 홈 디렉터리(~)에서 터미널을 시작합니다."
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

function savedLayout(): 1 | 2 | 3 | 4 {
  try {
    const n = Number(localStorage.getItem("harbor.terminalLayout"));
    return n === 1 || n === 2 || n === 3 || n === 4 ? n : 2;
  } catch {
    return 2;
  }
}

function savedPanes(): TerminalPanes {
  try {
    const saved = JSON.parse(
      localStorage.getItem("harbor.terminalPanes") || "null",
    );
    if (
      Array.isArray(saved?.ids) &&
      saved.ids.every((id: unknown) => typeof id === "string")
    )
      return {
        ids: [...new Set<string>(saved.ids)].slice(0, 4),
        focusedId: typeof saved.focusedId === "string" ? saved.focusedId : "",
      };
  } catch {}
  return { ids: [], focusedId: "" };
}

type SplitAxis = "column" | "row";
type SplitRatios = Record<2 | 3 | 4, Record<SplitAxis, number>>;
const splitStorageKey = "harbor.terminalSplitRatios";
const dividerSize = 6;

function clampSplit(value: number, minimum = 0.15) {
  return Math.max(minimum, Math.min(1 - minimum, value));
}

function savedSplits(): SplitRatios {
  const result: SplitRatios = {
    2: { column: 0.5, row: 0.5 },
    3: { column: 0.5, row: 0.5 },
    4: { column: 0.5, row: 0.5 },
  };
  try {
    const saved = JSON.parse(localStorage.getItem(splitStorageKey) || "null");
    for (const layout of [2, 3, 4] as const)
      for (const axis of ["column", "row"] as const) {
        const value = saved?.[layout]?.[axis];
        if (typeof value === "number" && Number.isFinite(value))
          result[layout][axis] = clampSplit(value);
      }
  } catch {
    // Resizing also works without browser storage.
  }
  return result;
}

function TerminalDivider({
  axis,
  ratio,
  minimum,
  grid,
  onChange,
  onDragging,
}: {
  axis: SplitAxis;
  ratio: number;
  minimum: number;
  grid: RefObject<HTMLDivElement | null>;
  onChange: (ratio: number, persist: boolean) => void;
  onDragging: (axis: SplitAxis | null) => void;
}) {
  const pointer = useRef<number | null>(null);
  const position = useRef(0);
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const vertical = axis === "column";
  function apply(persist = false) {
    const element = grid.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const startPadding =
      parseFloat(vertical ? style.paddingLeft : style.paddingTop) || 0;
    const endPadding =
      parseFloat(vertical ? style.paddingRight : style.paddingBottom) || 0;
    const extent =
      (vertical ? rect.width : rect.height) -
      startPadding -
      endPadding -
      dividerSize;
    if (extent <= 0) return;
    const start = (vertical ? rect.left : rect.top) + startPadding;
    onChange(
      clampSplit(
        (position.current - start - dividerSize / 2) / extent,
        minimum,
      ),
      persist,
    );
  }
  function finish() {
    if (pointer.current === null) return;
    pointer.current = null;
    cancelAnimationFrame(frame.current);
    apply(true);
    onDragging(null);
  }
  return (
    <div
      className={`terminal-divider terminal-divider-${axis}`}
      role="separator"
      tabIndex={0}
      aria-label={
        vertical ? "터미널 좌우 크기 조절" : "터미널 위아래 크기 조절"
      }
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-valuemin={Math.round(minimum * 100)}
      aria-valuemax={Math.round((1 - minimum) * 100)}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuetext={`${vertical ? "왼쪽" : "위쪽"} ${Math.round(ratio * 100)}%`}
      title="끌어서 크기 조절 · 두 번 클릭하면 반반 · 방향키로 조절, Home으로 초기화"
      onPointerDown={(event) => {
        if (event.button !== 0 || pointer.current !== null) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        pointer.current = event.pointerId;
        position.current = vertical ? event.clientX : event.clientY;
        onDragging(axis);
      }}
      onPointerMove={(event) => {
        if (pointer.current !== event.pointerId) return;
        position.current = vertical ? event.clientX : event.clientY;
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => apply());
      }}
      onPointerUp={(event) => {
        if (pointer.current !== event.pointerId) return;
        position.current = vertical ? event.clientX : event.clientY;
        finish();
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={() => onChange(0.5, true)}
      onKeyDown={(event) => {
        const decrease = vertical ? "ArrowLeft" : "ArrowUp";
        const increase = vertical ? "ArrowRight" : "ArrowDown";
        if (event.key === "Home" || event.key === "Enter") {
          event.preventDefault();
          onChange(0.5, true);
        } else if (event.key === decrease || event.key === increase) {
          event.preventDefault();
          const step = event.shiftKey ? 0.1 : 0.02;
          onChange(
            clampSplit(
              ratio + (event.key === increase ? step : -step),
              minimum,
            ),
            true,
          );
        }
      }}
    />
  );
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
  onNew: (hostId?: string, cwd?: string) => void;
  onFiles: (hostId: string, cwd: string) => void;
  onError: (message: string) => void;
  onMessages: (id: string) => void;
}) {
  const [layout, setLayout] = useState<1 | 2 | 3 | 4>(() =>
    popoutId ? 1 : savedLayout(),
  );
  const [splits, setSplits] = useState(savedSplits);
  const splitRef = useRef(splits);
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridSize, setGridSize] = useState({ width: 0, height: 0 });
  const [resizing, setResizing] = useState<SplitAxis | "both" | null>(null);
  const [dropSlot, setDropSlot] = useState<number | null>(null);
  const [placements, setPlacements] = useState<
    {
      terminalId: string;
      slot?: number;
      targetTerminalId?: string;
    }[]
  >([]);
  const placement = placements[0];
  const [panes, setPanes] = useState<TerminalPanes>(savedPanes);
  const [ending, setEnding] = useState<TerminalInfo | null>(null);
  const [closing, setClosing] = useState(false);
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
  useEffect(() => {
    try {
      if (!popoutId)
        localStorage.setItem("harbor.terminalLayout", String(layout));
    } catch {
      // A browser storage restriction must not prevent changing the layout.
    }
  }, [layout, popoutId]);
  const current = attachedTerminals.find(
    (t) => t.id === (popoutId || activeId),
  );
  const resolvedPanes = reconcileTerminalPanes(
    panes,
    attachedTerminals.map((terminal) => terminal.id),
    activeId,
    layout,
  );
  const paneKey = resolvedPanes.ids.join(",");
  useLayoutEffect(() => {
    if (
      !popoutId &&
      ready &&
      (panes.focusedId !== resolvedPanes.focusedId ||
        panes.ids.join(",") !== paneKey)
    )
      setPanes(resolvedPanes);
  }, [paneKey, resolvedPanes.focusedId, popoutId, ready]);
  useEffect(() => {
    if (popoutId || !ready || !resolvedPanes.ids.length) return;
    try {
      localStorage.setItem(
        "harbor.terminalPanes",
        JSON.stringify(resolvedPanes),
      );
    } catch {}
  }, [paneKey, resolvedPanes.focusedId, popoutId, ready]);
  const shownIds = popoutId
    ? terminals.filter((t) => t.id === popoutId).map((t) => t.id)
    : resolvedPanes.ids;
  const focusId = current?.id || resolvedPanes.focusedId || shownIds[0];
  const shown = terminals.filter((t) => shownIds.includes(t.id));
  const displayTerminals = popoutId
    ? terminals.filter((t) => t.id === popoutId)
    : attachedTerminals;
  const hasGrid = displayTerminals.length > 0;
  useEffect(() => {
    const element = gridRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setGridSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasGrid]);
  useEffect(() => setResizing(null), [layout, shown.length]);
  const splitLayout = layout >= 3 ? (layout as 3 | 4) : 2;
  const splitMinimum = {
    column: Math.min(
      0.45,
      Math.max(0.15, 260 / Math.max(1, gridSize.width - dividerSize)),
    ),
    row: Math.min(
      0.45,
      Math.max(0.15, 150 / Math.max(1, gridSize.height - dividerSize)),
    ),
  };
  const columnRatio = clampSplit(
    splits[splitLayout].column,
    splitMinimum.column,
  );
  const rowRatio = clampSplit(splits[splitLayout].row, splitMinimum.row);
  const canResize = !popoutId && layout > 1 && shown.length > 1;
  function changeSplit(axis: SplitAxis, ratio: number, persist: boolean) {
    const next = {
      ...splitRef.current,
      [splitLayout]: { ...splitRef.current[splitLayout], [axis]: ratio },
    };
    splitRef.current = next;
    setSplits(next);
    if (persist) {
      try {
        localStorage.setItem(splitStorageKey, JSON.stringify(next));
      } catch {
        // Keep the current sizes even when they cannot be saved.
      }
    }
  }
  useEffect(() => {
    if (popoutId) return;
    const receive = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (typeof detail?.terminalId !== "string") return;
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
    const target = placement.targetTerminalId
      ? shownIds.indexOf(placement.targetTerminalId)
      : -1;
    const slot = target >= 0 ? target : (placement.slot ?? 0);
    setPanes(
      placeTerminalPane(resolvedPanes, placement.terminalId, slot, layout),
    );
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
  function dragOver(event: DragEvent, slot: number) {
    if (!acceptsDrop(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = event.dataTransfer.types.includes(
      "application/x-harbor-history",
    )
      ? "copy"
      : "move";
    setDropSlot(slot);
  }
  function drop(event: DragEvent, slot: number) {
    if (!acceptsDrop(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setDropSlot(null);
    const terminalId = event.dataTransfer.getData(
      "application/x-harbor-terminal-tab",
    );
    if (terminalId && attachedTerminals.some((t) => t.id === terminalId)) {
      setPanes(placeTerminalPane(resolvedPanes, terminalId, slot, layout));
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
            slot,
            targetTerminalId: shownIds[slot],
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
  const panePosition = (index: number): CSSProperties =>
    ({
      "--terminal-pane-column":
        layout === 3 && index === 2 ? "1 / -1" : (index % 2) * 2 + 1,
      "--terminal-pane-row": Math.floor(index / 2) * 2 + 1,
    }) as CSSProperties;
  const renderActions = (info: TerminalInfo) => (
    <>
      {info.exited && <span className="terminal-ended">종료됨</span>}
      {!info.exited && (
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
        onClick={() => setEnding(info)}
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
          setDropSlot(null);
      }}
      onDragEnd={() => setDropSlot(null)}
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
                  className={`connection-dot ${t.exited ? "disconnected" : "connected"}`}
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
                onClick={() => setLayout(n)}
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
          className={`terminal-grid layout-${layout} ${shown.length === 1 ? "single-terminal" : ""} ${canResize ? "terminal-resizable-grid" : ""}`}
          data-resizing={resizing || undefined}
          data-layout={layout}
          style={
            {
              "--terminal-grid-columns": `minmax(0, ${columnRatio}fr) ${dividerSize}px minmax(0, ${1 - columnRatio}fr)`,
              "--terminal-grid-rows":
                layout >= 3
                  ? `minmax(0, ${rowRatio}fr) ${dividerSize}px minmax(0, ${1 - rowRatio}fr)`
                  : "minmax(0, 1fr)",
            } as CSSProperties
          }
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
                  order: shownIds.indexOf(info.id),
                  ...panePosition(shownIds.indexOf(info.id)),
                }}
                data-terminal-id={info.id}
                data-drop-active={
                  (isShown && dropSlot === shownIds.indexOf(info.id)) ||
                  undefined
                }
                onDragOverCapture={(event) =>
                  dragOver(event, shownIds.indexOf(info.id))
                }
                onDropCapture={(event) =>
                  drop(event, shownIds.indexOf(info.id))
                }
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
          {shown.length < layout && !popoutId && shown.length > 1 && (
            <button
              className="terminal-add-pane"
              data-drop-active={dropSlot === shown.length || undefined}
              onDragOver={(event) => dragOver(event, shown.length)}
              onDrop={(event) => drop(event, shown.length)}
              style={{ order: 5, ...panePosition(shown.length) }}
              onClick={() => onNew(current?.hostId, current?.cwd)}
            >
              <Plus size={20} />
              <b>터미널 추가</b>
              <span>대화 기록이나 탭을 여기에 끌어 놓기</span>
            </button>
          )}
          {canResize && (
            <TerminalDivider
              axis="column"
              ratio={columnRatio}
              minimum={splitMinimum.column}
              grid={gridRef}
              onChange={(ratio, persist) =>
                changeSplit("column", ratio, persist)
              }
              onDragging={setResizing}
            />
          )}
          {canResize && layout >= 3 && (
            <TerminalDivider
              axis="row"
              ratio={rowRatio}
              minimum={splitMinimum.row}
              grid={gridRef}
              onChange={(ratio, persist) => changeSplit("row", ratio, persist)}
              onDragging={setResizing}
            />
          )}
          {canResize && layout >= 3 && (
            <TerminalJunction
              grid={gridRef}
              onDragging={(dragging) => setResizing(dragging ? "both" : null)}
              onChange={(column, row, persist) => {
                changeSplit(
                  "column",
                  clampSplit(column, splitMinimum.column),
                  false,
                );
                changeSplit("row", clampSplit(row, splitMinimum.row), persist);
              }}
            />
          )}
        </div>
      ) : (
        <div
          className="terminal-welcome"
          data-drop-active={dropSlot === 0 || undefined}
          onDragOver={(event) => dragOver(event, 0)}
          onDrop={(event) => drop(event, 0)}
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
      {ending && (
        <Modal
          title="터미널 종료"
          subtitle={`${terminalLabel(ending, terminals)}의 셸과 실행 중인 프로그램을 종료합니다.`}
          onClose={() => setEnding(null)}
        >
          <div className="modal-body">
            <p>창만 따로 열려면 패널의 새 창 버튼을 사용하세요.</p>
          </div>
          <footer className="modal-footer">
            <button
              className="button secondary"
              onClick={() => setEnding(null)}
            >
              취소
            </button>
            <button
              className="button primary"
              disabled={closing}
              onClick={async () => {
                setClosing(true);
                try {
                  await api(`/terminals/${ending.id}/close`, {});
                  setEnding(null);
                } catch (err) {
                  onError((err as Error).message);
                } finally {
                  setClosing(false);
                }
              }}
            >
              터미널 종료
            </button>
          </footer>
        </Modal>
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
