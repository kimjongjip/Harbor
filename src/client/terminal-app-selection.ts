import type { Terminal } from "@xterm/xterm";
import {
  TerminalSelectionPages,
  type SelectionLine,
  type SelectionPoint,
} from "./terminal-selection-pages";

/** Fullscreen CLIs scroll by repainting rows; xterm itself has no scrollback there. */
export function applicationSelection(
  mount: HTMLElement,
  terminal: Terminal,
  enabled: () => boolean,
  options: { onChange?(): void; onNotice?(message: string): void } = {},
) {
  const document = mount.ownerDocument;
  const forwarded = new WeakSet<Event>();
  let pages: TerminalSelectionPages | undefined;
  let dragging = false;
  let downPoint: SelectionPoint | undefined;
  let pointer = { x: 0, y: 0 };
  let queued = 0;
  let pending:
    | { direction: number; extend: boolean; endPoint?: SelectionPoint }
    | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let edge: ReturnType<typeof setInterval> | undefined;
  let frozenText: string | undefined;
  let failed = false;
  let synchronizedUntil = 0;
  // xterm can flush its display before a delayed end marker arrives. Keep our
  // page comparison inside the explicit update boundary, with a bounded grace.
  const synchronized = () =>
    terminal.modes.synchronizedOutputMode || Date.now() < synchronizedUntil;
  const syncStart = terminal.parser.registerCsiHandler(
    { prefix: "?", final: "h" },
    (params) => {
      if (params.includes(2026)) synchronizedUntil = Date.now() + 5000;
      return false;
    },
  );
  const syncEnd = terminal.parser.registerCsiHandler(
    { prefix: "?", final: "l" },
    (params) => {
      if (params.includes(2026)) synchronizedUntil = 0;
      return false;
    },
  );
  const newline = /Win/.test(navigator.platform) ? "\r\n" : "\n";
  const screen = () =>
    terminal.element?.querySelector(".xterm-screen")?.getBoundingClientRect();
  const point = (): SelectionPoint => {
    const rect = screen();
    if (!rect) return { row: 0, column: 0 };
    const column = Math.max(
      0,
      Math.min(
        terminal.cols,
        Math.round(((pointer.x - rect.left) * terminal.cols) / rect.width),
      ),
    );
    const row = Math.floor(
      ((pointer.y - rect.top) * terminal.rows) / rect.height,
    );
    const cell = terminal.buffer.active
      .getLine(
        terminal.buffer.active.viewportY +
          Math.max(0, Math.min(terminal.rows - 1, row)),
      )
      ?.getCell(column);
    // A wide-character trailing cell is not a separate character boundary.
    return {
      row,
      column: cell?.getWidth() === 0 ? Math.max(0, column - 1) : column,
    };
  };
  const frame = (): SelectionLine[] =>
    Array.from({ length: terminal.rows }, (_, row) => {
      const line = terminal.buffer.active.getLine(
        terminal.buffer.active.viewportY + row,
      );
      return {
        text: line?.translateToString(true) || "",
        wrapped: !!line?.isWrapped,
        cells: Array.from({ length: terminal.cols }, (_, col) => {
          const cell = line?.getCell(col);
          return cell?.getWidth() === 0 ? "" : cell?.getChars() || " ";
        }),
      };
    });
  const canPage = () =>
    terminal.buffer.active.baseY === 0 &&
    (terminal.buffer.active.type === "alternate" ||
      terminal.modes.mouseTrackingMode !== "none");
  const getSelection = () => frozenText ?? pages?.text(newline);
  const paint = () => {
    const range = pages?.visibleRange();
    if (!range) terminal.clearSelection();
    else
      terminal.select(
        range.start.column,
        terminal.buffer.active.viewportY + range.start.row,
        (range.end.row - range.start.row) * terminal.cols +
          range.end.column -
          range.start.column,
      );
    options.onChange?.();
  };
  const clear = () => {
    const active = !!pages || frozenText !== undefined;
    pages = undefined;
    frozenText = undefined;
    pending = undefined;
    queued = 0;
    failed = false;
    clearTimeout(settle);
    clearTimeout(deadline);
    if (active) {
      terminal.clearSelection();
      options.onChange?.();
    }
  };
  const begin = () => {
    if (pages) return true;
    const range = terminal.getSelectionPosition();
    if (!range || !terminal.hasSelection()) return false;
    const y = terminal.buffer.active.viewportY;
    const start = { row: range.start.y - y, column: range.start.x },
      end = { row: range.end.y - y, column: range.end.x };
    if (start.row < 0 || end.row >= terminal.rows) return false;
    const distance = (a: SelectionPoint, b: SelectionPoint) =>
      Math.abs(a.row - b.row) * terminal.cols + Math.abs(a.column - b.column);
    const anchorAtEnd =
      !!downPoint && distance(downPoint, end) < distance(downPoint, start);
    pages = new TerminalSelectionPages(
      frame(),
      terminal.cols,
      start,
      end,
      anchorAtEnd,
    );
    // Remove native document drag listeners. We now retain the offscreen anchor;
    // the native service can only represent the highlighted viewport fragment.
    terminal.clearSelection();
    paint();
    return true;
  };
  const pauseMapping = () => {
    frozenText = getSelection();
    failed = true;
    pending = undefined;
    queued = 0;
    clearTimeout(settle);
    clearTimeout(deadline);
    terminal.clearSelection();
    options.onChange?.();
    options.onNotice?.(
      "화면이 바뀌어 이전 선택과 이어 붙이지 않았습니다. 선택한 글은 복사할 수 있으며, 다시 드래그하면 새로 선택합니다.",
    );
  };
  const reconcile = (timeout = false) => {
    if (!pages || !pending) return;
    // SSH may split a synchronized redraw across multiple packets. Intermediate
    // erased rows are not a different page, even after the response deadline.
    if (synchronized()) {
      if (timeout) deadline = setTimeout(() => reconcile(true), 200);
      return;
    }
    const extend = dragging || pending.extend;
    const focus = dragging ? point() : pending.endPoint || point();
    const result = pages.update(frame(), pending.direction, extend);
    if (result === "unmatched") {
      if (timeout) pauseMapping();
      return;
    }
    if (result === "unchanged" && !timeout) {
      paint();
      return;
    }
    clearTimeout(deadline);
    clearTimeout(settle);
    pending = undefined;
    if (extend && result === "moved") pages.moveFocus(focus);
    paint();
    if (queued) flush();
  };
  const flush = () => {
    if (!pages || pending || !queued || failed) return;
    const target = terminal.element?.querySelector(".xterm-viewport");
    if (!target) return;
    const direction = Math.sign(queued);
    queued -= direction;
    pending = { direction, extend: dragging };
    // One native wheel notch at a time leaves overlapping rows even when a
    // trackpad sends a large delta. Subsequent notches wait for the actual redraw.
    const rect = screen();
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: rect
        ? Math.max(rect.left + 1, Math.min(rect.right - 1, pointer.x))
        : pointer.x,
      clientY: rect
        ? Math.max(rect.top + 1, Math.min(rect.bottom - 1, pointer.y))
        : pointer.y,
      deltaY: direction,
      deltaMode: 1,
    });
    forwarded.add(event);
    deadline = setTimeout(() => reconcile(true), 1200);
    target.dispatchEvent(event);
    // xterm clears its highlight synchronously when it sends mouse input. The
    // current page is still on screen until the remote redraw arrives.
    paint();
  };
  const enqueue = (direction: number) => {
    if (!begin() || failed) return;
    queued = Math.max(-8, Math.min(8, queued + direction));
    flush();
  };
  const handleWheel = (event: WheelEvent) => {
    // Returning true for our forwarded event leaves it untouched for xterm.
    if (forwarded.has(event)) return true;
    if (
      !enabled() ||
      !canPage() ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      !event.deltaY ||
      (event.target instanceof Element &&
        event.target.closest("[data-terminal-rich]")) ||
      (!pages && !terminal.hasSelection())
    )
      return false;
    pointer = { x: event.clientX, y: event.clientY };
    if (failed) return true; // Keep native scrolling available even on an unrelated page.
    if (!begin()) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    enqueue(Math.sign(event.deltaY));
    return true;
  };
  const edgeScroll = () => {
    if (!dragging || !enabled() || !canPage() || pending || failed) return;
    const rect = screen();
    if (!rect) return;
    const direction =
      pointer.y < rect.top + 5 ? -1 : pointer.y > rect.bottom - 5 ? 1 : 0;
    if (direction) enqueue(direction);
  };
  const down = (event: MouseEvent) => {
    if (
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      !enabled() ||
      !(event.target instanceof Element) ||
      !event.target.closest(".xterm-screen")
    )
      return;
    clear();
    dragging = true;
    pointer = { x: event.clientX, y: event.clientY };
    downPoint = point();
    clearInterval(edge);
    edge = setInterval(edgeScroll, 100);
  };
  const move = (event: MouseEvent) => {
    if (!dragging) return;
    pointer = { x: event.clientX, y: event.clientY };
    if (pages) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!pending && !failed) {
        pages.moveFocus(point());
        paint();
      }
    }
  };
  const up = () => {
    if (pending && dragging) pending.endPoint = point();
    dragging = false;
    queued = 0;
    clearInterval(edge);
  };
  const key = (event: KeyboardEvent) => {
    if (!pages) return;
    if (
      (event.ctrlKey || event.metaKey) &&
      ["c", "shift", "control", "meta"].includes(event.key.toLowerCase())
    )
      return;
    if (["Control", "Shift", "Meta", "Alt"].includes(event.key)) return;
    clear();
    up();
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const parsed = terminal.onWriteParsed(() => {
    if (!pages || failed) return;
    clearTimeout(settle);
    settle = setTimeout(() => {
      if (synchronized()) return;
      if (pending) reconcile();
      else if (pages?.update(frame(), 0) === "unmatched") pauseMapping();
      else paint();
    }, 45);
  });
  const resized = terminal.onResize(clear);
  const buffer = terminal.buffer.onBufferChange(clear);
  mount.addEventListener("mousedown", down, true);
  mount.addEventListener("keydown", key, true);
  mount.addEventListener("paste", clear, true);
  document.addEventListener("mousemove", move, true);
  document.addEventListener("mouseup", up, true);
  document.defaultView?.addEventListener("blur", up);
  return {
    handleWheel,
    getSelection,
    clear,
    dispose() {
      clear();
      up();
      parsed.dispose();
      syncStart.dispose();
      syncEnd.dispose();
      resized.dispose();
      buffer.dispose();
      mount.removeEventListener("mousedown", down, true);
      mount.removeEventListener("keydown", key, true);
      mount.removeEventListener("paste", clear, true);
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mouseup", up, true);
      document.defaultView?.removeEventListener("blur", up);
    },
  };
}
