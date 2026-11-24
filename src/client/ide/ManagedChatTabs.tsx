import { Plus, X } from "lucide-react";
import { useEffect, useRef } from "react";

interface Tab {
  id: string;
  title: string;
  closeDisabled: boolean;
}
export function ManagedChatTabs({
  tabs,
  selected,
  activate,
  close,
  move,
  create,
}: {
  tabs: Tab[];
  selected: string;
  activate(id: string): void;
  close(id: string): void;
  move(id: string, toIndex: number): void;
  create(): void;
}) {
  const list = useRef<HTMLDivElement>(null),
    dragging = useRef("");
  useEffect(() => {
    const strip = list.current;
    const tab = strip?.querySelector<HTMLElement>(
      '[aria-selected="true"]',
    )?.parentElement;
    if (!strip || !tab) return;
    const bounds = strip.getBoundingClientRect(),
      item = tab.getBoundingClientRect();
    if (item.left < bounds.left) strip.scrollLeft += item.left - bounds.left;
    else if (item.right > bounds.right)
      strip.scrollLeft += item.right - bounds.right;
  }, [selected]);
  return (
    <div className="managed-chat-tabbar">
      <div
        className="managed-chat-tabs"
        ref={list}
        role="tablist"
        aria-label="열린 AI 대화"
      >
        {tabs.map((tab, index) => (
          <div
            key={tab.id}
            draggable
            className="managed-chat-tab"
            data-current={tab.id === selected}
            onDragStart={(e) => {
              dragging.current = tab.id;
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("application/x-harbor-ai-tab", tab.id);
            }}
            onDragEnd={() => {
              dragging.current = "";
            }}
            onDragOver={(e) => {
              if (
                dragging.current &&
                e.dataTransfer.types.includes("application/x-harbor-ai-tab")
              )
                e.preventDefault();
            }}
            onDrop={(e) => {
              const id = e.dataTransfer.getData("application/x-harbor-ai-tab");
              if (!id || id !== dragging.current) return;
              e.preventDefault();
              dragging.current = "";
              move(id, index);
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === selected}
              tabIndex={tab.id === selected ? 0 : -1}
              aria-label={tab.title}
              title={tab.title}
              onClick={() => activate(tab.id)}
              onKeyDown={(e) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
                  return;
                e.preventDefault();
                if (
                  e.altKey &&
                  (e.key === "ArrowLeft" || e.key === "ArrowRight")
                ) {
                  move(
                    tab.id,
                    Math.max(
                      0,
                      Math.min(
                        tabs.length - 1,
                        index + (e.key === "ArrowLeft" ? -1 : 1),
                      ),
                    ),
                  );
                  return;
                }
                const next =
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? tabs.length - 1
                      : (index +
                          (e.key === "ArrowLeft" ? -1 : 1) +
                          tabs.length) %
                        tabs.length;
                activate(tabs[next].id);
                list.current
                  ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  [next]?.focus();
              }}
            >
              <span>{tab.title}</span>
            </button>
            <button
              type="button"
              className="managed-chat-tab-close"
              aria-label={tab.title + " 탭 닫기"}
              title="탭 닫기"
              disabled={tab.closeDisabled}
              onClick={() => close(tab.id)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        aria-label="새 대화"
        title="새 대화 탭"
        onClick={create}
      >
        <Plus size={15} />
      </button>
    </div>
  );
}
