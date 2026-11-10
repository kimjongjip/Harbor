import type { Terminal } from "@xterm/xterm";

/** Move xterm's real IME UI to the projected cursor; input still belongs to xterm. */
export function projectNativeComposition(
  term: Terminal,
  cursor: () => HTMLElement | null | undefined,
  surface: HTMLElement,
) {
  const textarea = term.textarea;
  const helpers = term.element?.querySelector<HTMLElement>(".xterm-helpers");
  const composition = helpers?.querySelector<HTMLElement>(".composition-view");
  if (!textarea || !helpers || !composition) return () => {};

  let composing = false,
    disposed = false,
    scheduled = false,
    offsetX = 0,
    offsetY = 0;
  const originalTransform = helpers.style.transform;
  const reset = () => {
    helpers.classList.remove("terminal-native-ime");
    helpers.style.transform = originalTransform;
    offsetX = offsetY = 0;
  };
  const position = () => {
    scheduled = false;
    if (disposed || !composing) return;
    const anchor = cursor();
    if (!anchor?.getClientRects().length) {
      reset();
      return;
    }
    const target = anchor.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(composition);
    // The projected cursor is an inline glyph box, not a line-height box.
    const source = composition.textContent
      ? range.getBoundingClientRect()
      : composition.getBoundingClientRect();
    offsetX += target.left - source.left;
    offsetY += target.top - source.top;
    helpers.classList.add("terminal-native-ime");
    helpers.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
  };
  const schedule = () => {
    if (disposed || !composing || scheduled) return;
    scheduled = true;
    // xterm first updates the composition text/textarea at its buffer cursor.
    // Translate both together afterwards, before paint, without changing input.
    queueMicrotask(position);
  };
  const changed = () => {
    if (!composing) {
      observer.observe(composition, {
        attributes: true,
        attributeFilter: ["style"],
      });
      observer.observe(surface, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      geometry.observe(surface);
    }
    composing = true;
    schedule();
  };
  const ended = () => {
    composing = false;
    observer.disconnect();
    geometry.disconnect();
    reset();
  };
  // xterm also refreshes the helper coordinates asynchronously while composing.
  const observer = new MutationObserver(schedule);
  const geometry = new ResizeObserver(schedule);
  textarea.addEventListener("compositionstart", changed);
  textarea.addEventListener("compositionupdate", changed);
  textarea.addEventListener("compositionend", ended);
  textarea.addEventListener("blur", ended);
  document.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);
  if (composition.classList.contains("active")) changed();
  return () => {
    disposed = true;
    ended();
    textarea.removeEventListener("compositionstart", changed);
    textarea.removeEventListener("compositionupdate", changed);
    textarea.removeEventListener("compositionend", ended);
    textarea.removeEventListener("blur", ended);
    document.removeEventListener("scroll", schedule, true);
    window.removeEventListener("resize", schedule);
  };
}
