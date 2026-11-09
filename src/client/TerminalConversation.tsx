import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Terminal } from "@xterm/xterm";
import { LoaderCircle, RotateCcw, X } from "lucide-react";
import type { TerminalInfo } from "../shared/types";
import type { HistoryDetail } from "../shared/history";
import { api } from "./api";
import { Markdown } from "./RichMarkdown";
import { isLegacyClaudeHistoryLimit } from "./history-errors";
import "./terminal-conversation.css";

/** Read the originating conversation; never start/resume a CLI or inject input. */
export function TerminalConversation({
  term,
  info,
  onClose,
}: {
  term: Terminal;
  info: TerminalInfo;
  onClose(): void;
}) {
  const sessionId = info.agentSessionId || info.resumeThreadId;
  const provider =
    info.agentKind || (info.program?.startsWith("claude") ? "claude" : "codex");
  const [detail, setDetail] = useState<HistoryDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [historyPaused, setHistoryPaused] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const retryMore = useRef(false);
  const anchor = useRef<{ height: number; top: number } | "bottom" | null>(
    null,
  );
  async function load(more = false, automatic = false) {
    if (automatic && historyPaused) return;
    if (!sessionId || busy.current || (more && !detail?.nextCursor)) return;
    const controller = new AbortController();
    request.current = controller;
    busy.current = true;
    retryMore.current = more;
    setLoading(true);
    setError("");
    setHistoryPaused(false);
    anchor.current =
      more && body.current
        ? { height: body.current.scrollHeight, top: body.current.scrollTop }
        : "bottom";
    try {
      const params = new URLSearchParams({
        provider,
        ...(more && detail?.nextCursor ? { cursor: detail.nextCursor } : {}),
      });
      const result = await api<HistoryDetail>(
        `/hosts/${encodeURIComponent(info.hostId)}/history/${encodeURIComponent(sessionId)}?${params}`,
        undefined,
        "GET",
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setDetail((previous) =>
        more && previous
          ? {
              ...result,
              notice: result.notice || previous.notice,
              items: [
                ...new Map(
                  [...result.items, ...previous.items].map((item) => [
                    item.id,
                    item,
                  ]),
                ).values(),
              ],
            }
          : result,
      );
    } catch (cause) {
      if (!controller.signal.aborted) {
        anchor.current = null;
        if (isLegacyClaudeHistoryLimit(cause)) setHistoryPaused(true);
        else setError((cause as Error).message);
      }
    } finally {
      if (request.current === controller) {
        busy.current = false;
        setLoading(false);
      }
    }
  }
  useEffect(() => {
    void load();
    return () => {
      request.current?.abort();
      busy.current = false;
    };
  }, [info.id, info.hostId, sessionId, provider]);
  useLayoutEffect(() => {
    const element = body.current,
      saved = anchor.current;
    if (!element || !saved || !detail) return;
    element.scrollTop =
      saved === "bottom"
        ? element.scrollHeight
        : saved.top + element.scrollHeight - saved.height;
    anchor.current = null;
  }, [detail]);
  const mount = term.element?.parentElement;
  if (!mount) return null;
  return createPortal(
    <section
      className="terminal-conversation"
      role="region"
      aria-label="현재 대화 기록"
      data-terminal-rich="true"
    >
      <header>
        <div>
          <b>현재 대화 기록</b>
          <small>요약·재접속 이전의 저장된 메시지도 읽을 수 있습니다.</small>
        </div>
        {loading && (
          <LoaderCircle
            size={15}
            className="spin"
            aria-label="기록을 읽는 중"
          />
        )}
        <button
          className="icon-button compact"
          aria-label="현재 대화 기록 새로고침"
          disabled={loading}
          onClick={() => void load()}
        >
          <RotateCcw size={15} />
        </button>
        <button
          className="icon-button compact"
          aria-label="현재 대화 기록 닫기"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <div
        className="terminal-conversation-body"
        ref={body}
        onScroll={() => {
          if (
            body.current &&
            body.current.scrollTop < 24 &&
            detail?.nextCursor &&
            !error
          )
            void load(true, true);
        }}
      >
        {detail?.nextCursor && (
          <button
            className="button secondary small"
            disabled={loading}
            onClick={() => void load(true)}
          >
            이전 메시지 더 보기
          </button>
        )}
        {error && (
          <div className="inline-error" role="alert">
            {error}
            <button
              className="button secondary small"
              disabled={loading}
              onClick={() => void load(retryMore.current)}
            >
              다시 읽기
            </button>
          </div>
        )}
        {historyPaused && (
          <button
            className="button secondary small"
            disabled={loading}
            onClick={() => void load(retryMore.current)}
          >
            기록 다시 불러오기
          </button>
        )}
        {detail?.notice && <p role="status">{detail.notice}</p>}
        {loading && !detail && <p role="status">대화 기록을 읽는 중…</p>}
        {detail?.items.map((item) => (
          <article
            key={item.id}
            className={`history-message ${item.kind}`}
            data-rich-block={`conversation-${item.id}`}
          >
            <b>
              {item.kind === "user"
                ? "나"
                : item.kind === "assistant"
                  ? provider === "claude"
                    ? "Claude"
                    : "Codex"
                  : "기록"}
            </b>
            {!!item.imageCount && <small>이미지 {item.imageCount}개</small>}
            <Markdown
              text={item.text}
              location={{
                hostId: info.hostId,
                cwd: detail.thread.cwd || info.cwd,
              }}
            />
          </article>
        ))}
        {detail && !detail.items.length && !loading && (
          <p>
            {detail.nextCursor
              ? "이 구간에는 표시할 메시지가 없습니다. 이전 메시지를 계속 불러올 수 있습니다."
              : "표시할 메시지가 없습니다."}
          </p>
        )}
      </div>
    </section>,
    mount,
  );
}
