import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import "./resizable-sidebar.css";

const variants = {
  workspace: {
    id: "harbor-sidebar",
    label: "왼쪽 패널 너비 조절",
    storageKey: "harbor.sidebarWidth",
    minWidth: 200,
    maxWidth: 600,
    defaultWidth: 268,
    reservedWidth: (available: number) => (available <= 700 ? 40 : 320),
  },
  ide: {
    id: "harbor-ide-explorer",
    label: "IDE 파일 탐색기 너비 조절",
    storageKey: "harbor.ideExplorerWidth",
    minWidth: 160,
    maxWidth: 520,
    defaultWidth: 210,
    reservedWidth: () => 240,
  },
};

function savedWidth({
  storageKey,
  minWidth,
  maxWidth,
}: Pick<(typeof variants)["workspace"], "storageKey" | "minWidth" | "maxWidth">) {
  try {
    const value = Number(localStorage.getItem(storageKey));
    return Number.isFinite(value) && value >= minWidth
      ? Math.min(maxWidth, value)
      : null;
  } catch {
    return null;
  }
}

export default function ResizableSidebar({
  className,
  children,
  variant = "workspace",
}: {
  className: string;
  children: ReactNode;
  variant?: keyof typeof variants;
}) {
  const settings = variants[variant];
  const {
    id,
    label,
    storageKey,
    minWidth,
    maxWidth,
    defaultWidth,
    reservedWidth,
  } = settings;
  const sidebar = useRef<HTMLElement>(null);
  const [initialWidth] = useState(() => savedWidth(settings));
  const preferredWidth = useRef(initialWidth);
  const pointer = useRef<{ id: number; offset: number } | null>(null);
  const [size, setSize] = useState({ width: defaultWidth, max: maxWidth });

  useLayoutEffect(() => {
    const element = sidebar.current!;
    if (preferredWidth.current !== null)
      element.style.setProperty(
        "--harbor-sidebar-width",
        `${preferredWidth.current}px`,
      );
    const measure = () => {
      const available = element.parentElement!.getBoundingClientRect().width;
      if (!available) return;
      const next = {
        width: Math.round(element.getBoundingClientRect().width),
        max: Math.max(
          minWidth,
          Math.min(maxWidth, available - reservedWidth(available)),
        ),
      };
      setSize((previous) =>
        previous.width === next.width && previous.max === next.max
          ? previous
          : next,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(element.parentElement!);
    measure();
    return () => {
      observer.disconnect();
      document.documentElement.classList.remove("harbor-sidebar-resizing");
    };
  }, [settings]);

  function apply(width: number) {
    const element = sidebar.current!;
    const available = element.parentElement!.getBoundingClientRect().width;
    const limit = Math.max(
      minWidth,
      Math.min(maxWidth, available - reservedWidth(available)),
    );
    preferredWidth.current = Math.round(
      Math.max(minWidth, Math.min(limit, width)),
    );
    // Resize only this panel; pointer movement must not rerender the workspace.
    element.style.setProperty(
      "--harbor-sidebar-width",
      `${preferredWidth.current}px`,
    );
  }

  function finish() {
    if (!pointer.current) return;
    pointer.current = null;
    document.documentElement.classList.remove("harbor-sidebar-resizing");
    persist();
  }

  function persist() {
    try {
      if (preferredWidth.current === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, String(preferredWidth.current));
    } catch {
      // Resizing still works when browser storage is unavailable.
    }
  }

  function reset() {
    preferredWidth.current = null;
    sidebar.current!.style.removeProperty("--harbor-sidebar-width");
    persist();
  }

  return (
    <aside ref={sidebar} id={id} className={className}>
      {children}
      <div
        className="harbor-sidebar-resizer"
        role="separator"
        tabIndex={0}
        aria-label={label}
        aria-controls={id}
        aria-orientation="vertical"
        aria-valuemin={minWidth}
        aria-valuemax={size.max}
        aria-valuenow={size.width}
        title="드래그해 너비 조절 · 두 번 클릭하면 기본 너비 · 방향키로 조절"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          pointer.current = {
            id: event.pointerId,
            offset:
              event.clientX - sidebar.current!.getBoundingClientRect().right,
          };
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          document.documentElement.classList.add("harbor-sidebar-resizing");
        }}
        onPointerMove={(event) => {
          const drag = pointer.current;
          if (drag?.id === event.pointerId)
            apply(
              event.clientX -
                drag.offset -
                sidebar.current!.getBoundingClientRect().left,
            );
        }}
        onPointerUp={(event) => {
          const drag = pointer.current;
          if (drag?.id !== event.pointerId) return;
          apply(
            event.clientX -
              drag.offset -
              sidebar.current!.getBoundingClientRect().left,
          );
          finish();
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={finish}
        onPointerCancel={finish}
        onDoubleClick={reset}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            const step =
              (event.shiftKey ? 40 : 16) * (event.key === "ArrowLeft" ? -1 : 1);
            apply(sidebar.current!.getBoundingClientRect().width + step);
            persist();
          } else if (event.key === "Home" || event.key === "Enter") {
            event.preventDefault();
            reset();
          }
        }}
      />
    </aside>
  );
}
