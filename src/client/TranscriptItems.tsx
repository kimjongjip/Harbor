import { memo, useMemo } from "react";
import type { MessageItem } from "../shared/types";
import { Markdown } from "./RichMarkdown";
import { transcriptEntries } from "./transcript-steps";
import { CommentaryLine, SystemLine, WorkStep } from "./TranscriptWork";
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
  /** Show each work step expanded (inside an already folded work group). */
  stepsOpen?: boolean;
}

const TranscriptMessage = memo(function TranscriptMessage({
  item,
  provider,
  hostId,
  cwd,
}: {
  item: MessageItem;
  provider: string;
  hostId: string;
  cwd: string;
}) {
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

/** Display existing records only. Folding changes DOM visibility, never the data or AI context. */
export const TranscriptItems = memo(
  function TranscriptItems({
    items,
    provider,
    hostId,
    cwd,
    sessionId,
    selectionActive = false,
    stepsOpen = false,
  }: TranscriptItemsProps) {
    const entries = useMemo(() => transcriptEntries(items), [items]);
    const context = useMemo(
      () => ({ provider, hostId, cwd, sessionId, selectionActive }),
      [provider, hostId, cwd, sessionId, selectionActive],
    );
    return (
      <div className="transcript-items">
        {entries.map((entry) => {
          switch (entry.kind) {
            case "message":
              return (
                <TranscriptMessage
                  key={`${entry.item.kind}:${entry.item.id}`}
                  item={entry.item}
                  provider={provider}
                  hostId={hostId}
                  cwd={cwd}
                />
              );
            case "system":
              return (
                <SystemLine
                  key={`system:${entry.item.id}`}
                  item={entry.item}
                  outputs={entry.outputs}
                />
              );
            case "commentary":
              return (
                <CommentaryLine
                  key={`commentary:${entry.item.id}`}
                  item={entry.item}
                  context={context}
                />
              );
            case "step":
              return (
                <WorkStep
                  key={entry.key}
                  call={entry.call}
                  result={entry.result}
                  context={context}
                  defaultOpen={stepsOpen}
                />
              );
            case "item":
              return (
                <WorkStep
                  key={`${entry.item.kind}:${entry.item.id}`}
                  item={entry.item}
                  context={context}
                  defaultOpen={stepsOpen}
                />
              );
          }
        })}
      </div>
    );
  },
  (previous, next) =>
    previous.provider === next.provider &&
    previous.hostId === next.hostId &&
    previous.cwd === next.cwd &&
    previous.sessionId === next.sessionId &&
    previous.completed === next.completed &&
    previous.historical === next.historical &&
    previous.selectionActive === next.selectionActive &&
    previous.stepsOpen === next.stepsOpen &&
    previous.items.length === next.items.length &&
    previous.items.every((item, index) => item === next.items[index]),
);
