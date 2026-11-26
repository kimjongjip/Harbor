import type { Terminal } from "@xterm/xterm";
import { terminalContentEnd } from "./terminal-flow";

/** One native phone scroller over the local mirror. No PTY resize or CLI input. */
export function mobileTerminalViewport(
  term: Terminal,
  scroller: HTMLElement,
  host: HTMLElement,
  changed: (following: boolean, unread: boolean) => void,
) {
  const element = term.element!;
  const screen = element.querySelector<HTMLElement>(".xterm-screen")!;
  let following = true,
    unread = false,
    paused = false,
    frame = 0,
    cellHeight = 1;
  let previousTop = 0,
    disposed = false;
  let flow: HTMLElement | null = null,
    transitioning = false,
    settleFrame = 0;
  const report = () => changed(following, unread);
  const position = () => {
    if (flow) return;
    const row = Math.min(
      term.buffer.active.baseY,
      Math.max(0, Math.floor((scroller.scrollTop - 8) / cellHeight)),
    );
    if (term.buffer.active.viewportY !== row) term.scrollToLine(row);
    element.style.top = `${8 + row * cellHeight}px`;
  };
  const layout = () => {
    frame = 0;
    if (disposed || paused || !screen.clientHeight || !scroller.clientHeight)
      return;
    const oldCellHeight = cellHeight;
    cellHeight = screen.clientHeight / term.rows;
    const end = terminalContentEnd(term.buffer.active);
    host.style.height = `${Math.max(scroller.clientHeight, end * cellHeight + 16)}px`;
    host.style.width = `${screen.clientWidth + 16}px`;
    if (following) scroller.scrollTop = scroller.scrollHeight;
    else if (transitioning) scroller.scrollTop = previousTop;
    else if (!flow && oldCellHeight > 1 && cellHeight !== oldCellHeight)
      scroller.scrollTop = (previousTop / oldCellHeight) * cellHeight;
    previousTop = scroller.scrollTop;
    position();
    cancelAnimationFrame(settleFrame);
    settleFrame = requestAnimationFrame(() => {
      transitioning = false;
    });
  };
  const refresh = () => {
    if (!frame && !disposed) frame = requestAnimationFrame(layout);
  };
  const scroll = () => {
    if (paused || transitioning || !scroller.clientHeight) return;
    const movingDown = scroller.scrollTop > previousTop + 1;
    previousTop = scroller.scrollTop;
    const atBottom =
      scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 24;
    if (!atBottom) following = false;
    else if (movingDown) following = true;
    if (following) unread = false;
    position();
    report();
  };
  // The outer element owns touch/wheel scrolling. xterm's native scroll handler
  // would otherwise consume it or send arrow keys in alternate-screen mode.
  const gesture = (event: Event) => {
    event.stopPropagation();
  };
  const pauseFollowing = () => {
    if (!following) return;
    following = false;
    report();
  };
  let touchY: number | undefined;
  const wheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    if (event.deltaY < 0) pauseFollowing();
    // Chromium may retain the old scroll target after the live/frozen DOM
    // update. Route vertical wheel movement to this one reading surface.
    // Touch retains native momentum, and horizontal table/code gestures remain
    // with their own container. Never forward wheel input to the CLI.
    if (flow && event.deltaY) {
      event.preventDefault();
      const unit =
        event.deltaMode === 1
          ? cellHeight
          : event.deltaMode === 2
            ? scroller.clientHeight
            : 1;
      scroller.scrollBy({ top: event.deltaY * unit, behavior: "instant" });
    }
  };
  const touchStart = (event: TouchEvent) => {
    touchY = event.touches[0]?.clientY;
  };
  const touchMove = (event: TouchEvent) => {
    const y = event.touches[0]?.clientY;
    if (y !== undefined && touchY !== undefined && y > touchY + 2)
      pauseFollowing();
    touchY = y;
  };
  scroller.addEventListener("wheel", wheel, { capture: true, passive: false });
  scroller.addEventListener("touchstart", touchStart, {
    capture: true,
    passive: true,
  });
  scroller.addEventListener("touchmove", touchMove, {
    capture: true,
    passive: true,
  });
  scroller.addEventListener("scroll", scroll, { passive: true });
  for (const type of ["wheel", "touchstart", "touchmove"])
    host.addEventListener(type, gesture, { capture: true, passive: true });
  const listeners = [term.onRender(refresh), term.onResize(refresh)];
  const resize = new ResizeObserver(refresh);
  resize.observe(screen);
  resize.observe(scroller);
  refresh();
  report();
  return {
    refresh,
    setFlow(node: HTMLElement | null) {
      if (disposed || node === flow) return;
      if (flow) resize.unobserve(flow);
      flow = node;
      transitioning = true;
      host.classList.toggle("terminal-source-hidden", !!node);
      host.setAttribute("aria-hidden", String(!!node));
      if (flow) resize.observe(flow);
      refresh();
    },
    latest() {
      following = true;
      unread = false;
      report();
      refresh();
    },
    beforeReplay() {
      paused = true;
    },
    afterReplay() {
      paused = false;
      scroller.scrollTop = previousTop;
      refresh();
    },
    output() {
      if (!following) {
        unread = true;
        report();
      }
      refresh();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      cancelAnimationFrame(settleFrame);
      host.classList.remove("terminal-source-hidden");
      host.removeAttribute("aria-hidden");
      resize.disconnect();
      listeners.forEach((listener) => listener.dispose());
      scroller.removeEventListener("scroll", scroll);
      scroller.removeEventListener("wheel", wheel, true);
      scroller.removeEventListener("touchstart", touchStart, true);
      scroller.removeEventListener("touchmove", touchMove, true);
      for (const type of ["wheel", "touchstart", "touchmove"])
        host.removeEventListener(type, gesture, true);
    },
  };
}
