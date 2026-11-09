import { memo, useEffect, useRef, useState } from "react";
import type { MessageItem } from "../shared/types";
import { api } from "./api";
import { Markdown } from "./RichMarkdown";
import "./transcript-items.css";

export interface TranscriptItemsProps {
  items: MessageItem[];
  provider: string;
  hostId: string;
  cwd: string;
  sessionId?: string;
  completed?: boolean;
  historical?: boolean;
  selectionActive?: boolean;
}

const TranscriptMessage = memo(function TranscriptMessage({
  item,
  provider,
  hostId,
  cwd,
}: Omit<TranscriptItemsProps, "items"> & { item: MessageItem }) {
  return (
    <article
      className={`history-message transcript-message ${item.kind}`}
      data-history-message={item.id}
      data-rich-block={`conversation-${item.kind}-${item.id}`}
      data-terminal-rich="true"
    >
      {(item.kind === "user" || item.kind === "assistant") && (
        <b>{item.kind === "user" ? "나" : provider}</b>
      )}
      {!!item.imageCount && <small>이미지 {item.imageCount}개</small>}
      <div className="conversation-message-content">
        {item.kind === "user" ? (
          <div className="conversation-question">{item.text}</div>
        ) : item.kind === "assistant" ? (
          <Markdown text={item.text} location={{ hostId, cwd }} />
        ) : (
          <pre>
            {item.text}
            {item.detail ? `\n${item.detail}` : ""}
          </pre>
        )}
      </div>
    </article>
  );
});

const WorkDisclosure = memo(function WorkDisclosure({
  item,
  completed = false,
  historical = false,
  selectionActive = false,
  sessionId,
  ...props
}: Omit<TranscriptItemsProps, "items"> & { item: MessageItem }) {
  const [automaticOpen, setAutomaticOpen] = useState(!completed && !historical);
  const [manualOpen, setManualOpen] = useState<boolean>();
  // Do not replace a selected work block while an output/completion arrives.
  useEffect(() => {
    if (!selectionActive) setAutomaticOpen(!completed && !historical);
  }, [completed, historical, selectionActive]);
  const open = manualOpen ?? automaticOpen;
  const ref = item.activityRef;
  const identity = `${props.hostId}:${sessionId}:${props.provider}:${item.kind}:${item.id}`;
  const scope = `${identity}:${ref}`;
  const [full, setFull] = useState<{
    scope: string;
    text: string;
    nextOffset: number | null;
  }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | undefined>(undefined);
  const busy = useRef(false);
  const selection = useRef(selectionActive);
  selection.current = selectionActive;
  const pending = useRef<typeof full>(undefined);
  const current = full?.scope === scope ? full : undefined;
  const load = async (offset = 0) => {
    if (!sessionId || !ref || busy.current) return;
    const controller = new AbortController();
    request.current = controller;
    busy.current = true;
    setLoading(true);
    setError("");
    try {
      const page = await api<{
        text: string;
        offset: number;
        nextOffset: number | null;
        total: number;
      }>(
        `/hosts/${encodeURIComponent(props.hostId)}/history/${encodeURIComponent(sessionId)}/activity/${encodeURIComponent(ref)}?${new URLSearchParams({ provider: props.provider.toLowerCase(), offset: String(offset) })}`,
        undefined,
        "GET",
        controller.signal,
      );
      if (controller.signal.aborted || request.current !== controller) return;
      if (
        page.offset !== offset ||
        (page.nextOffset !== null && page.nextOffset <= offset)
      )
        throw new Error("작업 원문의 읽기 위치가 올바르지 않습니다.");
      const next = {
        scope,
        text: (offset ? current?.text || "" : "") + page.text,
        nextOffset: page.nextOffset,
      };
      if (selection.current) pending.current = next;
      else setFull(next);
    } catch (cause) {
      if (!controller.signal.aborted) setError((cause as Error).message);
    } finally {
      if (request.current === controller) {
        busy.current = false;
        setLoading(false);
      }
    }
  };
  useEffect(() => {
    setFull(undefined);
    setError("");
    setLoading(false);
    pending.current = undefined;
    return () => {
      request.current?.abort();
      request.current = undefined;
      busy.current = false;
    };
  }, [scope]);
  useEffect(() => setManualOpen(undefined), [identity]);
  useEffect(() => {
    if (!selectionActive && pending.current) {
      if (pending.current.scope === scope) setFull(pending.current);
      pending.current = undefined;
    }
  }, [selectionActive, scope]);
  useEffect(() => {
    if (
      open &&
      item.activityTruncated &&
      ref &&
      sessionId &&
      !current &&
      !loading &&
      !error &&
      !pending.current
    )
      void load();
  }, [open, scope, item.activityTruncated, loading, error, current?.scope]);
  const heading =
    item.text.split(/\r?\n/, 1)[0] ||
    (item.kind === "command"
      ? "명령 실행"
      : item.kind === "change"
        ? "코드 변경"
        : "작업 기록");
  return (
    <details
      className={`transcript-work-item ${item.kind}`}
      data-work-item={item.id}
      open={open}
    >
      <summary
        title={heading}
        onClick={(event) => {
          event.preventDefault();
          setManualOpen(!open);
        }}
      >
        <span>{heading}</span>
      </summary>
      <TranscriptMessage
        item={
          current ? { ...item, text: current.text, detail: undefined } : item
        }
        {...props}
      />
      {item.activityTruncated && !ref && (
        <small className="transcript-work-status">
          이 항목은 저장된 원문이 커서 일부만 표시됩니다.
        </small>
      )}
      {loading && (
        <small className="transcript-work-status" role="status">
          원문을 읽는 중…
        </small>
      )}
      {error && (
        <div className="transcript-work-status" role="alert">
          {error}{" "}
          <button onClick={() => void load(current?.nextOffset || 0)}>
            다시 읽기
          </button>
        </div>
      )}
      {current?.nextOffset != null && !error && (
        <button
          className="transcript-work-more"
          disabled={loading || !!pending.current}
          onClick={() => void load(current.nextOffset!)}
        >
          원문 더 보기
        </button>
      )}
    </details>
  );
});

/** Display existing records only. Folding changes DOM visibility, never the data or AI context. */
export function TranscriptItems({ items, ...props }: TranscriptItemsProps) {
  return (
    <div className="transcript-items">
      {items.map((item) => {
        const work =
          ["command", "tool", "change", "plan"].includes(item.kind) ||
          (item.kind === "assistant" && item.phase === "commentary");
        return work ? (
          <WorkDisclosure
            key={`${item.kind}:${item.id}`}
            item={item}
            {...props}
          />
        ) : (
          <TranscriptMessage
            key={`${item.kind}:${item.id}`}
            item={item}
            {...props}
          />
        );
      })}
    </div>
  );
}
