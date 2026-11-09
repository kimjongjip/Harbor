import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { MobileConversationPage } from "../../shared/mobile";
import type { RichTerminalBlock } from "../../shared/rich-terminal";
import { isLegacyClaudeHistoryLimit } from "../history-errors";

type Item = MobileConversationPage["items"][number];
const itemKey = (item: Item) => `${item.kind}:${item.turnId || ""}:${item.id}`;
export function mergeConversation(
  old: Item[],
  incoming: Item[],
  older: boolean,
) {
  const incomingById = new Map(incoming.map((item) => [itemKey(item), item]));
  const present = new Set(old.map(itemKey));
  // Native logs can repeat one UUID as an answer grows. An older byte page
  // must never replace the newer complete message already on the phone.
  const updated = older
    ? old
    : old.map((item) => incomingById.get(itemKey(item)) || item);
  const added = incoming.filter((item) => !present.has(itemKey(item)));
  return older ? [...added, ...updated] : [...updated, ...added];
}

export function MobileConversation({
  terminalId,
  sessionId,
  active,
  blocks,
  answerId,
  revision,
  scroller,
  following,
  renderText,
  embeddedBefore,
}: {
  terminalId: string;
  sessionId?: string;
  active: boolean;
  blocks: RichTerminalBlock[];
  answerId: string;
  revision: number;
  scroller: RefObject<HTMLDivElement | null>;
  following: RefObject<boolean>;
  embeddedBefore?: string[];
  renderText(text: string): ReactNode;
}) {
  const [items, setItems] = useState<Item[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false),
    [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(""),
    [legacy, setLegacy] = useState(false),
    [retry, setRetry] = useState(0);
  const [provider, setProvider] = useState("AI");
  const [notice, setNotice] = useState("");
  const [historyPaused, setHistoryPaused] = useState(false);
  const paused = useRef(false);
  const request = useRef<(older: boolean) => Promise<void>>(async () => {});
  const cursorRef = useRef<string | null>(null),
    busy = useRef(false),
    loadedOlder = useRef(false);
  const anchor = useRef<
    { key?: string; y: number; height: number; top: number } | undefined
  >(undefined);
  const jumped = useRef("");
  const root = useRef<HTMLDivElement>(null);
  const previousHeight = useRef(0);
  const embedded = embeddedBefore !== undefined;
  // The terminal history belongs to the frozen reading frame. A new reply or
  // reconnect must not append below the reader and push their position down.
  const frozenBlocks = useRef<RichTerminalBlock[] | undefined>(undefined);
  if (embedded && blocks.length && !frozenBlocks.current)
    frozenBlocks.current = blocks;
  const historyBlocks = embedded ? frozenBlocks.current || blocks : blocks;
  const refreshRevision = embedded ? 0 : revision;
  const firstVisible = embeddedBefore?.length
    ? items.findIndex(
        (item) =>
          item.kind === "assistant" && embeddedBefore.includes(item.text),
      )
    : -1;
  const visibleItems = firstVisible < 0 ? items : items.slice(0, firstVisible);
  const firstBlock = embeddedBefore?.length
    ? historyBlocks.findIndex((block) => embeddedBefore.includes(block.text))
    : -1;
  const visibleBlocks =
    firstBlock < 0 ? historyBlocks : historyBlocks.slice(0, firstBlock);
  useEffect(() => {
    if (!active || !terminalId || !sessionId || paused.current) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    busy.current = false;
    const load = async (older: boolean) => {
      if (
        stopped ||
        paused.current ||
        busy.current ||
        document.visibilityState === "hidden"
      )
        return;
      const next = older ? cursorRef.current : undefined;
      if (older && !next) return;
      busy.current = true;
      setLoading(true);
      setError("");
      try {
        const query = new URLSearchParams({
          sessionId,
          ...(next ? { cursor: next } : {}),
        });
        const response = await fetch(
          `/mobile-api/terminals/${terminalId}/conversation?${query}`,
          {
            credentials: "same-origin",
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(65000),
            ]),
          },
        );
        if (response.status === 404) {
          if (!stopped) setLegacy(true);
          return;
        }
        const page: MobileConversationPage & { error?: string } =
          await response.json();
        if (!response.ok)
          throw new Error(page.error || "대화 기록을 불러오지 못했습니다.");
        if (stopped || page.sessionId !== sessionId) return;
        if (older && page.nextCursor === next)
          throw new Error(
            "이전 대화 페이지를 불러오지 못했습니다. 다시 시도하세요.",
          );
        const node = scroller.current;
        if (older && node && !embedded) {
          const visible = [
            ...node.querySelectorAll<HTMLElement>("[data-message-key]"),
          ].find(
            (el) =>
              el.getBoundingClientRect().bottom >=
              node.getBoundingClientRect().top,
          );
          anchor.current = {
            key: visible?.dataset.messageKey,
            y: visible?.getBoundingClientRect().top || 0,
            height: node.scrollHeight,
            top: node.scrollTop,
          };
        }
        if (older) loadedOlder.current = true;
        setItems((old) => mergeConversation(old, page.items, older));
        if (older || !loadedOlder.current) {
          cursorRef.current = page.nextCursor;
          setCursor(page.nextCursor);
        }
        setProvider(page.provider === "claude" ? "Claude" : "Codex");
        if (page.notice) setNotice(page.notice);
        setLoaded(true);
        setLegacy(false);
      } catch (e) {
        if (!stopped) {
          if (isLegacyClaudeHistoryLimit(e)) {
            paused.current = true;
            setHistoryPaused(true);
          } else setError((e as Error).message);
        }
      } finally {
        if (!stopped) {
          busy.current = false;
          setLoading(false);
        }
      }
    };
    request.current = load;
    const poll = async () => {
      await load(false);
      if (!stopped && !paused.current && !embedded)
        timer = setTimeout(poll, 10000);
    };
    void poll();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
      request.current = async () => {};
    };
  }, [
    active,
    terminalId,
    sessionId,
    refreshRevision,
    retry,
    scroller,
    embedded,
  ]);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node || !active) return;
    if (embedded) {
      const height = root.current?.getBoundingClientRect().height || 0;
      if (!following.current) node.scrollTop += height - previousHeight.current;
      previousHeight.current = height;
      return;
    }
    const saved = anchor.current;
    if (saved) {
      const same = [
        ...node.querySelectorAll<HTMLElement>("[data-message-key]"),
      ].find((el) => el.dataset.messageKey === saved.key);
      node.scrollTop = same
        ? node.scrollTop + same.getBoundingClientRect().top - saved.y
        : saved.top + node.scrollHeight - saved.height;
      anchor.current = undefined;
    } else if (answerId && jumped.current !== answerId) {
      const block = blocks.find((block) => block.id === answerId);
      const item = items.find(
        (item) => item.kind === "assistant" && item.text === block?.text,
      );
      const element = item
        ? [...node.querySelectorAll<HTMLElement>("[data-message-key]")].find(
            (el) => el.dataset.messageKey === itemKey(item),
          )
        : document.getElementById(`mobile-answer-${answerId}`);
      if (element) {
        node.scrollTop +=
          element.getBoundingClientRect().top -
          node.getBoundingClientRect().top;
        jumped.current = answerId;
      }
    } else if (following.current) node.scrollTop = node.scrollHeight;
  }, [
    items,
    blocks,
    active,
    answerId,
    legacy,
    scroller,
    following,
    embedded,
    firstVisible,
    firstBlock,
    loading,
    error,
  ]);

  useEffect(() => {
    const node = scroller.current;
    if (
      !node ||
      !active ||
      !loaded ||
      !cursor ||
      error ||
      loading ||
      historyPaused
    )
      return;
    const more = () => {
      if (node.scrollTop < 180) void request.current(true);
    };
    node.addEventListener("scroll", more, { passive: true });
    const frame = requestAnimationFrame(more);
    return () => {
      node.removeEventListener("scroll", more);
      cancelAnimationFrame(frame);
    };
  }, [active, cursor, loaded, loading, error, scroller, historyPaused]);
  useEffect(() => {
    if (!answerId) jumped.current = "";
  }, [answerId]);
  if (!active) return null;
  return (
    <div ref={root} className={embedded ? "terminal-history" : undefined}>
      {legacy && (
        <p className="conversation-notice" role="status">
          질문이 포함된 대화 기록은 PC Harbor를 업데이트한 뒤 다시 실행하면
          사용할 수 있습니다. 현재는 수집된 답변을 표시합니다.
        </p>
      )}
      {!sessionId && (
        <p className="conversation-notice">
          이 터미널에서 Codex 또는 Claude 대화가 연결되면 질문과 답변을 볼 수
          있습니다.
        </p>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          <button
            onClick={() => {
              setRetry((value) => value + 1);
            }}
          >
            다시 불러오기
          </button>
        </p>
      )}
      {notice && (
        <p className="conversation-notice" role="status">
          {notice}
        </p>
      )}
      {historyPaused && (
        <button
          onClick={() => {
            paused.current = false;
            setHistoryPaused(false);
            setRetry((value) => value + 1);
          }}
        >
          기록 다시 불러오기
        </button>
      )}
      {!legacy && !historyPaused && sessionId && (
        <p className="conversation-boundary" aria-live="polite">
          {loading
            ? "대화를 불러오는 중…"
            : loaded && !cursor
              ? "대화의 시작"
              : "위로 올리면 이전 대화를 불러옵니다"}
        </p>
      )}
      {!legacy &&
        visibleItems.map((item) => (
          <article
            className={`conversation-message message-${item.kind}`}
            key={itemKey(item)}
            data-message-key={itemKey(item)}
          >
            <header>{item.kind === "user" ? "나" : provider}</header>
            {item.kind === "user" ? (
              <div className="question-text">{item.text}</div>
            ) : (
              renderText(item.text)
            )}
            {!!item.imageCount && (
              <small>첨부 이미지 {item.imageCount}개</small>
            )}
          </article>
        ))}
      {(legacy || (historyPaused && !visibleItems.length)) &&
        visibleBlocks.map((block) => (
          <article
            className="conversation-message message-assistant"
            key={block.id}
            id={`mobile-answer-${block.id}`}
          >
            <header>AI</header>
            {renderText(block.text)}
          </article>
        ))}
      {loaded && !historyPaused && !items.length && (
        <p className="conversation-notice">
          {cursor
            ? "이 구간에는 표시할 질문과 답변이 없습니다. 위로 올려 이전 대화를 계속 불러올 수 있습니다."
            : "아직 저장된 질문과 답변이 없습니다. 진행 중인 출력은 터미널에서 볼 수 있습니다."}
        </p>
      )}
    </div>
  );
}
