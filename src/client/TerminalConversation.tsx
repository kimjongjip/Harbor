import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { Terminal } from "@xterm/xterm";
import { ArrowDown } from "lucide-react";
import type { TerminalInfo } from "../shared/types";
import type { HistoryDetail } from "../shared/history";
import type { RichTerminalBlock } from "../shared/rich-terminal";
import { api } from "./api";
import { TranscriptItems, type TranscriptItemsProps } from "./TranscriptItems";
import { Markdown } from "./RichMarkdown";
import { transcriptEntries } from "./transcript-steps";
import { TerminalNativeFlow, type NativeFlowFrame } from "./TerminalNativeFlow";
import {
  liveTranscriptLayout,
  type LiveTranscriptLayout,
} from "./terminal-transcript-boundary";
import { TerminalCompletionCue } from "./terminal-completion-cue";
import { isLegacyClaudeHistoryLimit } from "./history-errors";
import {
  conversationTurns,
  mergeTimeline,
  expandTimeline,
} from "./conversation-turns";
import { conversationSelection } from "./conversation-selection";
import {
  captureConversationSelection,
  restoreConversationSelection,
  type ConversationSelectionSnapshot,
} from "./conversation-selection-snapshot";
import "./terminal-conversation.css";
import { useClaudeModSurface } from "./useClaudeModSurface";
import { frameWithoutModPanels } from "./terminal-mod-surface";
import { nativeTranscriptRepaint } from "./terminal-native-chrome";

export type ConversationMode = "auto" | "conversation" | "terminal";
const emptyBlocks: RichTerminalBlock[] = [];
const emptyTimeline: NonNullable<HistoryDetail["timeline"]> = [];
const turnKey = (turn: ReturnType<typeof conversationTurns>[number]) => {
  const last = turn.items.at(-1)!;
  return `${last.kind}:${last.id}`;
};
/** One turn's saved work. A running turn's group is open and also hosts the
 * CLI rows newer than history; any group can be folded at any time. */
const WorkGroup = memo(function WorkGroup({
  items,
  state,
  busy = false,
  open,
  onToggle,
  target,
  props,
}: {
  items: TranscriptItemsProps["items"];
  state: "live" | "done" | "saved";
  /** The CLI is visibly working on this turn (not merely unverified). */
  busy?: boolean;
  open: boolean;
  onToggle(open: boolean): void;
  target?: (node: HTMLDivElement | null) => void;
  props: Omit<TranscriptItemsProps, "items">;
}) {
  const count = useMemo(() => transcriptEntries(items).length, [items]);
  const summary = useRef<HTMLElement>(null);
  const collapse = () => {
    const node = summary.current;
    if (node) {
      const body = node.closest<HTMLElement>(".terminal-conversation-body");
      if (
        body &&
        node.getBoundingClientRect().top < body.getBoundingClientRect().top
      )
        body.scrollTop +=
          node.getBoundingClientRect().top - body.getBoundingClientRect().top;
      node.focus({ preventScroll: true });
    }
    onToggle(false);
  };
  return (
    <details
      className={`conversation-work${state === "live" ? " live" : ""}`}
      data-work-state={state}
      open={open}
    >
      <summary
        ref={summary}
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault();
          onToggle(!open);
        }}
      >
        {state === "live" && busy && (
          <span className="conversation-work-spinner" aria-hidden="true" />
        )}
        {state === "live"
          ? busy
            ? "작업 중"
            : "작업 기록"
          : state === "done"
            ? "작업 과정"
            : "저장된 작업"}
        {count ? ` · ${count}개` : ""}
      </summary>
      {open && !!items.length && (
        <TranscriptItems items={items} {...props} stepsOpen />
      )}
      {target && <div className="conversation-live-work" ref={target} />}
      {open && (
        <button
          type="button"
          className="conversation-work-collapse"
          onClick={collapse}
        >
          작업 과정 접기
        </button>
      )}
    </details>
  );
});

