import { memo, useMemo, useRef } from "react";
import { TranscriptItems, type TranscriptItemsProps } from "./TranscriptItems";
import { transcriptEntries } from "./transcript-steps";

/** A consecutive run of tool records; progress reports remain outside. */
export const WorkGroup = memo(function WorkGroup({
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
