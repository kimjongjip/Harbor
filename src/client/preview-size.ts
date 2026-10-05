import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

const storageKey = "harbor.previewSize.v1";
const defaults = { width: 960, height: 680, maximized: false };
function savedSize() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (
      saved &&
      Number.isFinite(saved.width) &&
      Number.isFinite(saved.height) &&
      saved.width > 0 &&
      saved.height > 0
    )
      return {
        width: Math.min(saved.width, 10000),
        height: Math.min(saved.height, 10000),
        maximized: saved.maximized === true,
      };
  } catch {}
  return defaults;
}
export function usePreviewSize() {
  const [size, setSize] = useState(savedSize);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const drag = useRef<{
    pointer: number;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const maxWidth = Math.max(1, viewport.width - 24);
  const maxHeight = Math.max(1, viewport.height - 24);
  const bounded = (width: number, height: number) => ({
    width: Math.min(maxWidth, Math.max(Math.min(360, maxWidth), width)),
    height: Math.min(maxHeight, Math.max(Math.min(280, maxHeight), height)),
  });
  const actual = size.maximized
    ? { width: maxWidth, height: maxHeight }
    : bounded(size.width, size.height);
  useEffect(() => {
    const resize = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(size));
    } catch {}
  }, [size]);
  const reset = () => setSize(defaults);
  const handlers = {
    onPointerDown(event: PointerEvent<HTMLButtonElement>) {
      if (event.button !== 0 || size.maximized) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        ...actual,
      };
    },
    onPointerMove(event: PointerEvent<HTMLButtonElement>) {
      const initial = drag.current;
      if (!initial || initial.pointer !== event.pointerId) return;
      // A centered dialog moves both edges equally as its size changes.
      setSize({
        ...bounded(
          initial.width + 2 * (event.clientX - initial.x),
          initial.height + 2 * (event.clientY - initial.y),
        ),
        maximized: false,
      });
    },
    onPointerUp(event: PointerEvent<HTMLButtonElement>) {
      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel() {
      drag.current = null;
    },
    onLostPointerCapture() {
      drag.current = null;
    },
    onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
      if (event.key === "Home") {
        event.preventDefault();
        reset();
        return;
      }
      if (!event.key.startsWith("Arrow")) return;
      event.preventDefault();
      const step = event.shiftKey ? 80 : 20;
      setSize({
        ...bounded(
          actual.width +
            (event.key === "ArrowRight"
              ? step
              : event.key === "ArrowLeft"
                ? -step
                : 0),
          actual.height +
            (event.key === "ArrowDown"
              ? step
              : event.key === "ArrowUp"
                ? -step
                : 0),
        ),
        maximized: false,
      });
    },
  };
  return {
    maximized: size.maximized,
    toggle: () =>
      setSize((value) => ({ ...value, maximized: !value.maximized })),
    reset,
    handlers,
    style: {
      "--preview-width": `${actual.width}px`,
      "--preview-height": `${actual.height}px`,
    } as CSSProperties,
  };
}