/** One terminal document: persisted work and native live output/input share one scroller. */
export function TerminalConversation({
  term,
  info,
  historySessionId,
  mode = "auto",
  blocks = emptyBlocks,
  active = true,
  onLink,
}: {
  term: Terminal;
  info: TerminalInfo;
  /** A read-only recovery must not be mistaken for the terminal's input binding. */
  historySessionId?: string;
  onClose?(): void;
  mode?: ConversationMode;
  blocks?: RichTerminalBlock[];
  active?: boolean;
  onLink?(text: string): void;
}) {
  const sessionId =
    info.agentSessionId || info.resumeThreadId || historySessionId;
  const provider =
    info.agentKind || (info.program?.startsWith("claude") ? "claude" : "codex");
  const modSurface = useClaudeModSurface(
    term,
    provider === "claude" && active && mode !== "terminal",
  );
  const [detail, setDetail] = useState<HistoryDetail | null>(null);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [historyPaused, setHistoryPaused] = useState(false),
    [selected, setSelected] = useState(false);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(following);
  followingRef.current = following;
  const [, setBoundaryRevision] = useState(0);
  const [proofRevision, setProofRevision] = useState(0);
  const verifiedHistory = useRef(new Map<string, string>());
  const body = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null),
    busy = useRef(false);
  const retryMore = useRef(false),
    loadedOlder = useRef(false);
  const refreshQueued = useRef(false);
  const olderQueued = useRef(false);
  const olderCursors = useRef(new Set<string>());
  const latest = useRef(detail);
  const pending = useRef<HistoryDetail | null>(null);
  const selectedPrepend = useRef<{
    detail: HistoryDetail;
    selection: ConversationSelectionSnapshot;
  } | null>(null);
  const anchor = useRef<{ height: number; top: number } | "bottom" | null>(
    null,
  );
  const state = useRef({ active, mode, historyPaused, error });
  state.current = { active, mode, historyPaused, error };
  const hasSelection = () => {
    const selection = body.current?.ownerDocument.getSelection();
    return (
      !!selection &&
      !selection.isCollapsed &&
      !!body.current?.contains(selection.anchorNode)
    );
  };
  const apply = (result: HistoryDetail, more: boolean) => {
    result = { ...result, timeline: expandTimeline(result) };
    const merge = (previous: HistoryDetail | null) =>
      previous
        ? {
            ...result,
            notice: result.notice || previous.notice,
            nextCursor:
              more || !loadedOlder.current
                ? result.nextCursor
                : previous.nextCursor,
            items: mergeTimeline(previous.items, result.items, more),
            timeline: mergeTimeline(
              previous.timeline || previous.items,
              result.timeline || result.items,
              more,
            ),
          }
        : result;
    // Prepending old pages must not also expose a queued live edit/completion.
    const next = merge(
      more ? latest.current : pending.current || latest.current,
    );
    if (more) loadedOlder.current = true;
    if (more && pending.current) pending.current = merge(pending.current);
    // Polls must never replace selected DOM or collapse a work group during a drag.
    if ((hasSelection() || !followingRef.current) && !more) {
      pending.current = next;
      return;
    }
    const node = body.current;
    if (more && node && hasSelection()) {
      const selection = captureConversationSelection(node);
      if (selection) selectedPrepend.current = { detail: next, selection };
    }
    anchor.current =
      more && node
        ? { height: node.scrollHeight, top: node.scrollTop }
        : !node || node.scrollHeight - node.clientHeight - node.scrollTop < 40
          ? "bottom"
          : null;
    latest.current = next;
    // Saved Markdown can be expensive; native echo remains the urgent update.
    startTransition(() => setDetail(next));
  };
  const load = useRef<(more?: boolean, automatic?: boolean) => Promise<void>>(
    async () => {},
  );
  load.current = async (more = false, automatic = false) => {
    if (
      automatic &&
      (state.current.historyPaused ||
        !state.current.active ||
        state.current.mode === "terminal" ||
        document.visibilityState === "hidden")
    )
      return;
    const previous = latest.current;
    if (!sessionId || (more && !previous?.nextCursor)) return;
    if (busy.current) {
      if (more) olderQueued.current = true;
      else refreshQueued.current = true;
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    busy.current = true;
    retryMore.current = more;
    setLoading(true);
    setError("");
    if (!automatic) setHistoryPaused(false);
    let failed = false;
    try {
      if (more && olderCursors.current.has(previous!.nextCursor!))
        throw new Error(
          "이전 대화의 읽기 위치가 반복되었습니다. 기록을 다시 열어 주세요.",
        );
      const params = new URLSearchParams({
        provider,
        includeActivity: "1",
        ...(more && previous?.nextCursor
          ? { cursor: previous.nextCursor }
          : {}),
      });
      const result = await api<HistoryDetail>(
        `/hosts/${encodeURIComponent(info.hostId)}/history/${encodeURIComponent(sessionId)}?${params}`,
        undefined,
        "GET",
        AbortSignal.any([controller.signal, AbortSignal.timeout(65000)]),
      );
      if (
        controller.signal.aborted ||
        result.thread.id !== sessionId ||
        result.thread.hostId !== info.hostId
      )
        return;
      if (more && result.nextCursor === previous?.nextCursor)
        throw new Error("이전 대화를 읽지 못했습니다. 다시 시도하세요.");
      if (more) olderCursors.current.add(previous!.nextCursor!);
      apply(result, more);
    } catch (cause) {
      failed = true;
      if (!controller.signal.aborted) {
        if (isLegacyClaudeHistoryLimit(cause)) setHistoryPaused(true);
        else setError((cause as Error).message);
      }
    } finally {
      if (request.current === controller) {
        busy.current = false;
        setLoading(false);
        if (
          olderQueued.current &&
          !failed &&
          !controller.signal.aborted &&
          !state.current.error &&
          body.current &&
          body.current.scrollTop < 24
        ) {
          olderQueued.current = false;
          void load.current(true, true);
        } else if (refreshQueued.current) {
          olderQueued.current = false;
          refreshQueued.current = false;
          void load.current(false, true);
        } else olderQueued.current = false;
      }
    }
  };
  useEffect(() => {
    latest.current = null;
    pending.current = null;
    loadedOlder.current = false;
    refreshQueued.current = false;
    olderQueued.current = false;
    olderCursors.current.clear();
    selectedPrepend.current = null;
    setSelected(false);
    setFollowing(true);
    verifiedHistory.current.clear();
    setDetail(null);
    setError("");
    setHistoryPaused(false);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await load.current(false, true);
      if (!stopped) timer = setTimeout(poll, 30000);
    };
    void poll();
    const visible = () => {
      if (document.visibilityState === "visible")
        void load.current(false, true);
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      request.current?.abort();
      request.current = null;
      busy.current = false;
      refreshQueued.current = false;
      olderQueued.current = false;
      selectedPrepend.current = null;
      if (hasSelection())
        body.current?.ownerDocument.getSelection()?.removeAllRanges();
      document.removeEventListener("visibilitychange", visible);
    };
  }, [info.id, info.hostId, sessionId, provider]);
  // Completion and native-state notifications refresh without requiring a scroll or mousemove.
  useEffect(() => {
    const timer = setTimeout(() => void load.current(false, true), 160);
    return () => clearTimeout(timer);
  }, [blocks, info.agentState, info.agentCompletion?.textHash, active, mode]);
  useEffect(() => {
    const node = body.current;
    if (!node) return;
    const dispose = conversationSelection(node, () => {
      if (
        !state.current.error &&
        !state.current.historyPaused &&
        latest.current?.nextCursor
      )
        void load.current(true, true);
    });
    const changed = () => {
      const present = hasSelection();
      setSelected(present);
      if (!present && followingRef.current && pending.current) {
        latest.current = pending.current;
        setDetail(pending.current);
        pending.current = null;
      }
    };
    node.ownerDocument.addEventListener("selectionchange", changed);
    return () => {
      dispose();
      node.ownerDocument.removeEventListener("selectionchange", changed);
    };
  }, [term]);
  const resumeFollowing = () => {
    followingRef.current = true;
    setFollowing(true);
    if (!hasSelection() && pending.current) {
      latest.current = pending.current;
      setDetail(pending.current);
      pending.current = null;
    }
    anchor.current = "bottom";
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  };
  useEffect(() => {
    const input = term.onData?.((data) => {
      // A real edit ends a frozen history selection. Mouse/protocol replies
      // must not do this; otherwise text is silently held until a later click.
      if (
        data &&
        (!data.startsWith("\x1b") || data === "\x1b") &&
        hasSelection()
      ) {
        body.current?.ownerDocument.getSelection()?.removeAllRanges();
        setSelected(false);
      }
      // Already following: nothing to restore. Reading scrollHeight here would
      // force a synchronous layout of the whole transcript on every key.
      if (followingRef.current && !pending.current) return;
      if (!hasSelection()) resumeFollowing();
    });
    return () => input?.dispose();
  }, [term]);
  const timeline = detail?.timeline || detail?.items || emptyTimeline;
  const candidate = useMemo(
    () =>
      [...timeline]
        .reverse()
        .find((item) => item.kind === "assistant" || item.kind === "user"),
    [timeline],
  );
  const completion = info.agentCompletion;
  const proof =
    completion && completion.sessionId === sessionId && provider === "claude"
      ? completion.textHash
      : "";
  const proofKey = `${info.hostId}:${sessionId}:${proof}`;
  useEffect(() => {
    let cancelled = false;
    if (
      !proof ||
      candidate?.kind !== "assistant" ||
      info.agentState === "working" ||
      info.agentState === "waiting"
    ) {
      return;
    }
    void crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(candidate.text))
      .then((hash) => {
        const actual = Array.from(new Uint8Array(hash), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        if (!cancelled) {
          if (actual === proof) {
            verifiedHistory.current.set(candidate.id, candidate.text);
            if (verifiedHistory.current.size > 500)
              verifiedHistory.current.delete(
                verifiedHistory.current.keys().next().value!,
              );
          }
          if (actual === proof) setProofRevision((value) => value + 1);
        }
      })
      .catch(() => {
        /* Missing WebCrypto leaves the native output available. */
      });
    return () => {
      cancelled = true;
    };
  }, [
    candidate?.id,
    candidate?.text,
    candidate?.kind,
    proofKey,
    info.agentState,
  ]);
  // A verified earlier Stop stays folded when the next prompt starts. The map
  // belongs only to this native session and also checks unchanged message text.
  const computedTurns = useMemo(
    () => conversationTurns(timeline, verifiedHistory.current),
    [timeline, proofRevision],
  );
  const retainedTurns = useRef<ReturnType<typeof conversationTurns>>([]);
  const frozen = hasSelection() || !following;
  const prepending =
    selectedPrepend.current?.detail === detail ||
    (!!anchor.current && anchor.current !== "bottom");
  if (!frozen || prepending) {
    let nextTurns = computedTurns;
    if (frozen) {
      const existing = new Map(
        retainedTurns.current.map((turn) => [turnKey(turn), turn]),
      );
      nextTurns = nextTurns.map((turn) => {
        const previous = existing.get(turnKey(turn));
        return previous
          ? {
              ...turn,
              complete: previous.complete,
              finalIds: previous.finalIds,
            }
          : turn;
      });
    }
    retainedTurns.current = nextTurns;
  }
  const turns = retainedTurns.current;
  const visible = active && mode !== "terminal";
  // Completion is verified from the saved turn, never inferred from an idle
  // composer or an approval dialog waiting for input.
  const waiting = info.agentState === "waiting";
  const pendingHistory = !detail && !error;
  // Echoed keystrokes belong to the native tail. They must not rerender every
  // saved Markdown/tool block or schedule a second full native capture.
  const layoutForFrame = useMemo(() => {
    let cachedFrame: NativeFlowFrame | undefined;
    let cachedLayout: LiveTranscriptLayout;
    return (frame: NativeFlowFrame) => {
      if (frame !== cachedFrame) {
        cachedFrame = frame;
        cachedLayout = liveTranscriptLayout(
          turns,
          frameWithoutModPanels(term, frame, modSurface?.native),
          blocks,
          { waiting, pendingHistory },
        );
      }
      return cachedLayout;
    };
  }, [turns, blocks, waiting, pendingHistory, term, modSurface]);
  const publishedLayout = useRef<LiveTranscriptLayout | undefined>(undefined);
  const nativeRange = useCallback(
    (frame: NativeFlowFrame) => {
      const next = layoutForFrame(frame);
      return {
        start: next.nativeStart,
        split: next.live ? next.chromeStart : next.nativeStart,
        end: modSurface?.native.end,
        panels: modSurface?.native.panels,
        // SSH/PTY chunks need not align with a complete CLI repaint. Losing
        // its footer briefly must not unmount saved work and expose the raw
        // screen on every animation/status refresh. The native reader commits
        // the replacement and its boundary together after a bounded grace.
        defer:
          publishedLayout.current?.live && !next.live
            ? nativeTranscriptRepaint(frame.lines, frame.end)
              ? ("repaint" as const)
              : true
            : false,
      };
    },
    [layoutForFrame, modSurface],
  );
  // A running CLI shows "esc to interrupt" in its live area even when no
  // native event reported working (poll-only sessions).
  const [nativeBusy, setNativeBusy] = useState(false);
  const completionCue = useMemo(
    () => ({
      detector: new TerminalCompletionCue(),
      timers: [] as ReturnType<typeof setTimeout>[],
    }),
    [term, info.id, info.hostId, sessionId, provider],
  );
  useEffect(
    () => () => completionCue.timers.forEach(clearTimeout),
    [completionCue, active, mode],
  );
  const updateNativeFrame = useCallback(
    (frame: NativeFlowFrame) => {
      // Some existing sessions have no peer event transport. A new native
      // footer merely asks for a read; saved turn status still decides folding.
      if (
        completionCue.detector.observe(
          frameWithoutModPanels(term, frame, modSurface?.native).lines,
          provider,
        )
      ) {
        completionCue.timers.forEach(clearTimeout);
        // The footer can arrive before the persisted turn becomes completed.
        // Retry a bounded number of times without requiring more native output.
        completionCue.timers = [0, 750, 2000, 5000].map((delay) =>
          setTimeout(() => void load.current(false, true), delay),
        );
      }
      const next = layoutForFrame(frame);
      const current = publishedLayout.current;
      if (
        !current ||
        next.historyCount !== current.historyCount ||
        next.nativeStart !== current.nativeStart ||
        next.chromeStart !== current.chromeStart ||
        next.live !== current.live
      ) {
        publishedLayout.current = next;
        setBoundaryRevision((value) => value + 1);
      }
      const busy =
        next.live &&
        frame.lines
          .slice(next.chromeStart, frame.end)
          .some((line) => line.includes("esc to interrupt"));
      setNativeBusy((value) => (value === busy ? value : busy));
    },
    [layoutForFrame, completionCue, provider, term, modSurface],
  );
  // A completed answer the CLI reserved rows for is typeset at once from its
  // received text, instead of raw Markdown until history catches up.
  const renderNativeAnswer = useCallback(
    (text: string) => (
      <div className="terminal-native-answer-text">
        <Markdown
          text={text}
          location={{ hostId: info.hostId, cwd: info.cwd }}
        />
      </div>
    ),
    [info.hostId, info.cwd],
  );
  const lastLayout = useRef<
    (LiveTranscriptLayout & { turnCount: number }) | undefined
  >(undefined);
  // Only the native reader publishes a new boundary. Recomputing it during a
  // history/status render would pair new history with the previous native view
  // (or bypass a held repaint), visibly alternating two complete documents.
  const nextLayout: LiveTranscriptLayout = publishedLayout.current || {
    historyCount: Math.max(0, turns.length - (turns.at(-1)?.complete ? 0 : 1)),
    nativeStart: 0,
    chromeStart: 0,
    live: false,
  };
  const layout =
    frozen && lastLayout.current
      ? {
          ...lastLayout.current,
          historyCount: lastLayout.current.live
            ? turns.length
            : lastLayout.current.historyCount +
              turns.length -
              lastLayout.current.turnCount,
        }
      : nextLayout;
  lastLayout.current = { ...layout, turnCount: turns.length };
  const running = layout.live && turns.length > 0 && !turns.at(-1)!.complete;
  // Saved steps of a running turn stream in while its CLI works.
  const agentBusy = info.agentState === "working" || waiting || nativeBusy;
  // A newly started turn may not exist in history yet. Keep reading even if
  // the last saved turn is complete; otherwise it can wait for the 30s poll.
  const refreshing = visible && agentBusy;
  useEffect(() => {
    if (!refreshing) return;
    const timer = setInterval(() => void load.current(false, true), 2000);
    return () => clearInterval(timer);
  }, [refreshing]);
  const [workOpen, setWorkOpen] = useState<Record<string, boolean>>({});
  const [workTarget, setWorkTarget] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = body.current,
      saved = anchor.current;
    if (!node || !visible) return;
    if (selectedPrepend.current?.detail === detail) {
      restoreConversationSelection(node, selectedPrepend.current.selection);
      selectedPrepend.current = null;
    } else if (hasSelection()) return;
    if (saved)
      node.scrollTop =
        saved === "bottom"
          ? node.scrollHeight
          : saved.top + node.scrollHeight - saved.height;
    anchor.current = null;
  }, [detail, visible]);
  useLayoutEffect(() => {
    const node = body.current;
    // Opening/closing a native panel changes the reader's viewport, even when
    // its document height is unchanged. Keep an existing bottom follow pinned.
    if (node && visible && followingRef.current && !hasSelection())
      node.scrollTop = node.scrollHeight;
  }, [modSurface, visible]);
  useEffect(() => {
    const node = body.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      // Images, fonts and math can finish layout later than the history response.
      if (following && !hasSelection()) node.scrollTop = node.scrollHeight;
    });
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, [following]);
  const mount = term.element?.parentElement;
  if (!mount) return null;
  return createPortal(
    <section
      className="terminal-conversation"
      role="region"
      aria-label="터미널 출력"
      data-terminal-rich="true"
      data-native-start={layout.nativeStart}
      data-native-live={layout.live ? layout.chromeStart : undefined}
      data-following={following}
      data-selected={selected}
      hidden={!visible}
      data-native-mods={modSurface ? "preserved" : undefined}
      style={
        modSurface
          ? {
              right: "auto",
              bottom: "auto",
              width: modSurface.width,
              height: modSurface.height,
            }
          : undefined
      }
    >
      <div
        className="terminal-conversation-body"
        ref={body}
        onScroll={() => {
          const node = body.current;
          if (!node) return;
          const next =
            node.scrollHeight - node.clientHeight - node.scrollTop < 40;
          followingRef.current = next;
          setFollowing(next);
          if (next && !hasSelection() && pending.current) {
            latest.current = pending.current;
            setDetail(pending.current);
            pending.current = null;
          }
          if (node.scrollTop < 24 && detail?.nextCursor && !error)
            void load.current(true, true);
        }}
      >
        <div className="terminal-conversation-document">
          {pendingHistory && (
            <p className="muted" role="status">
              대화를 불러오는 중…
            </p>
          )}
          {detail?.nextCursor && (
            <button
              className="button secondary small"
              disabled={loading}
              onClick={() => void load.current(true)}
            >
              이전 메시지 더 보기
            </button>
          )}
          {error && (
            <div className="inline-error" role="alert">
              {error}
              <button
                disabled={loading}
                onClick={() => void load.current(retryMore.current)}
              >
                다시 읽기
              </button>
            </div>
          )}
          {historyPaused && (
            <button
              disabled={loading}
              onClick={() => void load.current(retryMore.current)}
            >
              기록 다시 불러오기
            </button>
          )}
          {detail?.notice && <p role="status">{detail.notice}</p>}
          {turns.slice(0, layout.historyCount).map((turn, turnIndex) => {
            const props = {
              provider: provider === "claude" ? "Claude" : "Codex",
              hostId: info.hostId,
              cwd: detail?.thread.cwd || info.cwd,
              sessionId,
              historical: true,
              completed: turn.complete,
              selectionActive: selected,
            };
            const live = running && turnIndex === turns.length - 1;
            // Old records can lack completion metadata. Group their existing
            // work together without claiming completion. Only a trailing saved
            // assistant message stays outside that group. The running turn
            // keeps all of its saved work in a live group, open by default.
            const last = turn.items.at(-1);
            const replyIds = turn.complete
              ? turn.finalIds
              : !live &&
                  turnIndex < turns.length - 1 &&
                  last?.kind === "assistant"
                ? new Set([last.id])
                : new Set<string>();
            const work = turn.items.filter(
              (item) => item.kind !== "user" && !replyIds.has(item.id),
            );
            const state = turn.complete ? "done" : live ? "live" : "saved";
            const workKey = `${turn.id}:${state}`;
            return (
              <section
                key={
                  turn.items.some((item) => item.turnId)
                    ? turn.id
                    : turnKey(turn)
                }
                className={`conversation-turn${live ? " running" : ""}`}
                data-turn-id={turn.id}
              >
                {turn.complete || turnIndex < turns.length - 1 || live ? (
                  <>
                    <TranscriptItems
                      items={turn.items.filter((item) => item.kind === "user")}
                      {...props}
                    />
                    {(!!work.length ||
                      (live &&
                        (agentBusy ||
                          layout.nativeStart < layout.chromeStart))) && (
                      <WorkGroup
                        items={work}
                        state={state}
                        busy={live && agentBusy}
                        open={workOpen[workKey] ?? live}
                        onToggle={(open) =>
                          setWorkOpen((value) => ({
                            ...value,
                            [workKey]: open,
                          }))
                        }
                        target={live ? setWorkTarget : undefined}
                        props={props}
                      />
                    )}
                    <TranscriptItems
                      items={turn.items.filter((item) => replyIds.has(item.id))}
                      {...props}
                    />
                  </>
                ) : (
                  <TranscriptItems items={turn.items} {...props} />
                )}
              </section>
            );
          })}
          <TerminalNativeFlow
            codexComposer={provider === "codex"}
            term={term}
            blocks={blocks}
            active={visible}
            frozen={selected || !following}
            startRow={nativeRange}
            workTarget={running ? workTarget : null}
            onFrame={updateNativeFrame}
            onLink={onLink}
            renderAnswer={renderNativeAnswer}
          />
        </div>
      </div>
      {!following && (
        <button className="conversation-bottom" onClick={resumeFollowing}>
          <ArrowDown size={14} /> 맨 아래로
        </button>
      )}
    </section>,
    mount,
  );
}
