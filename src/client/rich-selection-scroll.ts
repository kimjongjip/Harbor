/** Read and select a complete typeset answer without scrolling the shared CLI. */
export function richSelectionScroll(root: HTMLElement) {
  const document = root.ownerDocument;
  const window = document.defaultView!;
  let dragging = false;
  let pointer = { x: 0, y: 0 };
  let candidate: HTMLElement | undefined;
  let reader:
    | { article: HTMLElement; canvas: HTMLElement; scrollTop: number }
    | undefined;
  let edge: ReturnType<typeof setInterval> | undefined;
  const selectedCanvas = () => {
    const selection = document.getSelection();
    if (!selection?.anchorNode || selection.isCollapsed) return;
    const anchor =
      selection.anchorNode instanceof Element
        ? selection.anchorNode
        : selection.anchorNode.parentElement;
    const canvas = anchor?.closest<HTMLElement>(".terminal-rich-canvas");
    if (
      canvas &&
      root.contains(canvas) &&
      !canvas.closest(".terminal-rich-card")
    )
      return canvas;
  };
  const close = () => {
    if (!reader) return;
    const { article, canvas, scrollTop } = reader;
    reader = undefined;
    delete article.dataset.richSelectionReader;
    for (const name of ["top", "left", "width", "height"])
      article.style.removeProperty(`--rich-reader-${name}`);
    canvas.scrollTop = scrollTop;
  };
  const open = (canvas: HTMLElement) => {
    if (reader?.canvas === canvas) return reader;
    const article = canvas.closest<HTMLElement>("article[data-rich-block]");
    if (!article || !root.contains(article)) return;
    const rect = article.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.right < 0) return;
    close();
    const bounds = root.getBoundingClientRect();
    const offset = Math.max(0, -parseFloat(canvas.style.top || "0"));
    reader = { article, canvas, scrollTop: canvas.scrollTop };
    // Keep the selected DOM and its visible rectangle even if the CLI repaints
    // or virtualizes its reservation while the user is copying this answer.
    for (const [name, value] of Object.entries({
      top: rect.top - bounds.top,
      left: rect.left - bounds.left,
      width: rect.width,
      height: rect.height,
    }))
      article.style.setProperty(`--rich-reader-${name}`, `${value}px`);
    article.dataset.richSelectionReader = "true";
    canvas.scrollTop += offset;
    return reader;
  };
  const extend = () => {
    if (!dragging || !reader) return;
    const selection = document.getSelection();
    if (!selection?.anchorNode || !reader.canvas.contains(selection.anchorNode))
      return;
    const rect = reader.canvas.getBoundingClientRect();
    const x = Math.max(rect.left + 2, Math.min(rect.right - 2, pointer.x));
    const y = Math.max(rect.top + 2, Math.min(rect.bottom - 2, pointer.y));
    const point = document.caretRangeFromPoint(x, y);
    if (point && reader.canvas.contains(point.startContainer))
      selection.setBaseAndExtent(
        selection.anchorNode,
        selection.anchorOffset,
        point.startContainer,
        point.startOffset,
      );
  };
  const scroll = (amount: number) => {
    if (!reader || !amount) return;
    reader.canvas.scrollTop += amount;
    extend();
  };
  const tick = () => {
    if (!dragging || !candidate) return;
    const canvas = selectedCanvas();
    if (canvas !== candidate) return;
    const article = canvas.closest<HTMLElement>("article[data-rich-block]");
    if (!article) return;
    const rect = article.getBoundingClientRect();
    const margin = Math.min(28, rect.height / 4);
    const direction =
      pointer.y < rect.top + margin
        ? -1
        : pointer.y > rect.bottom - margin
          ? 1
          : 0;
    if (!direction || !open(canvas)) return;
    scroll(direction * 14);
  };
  const finish = () => {
    dragging = false;
    candidate = undefined;
    clearInterval(edge);
    edge = undefined;
  };
  const down = (event: MouseEvent) => {
    const canvas =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>(".terminal-rich-canvas")
        : undefined;
    if (
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      !canvas ||
      !root.contains(canvas) ||
      canvas.closest(".terminal-rich-card")
    ) {
      finish();
      close();
      return;
    }
    if (reader && reader.canvas !== canvas) close();
    dragging = true;
    candidate = canvas;
    pointer = { x: event.clientX, y: event.clientY };
    clearInterval(edge);
    edge = setInterval(tick, 30);
  };
  const move = (event: MouseEvent) => {
    if (!dragging) return;
    if (!(event.buttons & 1)) {
      finish();
      return;
    }
    pointer = { x: event.clientX, y: event.clientY };
    if (reader) {
      event.preventDefault();
      extend();
    }
  };
  const changed = () => {
    if (reader && !dragging && selectedCanvas() !== reader.canvas) close();
  };
  const escape = (event: KeyboardEvent) => {
    if (reader && event.key === "Escape") {
      const sameContext =
        event.target === document.body ||
        event.target === document.documentElement ||
        event.target === document ||
        (event.target instanceof Node &&
          root.parentElement?.contains(event.target));
      if (selectedCanvas() !== reader.canvas || !sameContext) {
        finish();
        close();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      finish();
      close();
      document.getSelection()?.removeAllRanges();
    }
  };
  const handleWheel = (event: WheelEvent) => {
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      !event.deltaY ||
      Math.abs(event.deltaX) > Math.abs(event.deltaY)
    )
      return false;
    const canvas = selectedCanvas();
    if (!canvas || !open(canvas)) return false;
    event.preventDefault();
    event.stopPropagation();
    const line = parseFloat(window.getComputedStyle(canvas).lineHeight) || 24;
    scroll(
      event.deltaY *
        (event.deltaMode === 1
          ? line
          : event.deltaMode === 2
            ? canvas.clientHeight
            : 1),
    );
    return true;
  };
  const wheel = (event: WheelEvent) => {
    // A held drag can leave the answer rectangle. Catch its wheel before
    // xterm's ancestor capture listener, which has no alt-buffer scrollback.
    if (
      (dragging || reader) &&
      event.target instanceof Node &&
      root.parentElement?.contains(event.target) &&
      !(
        event.target instanceof Element &&
        event.target.closest(".terminal-rich-source, .terminal-rich-card")
      )
    )
      handleWheel(event);
  };
  document.addEventListener("mousedown", down, true);
  document.addEventListener("mousemove", move, true);
  document.addEventListener("mouseup", finish, true);
  document.addEventListener("selectionchange", changed);
  document.addEventListener("keydown", escape, true);
  document.addEventListener("wheel", wheel, { capture: true, passive: false });
  window.addEventListener("blur", finish);
  return {
    handleWheel,
    dispose() {
      finish();
      close();
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mouseup", finish, true);
      document.removeEventListener("selectionchange", changed);
      document.removeEventListener("keydown", escape, true);
      document.removeEventListener("wheel", wheel, true);
      window.removeEventListener("blur", finish);
    },
  };
}
