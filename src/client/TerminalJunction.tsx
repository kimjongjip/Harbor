import { useRef } from "react";
import type { RefObject } from "react";

export default function TerminalJunction({
  grid,
  onChange,
  onDragging,
}: {
  grid: RefObject<HTMLDivElement | null>;
  onChange: (column: number, row: number, persist: boolean) => void;
  onDragging: (dragging: boolean) => void;
}) {
  const pointer = useRef<number | null>(null);
  function apply(x: number, y: number, persist: boolean) {
    const element = grid.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const top = parseFloat(style.paddingTop) || 0;
    const left = parseFloat(style.paddingLeft) || 0;
    const width = rect.width - left - (parseFloat(style.paddingRight) || 0) - 6;
    const height =
      rect.height - top - (parseFloat(style.paddingBottom) || 0) - 6;
    onChange(
      (x - rect.left - left - 3) / width,
      (y - rect.top - top - 3) / height,
      persist,
    );
  }
  return (
    <button
      className="terminal-junction"
      aria-label="터미널 가로·세로 크기 함께 조절"
      title="중앙을 끌어 가로·세로 함께 조절 · 두 번 클릭하면 균등 배치"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        pointer.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        onDragging(true);
      }}
      onPointerMove={(event) => {
        if (pointer.current === event.pointerId)
          apply(event.clientX, event.clientY, false);
      }}
      onPointerUp={(event) => {
        if (pointer.current !== event.pointerId) return;
        apply(event.clientX, event.clientY, true);
        pointer.current = null;
        onDragging(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        pointer.current = null;
        onDragging(false);
      }}
      onPointerCancel={() => {
        pointer.current = null;
        onDragging(false);
      }}
      onDoubleClick={() => onChange(0.5, 0.5, true)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === "Home") {
          event.preventDefault();
          onChange(0.5, 0.5, true);
        }
      }}
    />
  );
}
