import type { Terminal } from "@xterm/xterm";

/** Use xterm's native drag/word/line selection and autoscroll, never our own coordinates. */
export function installTerminalSelection(mount: HTMLElement, terminal: Terminal, enabled: () => boolean) {
  const forwarded = new WeakSet<Event>();
  const down = (event: MouseEvent) => {
    if (forwarded.has(event) || !enabled() || terminal.modes.mouseTrackingMode === "none" ||
        event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    // Native Shift-selection bypasses a TUI's mouse reporting. Forward only the
    // initial press; xterm owns movement, mouseup, wide characters and scrolling.
    const target = event.target;
    if (!(target instanceof Element)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const press = new MouseEvent("mousedown", {
      bubbles: true, cancelable: true, view: mount.ownerDocument.defaultView,
      clientX: event.clientX, clientY: event.clientY,
      screenX: event.screenX, screenY: event.screenY,
      button: event.button, buttons: event.buttons, detail: event.detail || 1,
      shiftKey: true,
    });
    forwarded.add(press);
    target.dispatchEvent(press);
  };
  // Reasserting an already active mouse protocol is a no-op. xterm otherwise
  // disables its selection service again, destroying an in-progress native drag.
  const protocols: Record<number, string> = { 9: "x10", 1000: "vt200", 1002: "drag", 1003: "any" };
  const repeatedMode = terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, params =>
    params.length === 1 && typeof params[0] === "number" &&
    protocols[params[0]] === terminal.modes.mouseTrackingMode,
  );
  const hover = (event: MouseEvent) => {
    // Any-motion reporting treats hovering after mouseup as terminal input and
    // clears selection. Keep a completed selection while moving to Copy.
    if (enabled() && !event.buttons && !event.altKey && terminal.hasSelection())
      event.stopImmediatePropagation();
  };
  mount.addEventListener("mousedown", down, true);
  mount.addEventListener("mousemove", hover, true);
  return () => {
    mount.removeEventListener("mousedown", down, true);
    mount.removeEventListener("mousemove", hover, true);
    repeatedMode.dispose();
  };
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
