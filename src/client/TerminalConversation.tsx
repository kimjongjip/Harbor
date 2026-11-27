import { providerName as agentLabel } from "../shared/agent-provider";
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
import { transcriptEntries, transcriptSections } from "./transcript-steps";
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
import {
  insetChoiceDialog,
  claudeWorkTimer,
  nativeInteractiveReplacement,
  nativeMenuVisible,
} from "./terminal-native-chrome";

export type ConversationMode = "auto" | "conversation" | "terminal";
const emptyBlocks: RichTerminalBlock[] = [];
const emptyTimeline: NonNullable<HistoryDetail["timeline"]> = [];
const turnKey = (turn: ReturnType<typeof conversationTurns>[number]) => {
  const last = turn.items.at(-1)!;
  return `${last.kind}:${last.id}`;
};
/** A consecutive run of tool records; progress reports remain outside. */
const WorkGroup = memo(function WorkGroup({
  items,
  state,
  busy = false,
  open,
  onToggle,
  props,
}: {
  items: TranscriptItemsProps["items"];
  state: "live" | "done" | "saved";
  /** The CLI is visibly working on this turn (not merely unverified). */
  busy?: boolean;
  open: boolean;
  onToggle(open: boolean): void;
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
  nativeWhileWorking = false,
  mirroredCrew,
  mode = "auto",
  blocks = emptyBlocks,
  active = true,
  onLink,
}: {
  term: Terminal;
  info: TerminalInfo;
  /** A read-only recovery must not be mistaken for the terminal's input binding. */
  historySessionId?: string;
  nativeWhileWorking?: boolean;
  mirroredCrew?: string;
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
  const lastScrollTop = useRef(0);
  const scrollIntentUntil = useRef(0);
  const scrollDownUntil = useRef(0);
  const noteScrollIntent = () => { scrollIntentUntil.current = performance.now() + 1200; };
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
  const firstRead = useRef(true),
    provisional = useRef(false);
  const apply = (result: HistoryDetail, more: boolean, replace = false) => {
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
    const next = replace
      ? result
      : merge(more ? latest.current : pending.current || latest.current);
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
        state.current.mode === "terminal")
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
      const desktopReader = !!window.harborDesktop?.workspaceTabs;
      if (desktopReader && !more) {
        params.set("terminalView", info.id);
        if (firstRead.current) params.set("reopen", "1");
      }
      firstRead.current = false;
      let snapshot = false;
      const result = await api<HistoryDetail>(
        `/hosts/${encodeURIComponent(info.hostId)}/history/${encodeURIComponent(sessionId)}?${params}`,
        undefined,
        "GET",
        AbortSignal.any([controller.signal, AbortSignal.timeout(65000)]),
        desktopReader
          ? (response) => {
              snapshot =
                response.headers.get("X-Harbor-History-Snapshot") === "1";
            }
          : undefined,
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
      apply(
        result,
        more,
        !more && !loadedOlder.current && provisional.current && !snapshot,
      );
      if (!more) provisional.current = snapshot;
      if (snapshot) refreshQueued.current = true;
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
    firstRead.current = true;
    provisional.current = false;
    latest.current = null;
    pending.current = null;
    loadedOlder.current = false;
    refreshQueued.current = false;
    olderQueued.current = false;
    olderCursors.current.clear();
    selectedPrepend.current = null;
    setSelected(false);
    followingRef.current = true;
    lastScrollTop.current = 0;
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
    window.addEventListener("focus", visible);
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
      window.removeEventListener("focus", visible);
    };
  }, [info.id, info.hostId, sessionId, provider]);
  // Completion and native-state notifications refresh without requiring a scroll or mousemove.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (refreshTimer.current !== undefined) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined;
      void load.current(false, true);
    }, 160);
  }, [blocks, info.agentState, info.agentCompletion?.textHash, active, mode]);
  useEffect(() => () => { clearTimeout(refreshTimer.current); refreshTimer.current = undefined; }, []);
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
    node.ownerDocument.addEventListener("visibilitychange", changed);
    window.addEventListener("focus", changed);
    return () => {
      dispose();
      node.ownerDocument.removeEventListener("selectionchange", changed);
      node.ownerDocument.removeEventListener("visibilitychange", changed);
      window.removeEventListener("focus", changed);
    };
  }, [term]);
  const resumeFollowing = () => {
    followingRef.current = true;
    scrollIntentUntil.current = 0;
    scrollDownUntil.current = 0;
    setFollowing(true);
    if (!hasSelection() && pending.current) {
      latest.current = pending.current;
      setDetail(pending.current);
      pending.current = null;
    }
    anchor.current = "bottom";
    if (body.current) {
      body.current.scrollTop = body.current.scrollHeight;
      lastScrollTop.current = body.current.scrollTop;
    }
  };
  useEffect(() => {
    const input = term.onData?.((data) => {
      // onData also carries focus changes, mouse reports and terminal replies.
      // Only text edits or submission should take the reader back to the prompt.
      const editsPrompt =
        /^[^\x00-\x1f\x7f-\x9f]/u.test(data) ||
        data === "\r" ||
        data === "\b" ||
        data === "\x7f" ||
        data === "\x1b[3~" ||
        (data.startsWith("\x1b[200~") &&
          data.endsWith("\x1b[201~") &&
          data.length > 12);
      if (!editsPrompt) return;
      if (hasSelection()) {
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
  const automaticView = active && mode !== "terminal";
  // Completion is verified from the saved turn, never inferred from an idle
  // composer or an approval dialog waiting for input.
  const waiting = info.agentState === "waiting";
  // Keep one surface for the whole turn. Spinner frames, tool waits and a
  // transient idle event cannot prove that a submitted turn has finished.
  const lastTurn = computedTurns.at(-1);
  const tail = lastTurn?.items.at(-1);
  const ended = lastTurn?.complete || tail?.turnStatus === "failed" || tail?.turnStatus === "interrupted";
  const endKey = ended ? JSON.stringify([lastTurn?.id, tail?.id, tail?.turnStatus]) : undefined;
  const unfinished = !!lastTurn && !ended && (tail?.kind === "user" || tail?.turnStatus === "inProgress" || info.agentState === "working");
  const [nativeTurn, setNativeTurn] = useState(false);
  const baseline = useRef<string | undefined>(undefined);
  const wasWorking = useRef(false);
  const observedTurn = useRef(false);
  useLayoutEffect(() => {
    const working = info.agentState === "working";
    if (!nativeWhileWorking || info.exited) {
      wasWorking.current = false;
      observedTurn.current = false;
      setNativeTurn(false);
      return;
    }
    if (!nativeTurn && !frozen && (unfinished || (working && !wasWorking.current))) {
      baseline.current = endKey;
      observedTurn.current = unfinished;
      setNativeTurn(true);
    } else if (nativeTurn) {
      if (unfinished) observedTurn.current = true;
      if (endKey && (observedTurn.current || endKey !== baseline.current)) {
        // A history read while attaching can still describe the previous reply.
        if (!observedTurn.current && baseline.current === undefined && working) {
          baseline.current = endKey;
        } else {
          const timer = setTimeout(() => setNativeTurn(false), 750);
          wasWorking.current = working;
          return () => clearTimeout(timer);
        }
      }
    }
    if (!frozen || nativeTurn) wasWorking.current = working;
  }, [nativeWhileWorking, nativeTurn, unfinished, endKey, info.agentState, info.exited, frozen]);
  const visible = automaticView;
  // Keep completed turns in the same DOM (including selections and tables).
  // Keep saved questions and tool records; active assistant prose belongs to
  // the PTY tail until it has a verified final answer.
  const displayTurns = useMemo(() => {
    const last = turns.at(-1);
    if (!nativeTurn || !last || last.complete) return turns;
    const saved = last.items.filter(item => item.kind !== "assistant");
    return saved.length
      ? [...turns.slice(0, -1), {...last, items: saved}]
      : turns.slice(0, -1);
  }, [turns, nativeTurn]);
  const pendingHistory = !detail && !error;
  // Echoed keystrokes belong to the native tail. They must not rerender every
  // saved Markdown/tool block or schedule a second full native capture.
  const navigatingHistory = useRef(false);
  const layoutForFrame = useMemo(() => {
    let cachedFrame: NativeFlowFrame | undefined;
    let cachedLayout: LiveTranscriptLayout;
    return (frame: NativeFlowFrame) => {
      if (frame !== cachedFrame) {
        cachedFrame = frame;
        cachedLayout = liveTranscriptLayout(
          displayTurns,
          frameWithoutModPanels(term, frame, modSurface?.native),
          blocks,
          {
            waiting,
            pendingHistory,
            provider,
            navigatingHistory: navigatingHistory.current,
          },
        );
      }
      return cachedLayout;
    };
  }, [displayTurns, blocks, waiting, pendingHistory, term, modSurface, provider]);
  const publishedLayout = useRef<LiveTranscriptLayout | undefined>(undefined);
  const [nativeBusy, setNativeBusy] = useState(false);
  const publishedBuffer = useRef<NativeFlowFrame["bufferType"] | undefined>(
    undefined,
  );
  const [nativeMenu, setNativeMenu] = useState(false);
  const menuVisible = useRef(false);
  const requestedMenu = useRef(false);
  useEffect(() => {
    if (!active || mode === "terminal" || info.exited) return;
    const subscription = term.onData((data) => {
      if (data === "/") requestedMenu.current = true;
      if (data === "\x1b" || data === "\r" || data === "\x03") requestedMenu.current = false;
      if (/^\x1b(?:\[|O)[AB]$/.test(data))
        navigatingHistory.current = !menuVisible.current;
      else if (
        data === "\r" ||
        data === "\x1b" ||
        data === "\x03" ||
        data === "/"
      )
        navigatingHistory.current = false;
    });
    return () => subscription.dispose();
  }, [term, active, mode, info.exited]);
  useLayoutEffect(() => {
    publishedLayout.current = undefined;
    publishedBuffer.current = undefined;
    navigatingHistory.current = false;
    menuVisible.current = false;
    setNativeMenu(false);
  }, [term, info.id, info.hostId, sessionId, provider, mode, info.exited]);
  const revealInsetDialog = useCallback(
    (frame?: NativeFlowFrame) => {
      if (
        provider !== "codex" ||
        !insetChoiceDialog(term.buffer.active, frame?.lines)
      )
        return false;
      if (!menuVisible.current) {
        menuVisible.current = true;
        setNativeMenu(true);
      }
      return true;
    },
    [provider, term],
  );
  const nativeRange = useCallback(
    (frame: NativeFlowFrame) => {
      if (revealInsetDialog(frame))
        return { start: frame.end, defer: "repaint" as const };
      const next = layoutForFrame(frame);
      const menu =
        !next.promptHistory && (!nativeTurn || requestedMenu.current || menuVisible.current) &&
        nativeMenuVisible(frame.lines, frame.end, frame, menuVisible.current);
      if (menu !== menuVisible.current) {
        menuVisible.current = menu;
        setNativeMenu(menu);
      }
      if (menu) return { start: frame.end, defer: "repaint" as const };
      return {
        start: next.nativeStart,
        streamingOutput: provider === "antigravity" && next.live &&
          (!!turns.length && !turns.at(-1)?.complete || info.agentState === "working"),
        promptHistory: next.promptHistory,
        split: next.live ? next.chromeStart : next.nativeStart,
        end: modSurface?.native.end,
        panels: modSurface?.native.panels,
        // SSH/PTY chunks need not align with a complete CLI repaint. Losing
        // its footer briefly must not unmount saved work and expose the raw
        // screen on every animation/status refresh. Only a positively recognized
        // dialog, shell/exit or buffer switch can replace the committed reader.
        defer:
          publishedLayout.current?.live && !next.live &&
          !(turns.at(-1)?.complete && next.historyCount === turns.length && next.nativeStart > 0)
            ? !info.exited &&
              publishedBuffer.current === frame.bufferType &&
              !nativeInteractiveReplacement(
                frame.lines,
                frame.end,
                info.agentState === "waiting" ||
                  (info.agentState !== "working" && !nativeBusy),
              )
              ? ("repaint" as const)
              : true
            : false,
      };
    },
    [
      layoutForFrame,
      modSurface,
      info.exited,
      info.agentState,
      nativeBusy,
      turns,
      revealInsetDialog,
      nativeTurn,
      provider,
    ],
  );
  // A running CLI shows "esc to interrupt" in its live area even when no
  // native event reported working (poll-only sessions).
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
  const observeNativeCompletion = useCallback(
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
    }, [completionCue, provider, term, modSurface],
  );
  const updateNativeFrame = useCallback(
    (frame: NativeFlowFrame) => {
      const next = layoutForFrame(frame);
      const current = publishedLayout.current;
      publishedBuffer.current = frame.bufferType;
      if (
        !current ||
        next.historyCount !== current.historyCount ||
        next.promptHistory !== current.promptHistory ||
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
          .some((line) => line.includes("esc to interrupt") || (provider === "claude" && claudeWorkTimer(line)));
      setNativeBusy((value) => (value === busy ? value : busy));
    },
    [layoutForFrame,provider],
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
  // History polls continue during recall. Publish them together with the
  // current native activity when the user returns to the ordinary composer.
  const lastBody = useRef<
    { turns: typeof turns; count: number; live: boolean } | undefined
  >(undefined);
  if (!layout.promptHistory || !lastBody.current)
    lastBody.current = nativeTurn
      ? {turns: displayTurns, count: displayTurns.length, live: true}
      : { turns, count: layout.historyCount, live: layout.live };
  const shown = lastBody.current;
  // Compare against what is actually on screen (including a frozen history
  // view), not every message in the most recently fetched page.
  const renderedAnswers = useMemo(() => {
    if (provider !== "claude" || !sessionId) return;
    const messages = new Map<string, string>();
    for (const turn of shown.turns.slice(0, shown.count))
      for (const item of turn.items)
        if (item.kind === "assistant") messages.set(item.id, item.text);
    return { sessionId, messages };
  }, [provider, sessionId, shown.turns, shown.count]);
  const running =
    shown.live && shown.turns.length > 0 && !shown.turns.at(-1)!.complete;
  // Saved steps of a running turn stream in while its CLI works.
  const agentBusy = info.agentState === "working" || waiting || nativeBusy;
  // A newly started turn may not exist in history yet. Keep reading even if
  // the last saved turn is complete; otherwise it can wait for the 30s poll.
  const refreshing = automaticView && (nativeTurn || agentBusy || !!info.nativeAgySessionId);
  useEffect(() => {
    if (!refreshing) return;
    const timer = setInterval(() => void load.current(false, true), info.nativeAgySessionId ? 3500 : 2000);
    return () => clearInterval(timer);
  }, [refreshing, info.nativeAgySessionId]);
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
    if (saved && (saved !== "bottom" || followingRef.current)) {
      node.scrollTop =
        saved === "bottom"
          ? node.scrollHeight
          : saved.top + node.scrollHeight - saved.height;
      lastScrollTop.current = node.scrollTop;
    }
    anchor.current = null;
  }, [detail, visible]);
  useLayoutEffect(() => {
    const node = body.current;
    // Opening/closing a native panel changes the reader's viewport, even when
    // its document height is unchanged. Keep an existing bottom follow pinned.
    if (node && visible && followingRef.current && !hasSelection()) {
      node.scrollTop = node.scrollHeight;
      lastScrollTop.current = node.scrollTop;
    }
  }, [modSurface, visible]);
  function trackReadingPosition(node: HTMLDivElement) {
    if (!visible || menuVisible.current || !node.clientHeight) return;
    const moved = Math.abs(node.scrollTop - lastScrollTop.current) > 1;
    lastScrollTop.current = node.scrollTop;
    if (moved && (performance.now() < scrollIntentUntil.current || hasSelection()) && followingRef.current && node.scrollHeight - node.clientHeight - node.scrollTop >= 40) {
      followingRef.current = false;
      setFollowing(false);
    }
  }
  useEffect(() => {
    const node = body.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      // Images, fonts and math can finish layout later than the history response.
      trackReadingPosition(node);
      if (visible && followingRef.current && !hasSelection()) {
        node.scrollTop = node.scrollHeight;
        lastScrollTop.current = node.scrollTop;
      }
    });
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, [following, visible, term]);
  const mount = term.element?.parentElement;
  if (!mount) return null;
  return createPortal(
    <section
      className="terminal-conversation"
      role="region"
      aria-label="터미널 출력"
      data-terminal-rich="true"
      data-native-work={nativeTurn || undefined}
      data-native-start={layout.nativeStart}
      data-native-live={layout.live ? layout.chromeStart : undefined}
      data-following={following}
      data-selected={selected}
      hidden={!visible || nativeMenu}
      data-native-menu={visible && nativeMenu ? true : undefined}
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
        onWheelCapture={event => {
          if (event.deltaY < 0) { noteScrollIntent(); scrollDownUntil.current = 0; }
          if (event.deltaY > 0) {
            scrollDownUntil.current = performance.now() + 1000;
            const node=event.currentTarget;
            if (!followingRef.current && !hasSelection() && node.scrollHeight-node.clientHeight-node.scrollTop<=1)
              resumeFollowing();
          }
        }}
        onTouchMoveCapture={noteScrollIntent}
        onPointerDownCapture={event => { if (event.target === event.currentTarget || event.button === 1) noteScrollIntent(); }}
        onPointerMoveCapture={event => { if(event.buttons && (event.target === event.currentTarget || hasSelection())) noteScrollIntent(); }}
        onKeyDownCapture={event => { if(["PageUp","Home","ArrowUp"].includes(event.key)) noteScrollIntent(); }}
        onScroll={() => {
          if (!visible || menuVisible.current) return;
          const node = body.current;
          if (!node || !node.clientHeight) return;
          trackReadingPosition(node);
          if (!followingRef.current && performance.now() < scrollDownUntil.current &&
              !hasSelection() && node.scrollHeight - node.clientHeight - node.scrollTop <= 1) resumeFollowing();
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
          {shown.turns.slice(0, shown.count).map((turn, turnIndex) => {
            const props = {
              provider: agentLabel(provider),
              hostId: info.hostId,
              cwd: detail?.thread.cwd || info.cwd,
              sessionId,
              historical: true,
              completed: turn.complete,
              selectionActive: selected,
            };
            const live = running && turnIndex === shown.turns.length - 1;
            const state = turn.complete ? "done" : live ? "live" : "saved";
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
                {transcriptSections(turn.items).map((section) => {
                  const workKey = `${turn.id}:${state}:${section.key}`;
                  return section.kind === "work" ? (
                    <WorkGroup
                      key={section.key}
                      items={section.items}
                      state={state}
                      busy={live && agentBusy}
                      open={workOpen[workKey] ?? live}
                      onToggle={(open) =>
                        setWorkOpen((value) => ({
                          ...value,
                          [workKey]: open,
                        }))
                      }
                      props={props}
                    />
                  ) : (
                    <TranscriptItems
                      key={section.key}
                      items={section.items}
                      {...props}
                    />
                  );
                })}
              </section>
            );
          })}
          {/* Unsaved live prose must stay visible when saved tools are folded. */}
          <div className="conversation-live-work" ref={setWorkTarget} />
          <TerminalNativeFlow
            renderedAnswers={renderedAnswers}
            codexComposer={provider === "codex"}
            agyComposer={provider === "antigravity"}
            historyIdentity={turns}
            mirroredCrew={mirroredCrew}
            term={term}
            blocks={blocks}
            active={visible}
            frozen={!nativeMenu && (selected || !following)}
            nativeInteraction={nativeMenu}
            onFrozenFrame={provider === "codex" ? revealInsetDialog : undefined}
            startRow={nativeRange}
            workTarget={running ? workTarget : null}
            observeFrame={observeNativeCompletion}
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
