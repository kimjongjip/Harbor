import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MessageItem } from "../../shared/types";
import { providerName } from "../../shared/agent-provider";
import type { IdeChatConversation } from "../../shared/ide-chat";
import { conversationTurns } from "../conversation-turns";
import { transcriptSections } from "../transcript-steps";
import { TranscriptItems } from "../TranscriptItems";
import { WorkGroup } from "../WorkGroup";
import { displayMessage } from "./display-message";
import "../terminal-conversation.css";

/** The terminal reader and managed chat share item rendering; managed input stays in the composer. */
export const ManagedTranscript = memo(function ManagedTranscript({
  items,
  provider,
  hostId,
  cwd,
  nativeId,
  running,
}: Pick<
  IdeChatConversation,
  "items" | "provider" | "hostId" | "cwd" | "nativeId"
> & { running: boolean }) {
  const [folds, setFolds] = useState<Record<string, boolean>>({});
  const previous = useRef(new Map<string, MessageItem>());
  // A status update may deliver a fresh full snapshot. Keep unchanged Markdown,
  // tables and selection targets mounted while the final item streams.
  const data = useMemo(() => {
    const cache = new Map<string, MessageItem>();
    const rows = items.map((row) => {
      const key = row.kind + ":" + row.id,
        old = previous.current.get(key);
      const keys = Object.keys(row) as (keyof MessageItem)[];
      const stable =
        old &&
        keys.length === Object.keys(old).length &&
        keys.every((k) => row[k] === old[k])
          ? old
          : row;
      cache.set(key, stable);
      return stable;
    });
    return {
      cache,
      turns: conversationTurns(rows).map((t) => ({
        ...t,
        sections: transcriptSections(t.items),
      })),
    };
  }, [items]);
  useLayoutEffect(() => {
    previous.current = data.cache;
  }, [data]);
  const props = {
    provider: providerName(provider),
    hostId,
    cwd,
    sessionId: nativeId,
  };
  return (
    <div className="terminal-conversation-document managed-transcript">
      {data.turns.map((turn, index) => {
        const live =
          running && index === data.turns.length - 1 && !turn.complete;
        const state = live ? "live" : "done";
        return (
          <section
            key={turn.id + ":" + turn.items[0].id}
            className="conversation-turn"
            data-turn-id={turn.id}
          >
            {turn.sections.map((section) => {
              if (section.kind === "work") {
                const key = turn.id + ":" + section.key;
                return (
                  <WorkGroup
                    key={section.key}
                    items={section.items}
                    state={state}
                    busy={live}
                    open={folds[key] ?? live}
                    onToggle={(open) =>
                      setFolds((prior) => ({ ...prior, [key]: open }))
                    }
                    props={props}
                  />
                );
              }
              const item = section.items[0];
              const displayed =
                item.kind === "user" && !item.origin
                  ? displayMessage(item)
                  : undefined;
              if (displayed?.selection) {
                const quote = displayed.selection;
                return (
                  <div key={section.key}>
                    <TranscriptItems
                      items={[{ ...item, text: displayed.text }]}
                      {...props}
                    />
                    <details className="ide-chat-quoted">
                      <summary>
                        {quote.path}:{quote.startLine}–{quote.endLine}
                        {quote.unsaved ? " · 편집 중" : ""}
                      </summary>
                      <pre>{quote.text}</pre>
                    </details>
                  </div>
                );
              }
              return (
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
    </div>
  );
});
