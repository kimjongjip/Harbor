import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import type { MessageItem } from "../shared/types";
import { api } from "./api";
import { Markdown } from "./RichMarkdown";
import { AnsiText, stripAnsi } from "./ansi-text";
import { parseDiff, stepTitle, type DiffLine } from "./transcript-steps";
import { userMessageView, userOriginLabel } from "./user-origin";

export interface WorkContext {
  provider: string;
  hostId: string;
  cwd: string;
  sessionId?: string;
  selectionActive?: boolean;
}

/** Exact saved original for a truncated preview, read lazily in 64K pages. */
function useFullText(item: MessageItem | undefined, context: WorkContext) {
  const ref = item?.activityRef;
  const scope = `${context.hostId}:${context.sessionId}:${context.provider}:${item?.kind}:${item?.id}:${ref}`;
  const [state, setState] = useState<{
    scope: string;
    text: string;
    nextOffset: number | null;
  }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    setState(undefined);
    setError("");
    setLoading(false);
    return () => request.current?.abort();
  }, [scope]);
  const current = state?.scope === scope ? state : undefined;
  const load = async () => {
    if (!item || !ref || !context.sessionId || loading) return;
    const offset = current?.nextOffset || 0;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const page = await api<{
        text: string;
        offset: number;
        nextOffset: number | null;
      }>(
        `/hosts/${encodeURIComponent(context.hostId)}/history/${encodeURIComponent(context.sessionId)}/activity/${encodeURIComponent(ref)}?${new URLSearchParams({ provider: context.provider.toLowerCase(), offset: String(offset) })}`,
        undefined,
        "GET",
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (
        page.offset !== offset ||
        (page.nextOffset !== null && page.nextOffset <= offset)
      )
        throw new Error("작업 원문의 읽기 위치가 올바르지 않습니다.");
      setState({
        scope,
        text: (offset ? current?.text || "" : "") + page.text,
        nextOffset: page.nextOffset,
      });
    } catch (cause) {
      if (!controller.signal.aborted) setError((cause as Error).message);
    } finally {
      if (request.current === controller) setLoading(false);
    }
  };
  // The stored original is `text\ndetail`; split it back for rendering.
  let full: { text: string; detail?: string } | undefined;
  if (current && item) {
    const prefix = `${item.text}\n`;
    full =
      item.detail !== undefined && current.text.startsWith(prefix)
        ? { text: item.text, detail: current.text.slice(prefix.length) }
        : { text: current.text };
  }
  return {
    full,
    more: !!item?.activityTruncated && (!current || current.nextOffset !== null),
    unavailable: !!item?.activityTruncated && !ref,
    loading,
    error,
    load,
  };
}

const lines = (text: string) => (text ? text.replace(/\n+$/, "").split("\n") : []);

function OutputBlock({
  text,
  preview = 8,
}: {
  text: string;
  preview?: number;
}) {
  const [all, setAll] = useState(false);
  const rows = lines(text);
  const shown = all ? rows : rows.slice(0, preview);
  if (!rows.length) return null;
  return (
    <div className="transcript-output">
      <pre>
        <AnsiText text={shown.join("\n")} />
      </pre>
      {rows.length > preview && (
        <button
          type="button"
          className="transcript-output-more"
          onClick={() => setAll((value) => !value)}
        >
          {all ? "접기" : `… +${rows.length - preview}줄 더 보기`}
        </button>
      )}
    </div>
  );
}

