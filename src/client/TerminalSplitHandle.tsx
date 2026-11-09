import { useEffect, useRef } from "react";
import type { RefObject, CSSProperties } from "react";
import { splitGap, type DividerRect } from "./terminal-tree";

export default function TerminalSplitHandle({
  dividers,
  grid,
  x,
  y,
  onChange,
  onDragging,
}: {
  dividers: DividerRect[];
  grid: RefObject<HTMLDivElement | null>;
  x?: number;
  y?: number;
  onChange(ratios: Record<string, number>): void;
  onDragging(value: boolean): void;
}) {
  const pointer = useRef<number | null>(null),
    frame = useRef(0);
  const location = useRef({ x: 0, y: 0 });
  const current = useRef({ dividers, onChange });
  current.current = { dividers, onChange };
  const junction = x !== undefined && y !== undefined;
  const first = dividers[0];
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  function apply() {
    const rect = grid.current?.getBoundingClientRect();
    if (!rect) return;
    const ratios: Record<string, number> = {};
    for (const divider of current.current.dividers) {
      const vertical = divider.axis === "column";
      const start = vertical
        ? rect.left + divider.parent.x
        : rect.top + divider.parent.y;
      const extent =
        (vertical ? divider.parent.width : divider.parent.height) - splitGap;
      const point = vertical ? location.current.x : location.current.y;
      if (extent > 0)
        ratios[divider.id] = (point - start - splitGap / 2) / extent;
    }
    current.current.onChange(ratios);
  }
  function finish() {
    cancelAnimationFrame(frame.current);
    if (pointer.current !== null) apply();
    pointer.current = null;
    onDragging(false);
  }
  const style: CSSProperties = junction
    ? { left: x, top: y }
    : { left: first.x, top: first.y, width: first.width, height: first.height };
  return (
    <div
      className={
        junction
          ? "terminal-tree-junction"
          : `terminal-tree-divider ${first.axis}`
      }
      role={junction ? "button" : "separator"}
      tabIndex={0}
      aria-label={
        junction
          ? "터미널 가로·세로 크기 함께 조절"
          : first.axis === "column"
            ? "터미널 가로 크기 조절"
            : "터미널 세로 크기 조절"
      }
      aria-orientation={
        junction
          ? undefined
          : first.axis === "column"
            ? "vertical"
            : "horizontal"
      }
      aria-valuenow={junction ? undefined : Math.round(first.ratio * 100)}
      style={style}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        pointer.current = event.pointerId;
        location.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
        onDragging(true);
      }}
      onPointerMove={(event) => {
        if (pointer.current !== event.pointerId) return;
        location.current = { x: event.clientX, y: event.clientY };
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(apply);
      }}
      onPointerUp={(event) => {
        if (pointer.current !== event.pointerId) return;
        location.current = { x: event.clientX, y: event.clientY };
        finish();
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={() =>
        onChange(Object.fromEntries(dividers.map((d) => [d.id, 0.5])))
      }
      onKeyDown={(event) => {
        if (event.key === "Home" || event.key === "Enter") {
          event.preventDefault();
          onChange(Object.fromEntries(dividers.map((d) => [d.id, 0.5])));
          return;
        }
        const axis = ["ArrowLeft", "ArrowRight"].includes(event.key)
          ? "column"
          : ["ArrowUp", "ArrowDown"].includes(event.key)
            ? "row"
            : null;
        if (!axis || !dividers.some((d) => d.axis === axis)) return;
        event.preventDefault();
        const sign = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1;
        onChange(
          Object.fromEntries(
            dividers
              .filter((d) => d.axis === axis)
              .map((d) => [
                d.id,
                d.ratio + sign * (event.shiftKey ? 0.1 : 0.02),
              ]),
          ),
        );
      }}
    />
  );
}
