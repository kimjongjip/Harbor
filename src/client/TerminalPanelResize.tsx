import { useLayoutEffect, useRef, type RefObject } from "react";

const storageKey = "harbor.usagePanelWidth";
const defaultWidth = 280;
const maxWidth = 720;

/** Dragging changes one CSS width, never React state or the terminal's identity. */
export function TerminalPanelResize({
  panel,
  collapsed,
  controls,
}: {
  panel: RefObject<HTMLElement | null>;
  collapsed: boolean;
  controls: string;
}) {
  const handle = useRef<HTMLDivElement>(null);
  const preferred = useRef<number | null>(null);
  const drag = useRef<{ id: number; right: number; offset: number } | null>(
    null,
  );
  // Child layout effects can run before React attaches the parent's ref.
  const element = () => panel.current ?? handle.current?.parentElement;
  const bounds = () => {
    const available =
      element()?.parentElement?.getBoundingClientRect().width || 0;
    const max = Math.max(
      0,
      Math.min(maxWidth, available - Math.min(240, available / 2)),
    );
    return { min: Math.min(160, max), max };
  };
  const paint = () => {
    const { min, max } = bounds();
    const target = element();
    if (!max || !target) return;
    const width = Math.round(
      Math.max(min, Math.min(max, preferred.current ?? defaultWidth)),
    );
    target.style.setProperty("--usage-panel-width", `${width}px`);
    handle.current?.setAttribute("aria-valuemin", String(Math.round(min)));
    handle.current?.setAttribute("aria-valuemax", String(Math.round(max)));
    handle.current?.setAttribute("aria-valuenow", String(width));
  };
  const persist = () => {
    try {
      if (preferred.current === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, String(preferred.current));
    } catch {
      /* Resizing works even when storage is disabled. */
    }
  };
  const apply = (width: number) => {
    const { min, max } = bounds();
    preferred.current = Math.round(Math.max(min, Math.min(max, width)));
    paint();
  };
  const finish = () => {
    if (!drag.current) return;
    drag.current = null;
    document.documentElement.classList.remove("harbor-usage-resizing");
    persist();
  };
  useLayoutEffect(() => {
    try {
      const value = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(value) && value >= 80 && value <= maxWidth)
        preferred.current = value;
    } catch {
      /* Use the default width. */
    }
    const parent = element()?.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(paint);
    observer.observe(parent);
    paint();
    return () => {
      observer.disconnect();
      drag.current = null;
      document.documentElement.classList.remove("harbor-usage-resizing");
    };
  }, [panel, collapsed]);
  if (collapsed) return null;
  return (
    <div
      ref={handle}
      className="terminal-usage-resizer"
      role="separator"
      tabIndex={0}
      aria-label="Harbor 패널 너비 조절"
      aria-controls={controls}
      aria-orientation="vertical"
      title="드래그해 너비 조절 · 두 번 클릭하면 기본 너비 · 방향키로 조절"
      onPointerDown={(event) => {
        if (event.button !== 0 || !panel.current) return;
        event.preventDefault();
        const rect = panel.current.getBoundingClientRect();
        drag.current = {
          id: event.pointerId,
          right: rect.right,
          offset: event.clientX - rect.left,
        };
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        document.documentElement.classList.add("harbor-usage-resizing");
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (current?.id === event.pointerId)
          apply(current.right - event.clientX + current.offset);
      }}
      onPointerUp={(event) => {
        if (drag.current?.id !== event.pointerId) return;
        finish();
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={finish}
      onPointerCancel={finish}
      onDoubleClick={() => {
        preferred.current = null;
        paint();
        persist();
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          apply(
            (panel.current?.getBoundingClientRect().width || defaultWidth) +
              (event.shiftKey ? 40 : 16) * (event.key === "ArrowLeft" ? 1 : -1),
          );
          persist();
        } else if (event.key === "Home" || event.key === "Enter") {
          event.preventDefault();
          preferred.current = null;
          paint();
          persist();
        }
      }}
    >
      <span />
    </div>
  );
}