function DiffBlock({ diff }: { diff: DiffLine[] }) {
  return (
    <div className="transcript-diff" role="table" aria-label="변경 내용">
      {diff.map((line, index) =>
        line.kind === "file" || line.kind === "hunk" ? (
          <div key={index} className={`transcript-diff-${line.kind}`}>
            {line.text}
          </div>
        ) : (
          <div
            key={index}
            className={`transcript-diff-line ${line.kind}`}
            role="row"
          >
            <span className="transcript-diff-number" aria-hidden="true">
              {line.kind === "remove" ? line.oldLine : line.newLine ?? ""}
            </span>
            <span className="transcript-diff-sign" aria-hidden="true">
              {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
            </span>
            <span className="transcript-diff-text">{line.text || " "}</span>
          </div>
        ),
      )}
    </div>
  );
}

/** Codex stores one `--- path\n<diff>` section per changed file. */
function codexChanges(item: MessageItem, detail: string) {
  const paths = item.text.split("\n").filter(Boolean);
  const sections: { path: string; body: string }[] = [];
  let rest = detail;
  for (const [index, path] of paths.entries()) {
    const marker = `--- ${path}\n`;
    if (!rest.startsWith(marker)) return;
    const next = paths[index + 1] ? rest.indexOf(`\n--- ${paths[index + 1]}\n`) : -1;
    const end = next < 0 ? rest.length : next;
    sections.push({ path, body: rest.slice(marker.length, end) });
    rest = next < 0 ? "" : rest.slice(next + 1);
  }
  return sections;
}

function FileBlock({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const rows = lines(text);
  const shown = all ? rows : rows.slice(0, 10);
  return (
    <div className="transcript-diff">
      {shown.map((line, index) => (
        <div key={index} className="transcript-diff-line add">
          <span className="transcript-diff-number">{index + 1}</span>
          <span className="transcript-diff-sign">+</span>
          <span className="transcript-diff-text">{line || " "}</span>
        </div>
      ))}
      {rows.length > 10 && (
        <button
          type="button"
          className="transcript-output-more"
          onClick={() => setAll((value) => !value)}
        >
          {all ? "접기" : `… +${rows.length - 10}줄 더 보기`}
        </button>
      )}
    </div>
  );
}

const countLines = (text = "") => lines(stripAnsi(text)).length;

/** One CLI step: heading like `Update(file)`, a one-line result and its saved output. */
export const WorkStep = memo(function WorkStep({
  call,
  result,
  item,
  context,
  defaultOpen = false,
}: {
  call?: MessageItem;
  result?: MessageItem;
  /** Self-contained Codex/legacy work item. */
  item?: MessageItem;
  context: WorkContext;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Opening a step by hand reads its exact original at once; steps shown open
  // by default wait for "원문 더 보기" so a long turn issues no request storm.
  const [requested, setRequested] = useState(false);
  let plain = false;
  const source = result || item;
  const fullText = useFullText(source, context);
  useEffect(() => {
    if (requested && open && fullText.more && !fullText.full && !fullText.loading && !fullText.error)
      void fullText.load();
  }, [requested, open, fullText.more, !!fullText.full, fullText.loading, fullText.error]);
  const callText = useFullText(call?.activityTruncated ? call : undefined, context);
  const detail = fullText.full?.detail ?? (fullText.full ? fullText.full.text : source?.detail);
  let name: string, target: string, body: ReactNode = null, summary = "";
  const failed = source?.status === "failed" || call?.status === "failed";
  // A Claude call without its result yet, or a Codex item still in progress.
  const running = (!result && !item) || item?.status === "inProgress";
  if (item && !call && !result) {
    plain = true;
    if (item.kind === "command") {
      name = "Ran";
      target = item.text;
      const count = countLines(detail);
      summary = count ? `출력 ${count}줄` : running ? "실행 중…" : "";
      body = <OutputBlock text={detail || ""} />;
    } else if (item.kind === "change") {
      name = "Edited";
      target = item.text.split("\n").join(", ");
      const sections = detail ? codexChanges(item, detail) : undefined;
      body = sections ? (
        sections.map((section) => {
          const diff = parseDiff(section.body);
          return (
            <div key={section.path} className="transcript-change">
              <div className="transcript-diff-file">{section.path}</div>
              {diff ? <DiffBlock diff={diff} /> : <FileBlock text={section.body} />}
            </div>
          );
        })
      ) : (
        <OutputBlock text={detail || ""} preview={40} />
      );
    } else if (item.kind === "plan") {
      name = "Plan";
      target = "";
      body = <Markdown text={item.text} location={{ hostId: context.hostId, cwd: context.cwd }} />;
    } else {
      name = item.text.split("\n", 1)[0] || "작업 기록";
      target = "";
      body = <OutputBlock text={detail || ""} />;
    }
  } else {
    const title = stepTitle(
      callText.full ? { ...call!, detail: callText.full.detail ?? callText.full.text } : call,
      context.cwd,
    );
    name = title.name;
    target = title.target.split("\n", 1)[0];
    const multiline = title.target.includes("\n") || title.target.length > 160;
    const format = result?.format;
    const diff =
      format === "diff" || (detail && /^@@ /m.test(detail)) ? parseDiff(detail || "") : undefined;
    if (diff) {
      summary = result?.text && result.text !== "도구 결과" ? result.text : "";
      body = <DiffBlock diff={diff} />;
    } else if (format === "file") {
      summary = result?.text || "";
      body = <FileBlock text={detail || ""} />;
    } else if (call?.text === "Read") {
      const count = countLines(detail);
      summary = result ? `${count}줄 읽음` : "";
      body = result ? <OutputBlock text={detail || ""} preview={0} /> : null;
    } else {
      const count = countLines(detail);
      summary = !result
        ? "실행 중…"
        : count
          ? `출력 ${count}줄`
          : failed
            ? "실패"
            : "출력 없음";
      body = (
        <>
          {multiline && (
            <pre className="transcript-step-command">
              <AnsiText text={title.target} />
            </pre>
          )}
          {result && <OutputBlock text={detail || ""} />}
        </>
      );
    }
  }
  const heading = plain
    ? [name, target].filter(Boolean).join(" ")
    : `${name}${target ? `(${target})` : ""}`;
  return (
    <details
      className={`transcript-step${failed ? " failed" : ""}${running ? " running" : ""}`}
      data-work-item={(source || call)?.id}
      open={open}
    >
      <summary
        title={heading}
        onClick={(event) => {
          event.preventDefault();
          if (!open) setRequested(true);
          setOpen(!open);
        }}
      >
        <span className="transcript-step-line">
          <span className="transcript-step-bullet" aria-hidden="true">
            ●
          </span>
          <span className="transcript-step-title">
            <b>{name}</b>
            {target && (
              <span className="transcript-step-target">
                {plain ? ` ${target}` : `(${target})`}
              </span>
            )}
          </span>
        </span>
        {/* Like the CLI's folded step: the one-line result stays visible. */}
        {summary && (
          <span className="transcript-step-summary">
            <span aria-hidden="true">⎿ </span>
            {summary}
          </span>
        )}
      </summary>
      {/* A folded step keeps no hidden body: nothing to copy or lay out. */}
      {open && <div className="transcript-step-body">{body}</div>}
      {open && fullText.unavailable && (
        <small className="transcript-work-status">
          이 항목은 저장된 원문이 커서 일부만 표시됩니다.
        </small>
      )}
      {fullText.loading && (
        <small className="transcript-work-status" role="status">
          원문을 읽는 중…
        </small>
      )}
      {fullText.error && (
        <div className="transcript-work-status" role="alert">
          {fullText.error}{" "}
          <button type="button" onClick={() => void fullText.load()}>
            다시 읽기
          </button>
        </div>
      )}
      {open && fullText.more && !fullText.unavailable && !fullText.error && (
        <button
          type="button"
          className="transcript-work-more"
          disabled={fullText.loading}
          onClick={() => void fullText.load()}
        >
          원문 더 보기
        </button>
      )}
    </details>
  );
});

export const CommentaryLine = memo(function CommentaryLine({
  item,
  context,
}: {
  item: MessageItem;
  context: WorkContext;
}) {
  return (
    <article
      className="transcript-commentary"
      data-history-message={item.id}
      data-rich-block={`conversation-commentary-${item.id}`}
      data-terminal-rich="true"
    >
      <span className="transcript-step-bullet" aria-hidden="true">
        ●
      </span>
      <div className="conversation-message-content">
        <Markdown text={item.text} location={{ hostId: context.hostId, cwd: context.cwd }} />
      </div>
    </article>
  );
});


/** Records the CLI stored as "user" but the person did not type. */
export const SystemLine = memo(function SystemLine({
  item,
  outputs = [],
}: {
  item: MessageItem;
  outputs?: MessageItem[];
}) {
  const view = userMessageView(item);
  const [open, setOpen] = useState(false);
  if (view.hidden || !view.origin) return null;
  const output = outputs
    .map((entry) => userMessageView(entry).text)
    .filter(Boolean)
    .join("\n");
  const label = userOriginLabel(view);
  const text =
    view.origin === "interrupt"
      ? /tool use/.test(view.text)
        ? "도구 실행 중 사용자가 중단했습니다"
        : "사용자가 중단했습니다"
      : view.text;
  const extra =
    output || (view.origin === "system" && view.detail ? view.detail : "");
  const long = lines(extra).length > 3 || extra.length > 400;
  return (
    <div
      className={`transcript-system ${view.origin}`}
      data-history-message={item.id}
      data-rich-block={`conversation-system-${item.id}`}
      data-terminal-rich="true"
    >
      <span className="transcript-system-label">{label}</span>
      <span className="transcript-system-text">{text}</span>
      {extra &&
        (long ? (
          <>
            <button
              type="button"
              className="transcript-system-toggle"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
            >
              {open ? "접기" : "내용 보기"}
            </button>
            {open && (
              <pre className="transcript-system-output">
                <AnsiText text={extra} />
              </pre>
            )}
          </>
        ) : (
          <pre className="transcript-system-output">
            <AnsiText text={extra} />
          </pre>
        ))}
    </div>
  );
});
