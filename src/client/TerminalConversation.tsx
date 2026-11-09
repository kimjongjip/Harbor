import {
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
import { TranscriptItems } from "./TranscriptItems";
import { TerminalNativeFlow, type NativeFlowFrame } from "./TerminalNativeFlow";
import { transcriptBoundary } from "./terminal-transcript-boundary";
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

export type ConversationMode = "auto" | "conversation" | "terminal";
const emptyBlocks: RichTerminalBlock[] = [];
const emptyTimeline: NonNullable<HistoryDetail["timeline"]> = [];
const turnKey = (turn: ReturnType<typeof conversationTurns>[number]) => {
  const last = turn.items.at(-1)!;
  return `${last.kind}:${last.id}`;
};
/** One terminal document: persisted work and native live output/input share one scroller. */
export function TerminalConversation({
  term,
  info,
  mode = "auto",
  blocks = emptyBlocks,
  active = true,
  onLink,
}: {
  term: Terminal;
  info: TerminalInfo;
  onClose?(): void;
  mode?: ConversationMode;
  blocks?: RichTerminalBlock[];
  active?: boolean;
  onLink?(text: string): void;
}) {
  const sessionId = info.agentSessionId || info.resumeThreadId;
  const provider =
    info.agentKind || (info.program?.startsWith("claude") ? "claude" : "codex");
  const [detail, setDetail] = useState<HistoryDetail | null>(null);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [historyPaused, setHistoryPaused] = useState(false),
    [selected, setSelected] = useState(false);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(following);
  followingRef.current = following;
  const nativeFrame = useRef<NativeFlowFrame | undefined>(undefined);
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
  latest.current = detail;
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
    setDetail(next);
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
    const input = term.onData?.(() => {
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
  const working = info.agentState !== "idle";
  // Echoed keystrokes belong to the native tail. They must not rerender every
  // saved Markdown/tool block or schedule a second full native capture.
  const boundaryForFrame = useMemo(() => {
    let cachedFrame: NativeFlowFrame | undefined;
    let cachedBoundary: ReturnType<typeof transcriptBoundary>;
    return (frame: NativeFlowFrame) => {
      if (frame !== cachedFrame) {
        cachedFrame = frame;
        cachedBoundary = transcriptBoundary(turns, frame, blocks, working);
      }
      return cachedBoundary;
    };
  }, [turns, blocks, working]);
  const startNativeRow = useCallback(
    (frame: NativeFlowFrame) => boundaryForFrame(frame).nativeStart,
    [boundaryForFrame],
  );
  const publishedBoundary = useRef<
    ReturnType<typeof transcriptBoundary> | undefined
  >(undefined);
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
      nativeFrame.current = frame;
      // Some existing Codex sessions have no peer event transport. A new native
      // footer merely asks for a read; saved turn status still decides folding.
      if (provider === "codex" && completionCue.detector.observe(frame.lines)) {
        completionCue.timers.forEach(clearTimeout);
        // The footer can arrive before the persisted turn becomes completed.
        // Retry a bounded number of times without requiring more native output.
        completionCue.timers = [200, 1200, 3000].map((delay) =>
          setTimeout(() => void load.current(false, true), delay),
        );
      }
      const next = boundaryForFrame(frame);
      if (
        next.historyCount !== publishedBoundary.current?.historyCount ||
        next.nativeStart !== publishedBoundary.current?.nativeStart
      ) {
        publishedBoundary.current = next;
        setBoundaryRevision((value) => value + 1);
      }
    },
    [boundaryForFrame, completionCue, provider],
  );
  const renderNativeAnswer = useCallback(
    (text: string) => <pre className="terminal-native-answer-text">{text}</pre>,
    [],
  );
  const lastBoundary = useRef<
    { historyCount: number; nativeStart: number; turnCount: number } | undefined
  >(undefined);
  const nextBoundary = nativeFrame.current
    ? boundaryForFrame(nativeFrame.current)
    : {
        historyCount: Math.max(
          0,
          turns.length - (turns.at(-1)?.complete ? 0 : 1),
        ),
        nativeStart: 0,
      };
  publishedBoundary.current = nextBoundary;
  const boundary =
    frozen && lastBoundary.current
      ? {
          historyCount:
            lastBoundary.current.historyCount +
            turns.length -
            lastBoundary.current.turnCount,
          nativeStart: lastBoundary.current.nativeStart,
        }
      : nextBoundary;
  lastBoundary.current = { ...boundary, turnCount: turns.length };
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
      data-native-start={boundary.nativeStart}
      data-following={following}
      data-selected={selected}
      hidden={!visible}
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
          {turns.slice(0, boundary.historyCount).map((turn, turnIndex) => {
            const props = {
              provider: provider === "claude" ? "Claude" : "Codex",
              hostId: info.hostId,
              cwd: detail?.thread.cwd || info.cwd,
              sessionId,
              historical: true,
              completed: turn.complete,
              selectionActive: selected,
            };
            // Old records can lack completion metadata. Group their existing
            // work together without claiming completion. Only a trailing saved
            // assistant message stays outside that group; an active unknown
            // turn is kept wholly native by transcriptBoundary.
            const last = turn.items.at(-1);
            const replyIds = turn.complete
              ? turn.finalIds
              : turnIndex < turns.length - 1 && last?.kind === "assistant"
                ? new Set([last.id])
                : new Set<string>();
            const work = turn.items.filter(
              (item) => item.kind !== "user" && !replyIds.has(item.id),
            );
            return (
              <section
                key={turnKey(turn)}
                className="conversation-turn"
                data-turn-id={turn.id}
              >
                {turn.complete || turnIndex < turns.length - 1 ? (
                  <>
                    <TranscriptItems
                      items={turn.items.filter((item) => item.kind === "user")}
                      {...props}
                    />
                    {!!work.length && (
                      <details className="conversation-work">
                        <summary>
                          {turn.complete ? "작업 과정" : "저장된 작업"}{" "}
                          {work.length}개
                        </summary>
                        <TranscriptItems items={work} {...props} />
                      </details>
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
            startRow={startNativeRow}
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
