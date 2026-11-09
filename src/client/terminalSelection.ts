import type { Terminal } from "@xterm/xterm";
import { applicationSelection } from "./terminal-app-selection";

/** Use native selection for scrollback; retain verified pages for a fullscreen CLI. */
export function installTerminalSelection(
  mount: HTMLElement,
  terminal: Terminal,
  enabled: () => boolean,
  options: { onChange?(): void; onNotice?(message: string): void } = {},
) {
  const application = applicationSelection(mount, terminal, enabled, options);
  const forwarded = new WeakSet<Event>();
  let dragging = false;
  let pointer: { x: number; y: number } | undefined;
  let remainder = 0;
  const hasBrowserSelection = () => {
    const selection = mount.ownerDocument.getSelection();
    return (
      !!selection &&
      !selection.isCollapsed &&
      mount.contains(selection.anchorNode)
    );
  };
  const down = (event: MouseEvent) => {
    const target = event.target;
    if (
      !forwarded.has(event) &&
      enabled() &&
      event.button === 0 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      target instanceof Element &&
      target.closest(".xterm-screen")
    ) {
      dragging = true;
      pointer = { x: event.clientX, y: event.clientY };
    }
    if (
      forwarded.has(event) ||
      !enabled() ||
      terminal.modes.mouseTrackingMode === "none" ||
      event.button !== 0 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    // Native Shift-selection bypasses a TUI's mouse reporting. Forward only the
    // initial press; xterm owns movement, mouseup, wide characters and scrolling.
    if (!(target instanceof Element)) return;
    if (target.closest("[data-terminal-rich]")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const press = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      view: mount.ownerDocument.defaultView,
      clientX: event.clientX,
      clientY: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY,
      button: event.button,
      buttons: event.buttons,
      detail: event.detail || 1,
      shiftKey: true,
    });
    forwarded.add(press);
    target.dispatchEvent(press);
  };
  // Reasserting an already active mouse protocol is a no-op. xterm otherwise
  // disables its selection service again, destroying an in-progress native drag.
  const protocols: Record<number, string> = {
    9: "x10",
    1000: "vt200",
    1002: "drag",
    1003: "any",
  };
  const repeatedMode = terminal.parser.registerCsiHandler(
    { prefix: "?", final: "h" },
    (params) =>
      params.length === 1 &&
      typeof params[0] === "number" &&
      protocols[params[0]] === terminal.modes.mouseTrackingMode,
  );
  const hover = (event: MouseEvent) => {
    if (dragging) pointer = { x: event.clientX, y: event.clientY };
    if (
      event.target instanceof Element &&
      event.target.closest("[data-terminal-rich]")
    )
      return;
    // Any-motion reporting treats hovering after mouseup as terminal input and
    // clears selection. Keep a completed selection while moving to Copy.
    if (
      enabled() &&
      !event.buttons &&
      !event.altKey &&
      (terminal.hasSelection() ||
        application.getSelection() ||
        hasBrowserSelection())
    )
      event.stopImmediatePropagation();
  };
  const finish = () => {
    dragging = false;
    pointer = undefined;
    remainder = 0;
  };
  const wheel = (event: WheelEvent) => {
    if (application.handleWheel(event)) return;
    if (
      !enabled() ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      (!dragging && !terminal.hasSelection() && !hasBrowserSelection()) ||
      !event.deltaY ||
      (event.target instanceof Element &&
        event.target.closest("[data-terminal-rich]"))
    )
      return;
    // A mouse report (or alt-buffer arrow key) is user input to xterm and clears
    // its selection. While copying, scroll the retained screen buffer locally.
    // Never send wheel input and then restore old coordinates onto a new TUI page.
    event.preventDefault();
    event.stopImmediatePropagation();
    const screen = terminal.element?.querySelector(".xterm-screen");
    const cellHeight =
      (screen?.getBoundingClientRect().height || terminal.rows * 20) /
      terminal.rows;
    remainder +=
      event.deltaY *
      (event.deltaMode === 1
        ? 1
        : event.deltaMode === 2
          ? terminal.rows
          : 1 / cellHeight);
    const lines = Math.trunc(remainder);
    remainder -= lines;
    if (!lines) return;
    terminal.scrollLines(lines);
    // Native selection owns wrapping, wide characters, anchors and autoscroll.
    // Wheel alone need not move the mouse; update the endpoint at its new row.
    if (dragging && pointer)
      mount.ownerDocument.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          buttons: 1,
          button: 0,
          clientX: pointer.x,
          clientY: pointer.y,
          shiftKey: true,
          view: mount.ownerDocument.defaultView,
        }),
      );
  };
  mount.addEventListener("mousedown", down, true);
  mount.addEventListener("mousemove", hover, true);
  mount.addEventListener("wheel", wheel, { capture: true, passive: false });
  mount.ownerDocument.addEventListener("mouseup", finish, true);
  mount.ownerDocument.defaultView?.addEventListener("blur", finish);
  const dispose = () => {
    application.dispose();
    mount.removeEventListener("mousedown", down, true);
    mount.removeEventListener("mousemove", hover, true);
    mount.removeEventListener("wheel", wheel, true);
    mount.ownerDocument.removeEventListener("mouseup", finish, true);
    mount.ownerDocument.defaultView?.removeEventListener("blur", finish);
    repeatedMode.dispose();
  };
  return Object.assign(dispose, {
    getSelection: application.getSelection,
    clear: application.clear,
  });
}

export async function writeLocalClipboard(text: string) {
  if (window.harborDesktop?.writeClipboardText) {
    try {
      if (await window.harborDesktop.writeClipboardText(text)) return;
    } catch {
      // A renderer may outlive a desktop update; retain the browser fallback.
    }
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    // Older desktop builds and browsers without Clipboard API permissions.
    const document = window.document;
    let handled = false;
    const writeEvent = (event: ClipboardEvent) => {
      if (!event.clipboardData) return;
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
      event.stopImmediatePropagation();
      handled = true;
    };
    window.addEventListener("copy", writeEvent, true);
    try {
      if (document.execCommand("copy") && handled) return;
    } finally {
      window.removeEventListener("copy", writeEvent, true);
    }
    const active = document.activeElement as HTMLElement | null;
    const selection = document.getSelection();
    const ranges = selection
      ? Array.from({ length: selection.rangeCount }, (_, index) =>
          selection.getRangeAt(index).cloneRange(),
        )
      : [];
    const input = document.createElement("textarea");
    input.value = text;
    input.style.cssText = "position:fixed;left:-10000px;top:0;opacity:0";
    input.dataset.terminalClipboardFallback = "true";
    document.body.append(input);
    input.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } finally {
      input.remove();
      active?.focus({ preventScroll: true });
      if (ranges.length && selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    }
    if (!copied) throw error;
  }
}

export function terminalQuote(text: string) {
  return (
    text
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n") + "\n\n이 부분에 대해: "
  );
}
