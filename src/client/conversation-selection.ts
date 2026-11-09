/** Browser text selection across the entire transcript, including held-drag wheel/edge scroll. */
export function conversationSelection(
  body: HTMLElement,
  onReachStart?: () => void,
) {
  const doc = body.ownerDocument;
  const win = doc.defaultView!;
  let dragging = false;
  let point = { x: 0, y: 0 };
  let edge: ReturnType<typeof setInterval> | undefined;
  const extend = () => {
    const selection = doc.getSelection();
    if (
      !dragging ||
      !selection?.anchorNode ||
      !body.contains(selection.anchorNode)
    )
      return;
    const box = body.getBoundingClientRect();
    const caret = doc.caretRangeFromPoint(
      Math.max(box.left + 3, Math.min(box.right - 16, point.x)),
      Math.max(box.top + 3, Math.min(box.bottom - 3, point.y)),
    );
    if (caret && body.contains(caret.startContainer))
      selection.setBaseAndExtent(
        selection.anchorNode,
        selection.anchorOffset,
        caret.startContainer,
        caret.startOffset,
      );
  };
  const finish = () => {
    dragging = false;
    clearInterval(edge);
    edge = undefined;
  };
  const down = (event: MouseEvent) => {
    if (
      event.button ||
      !(event.target instanceof Element) ||
      event.target.closest("button,summary,a,input,textarea")
    )
      return;
    dragging = true;
    point = { x: event.clientX, y: event.clientY };
    clearInterval(edge);
    edge = setInterval(() => {
      if (!dragging) return;
      const box = body.getBoundingClientRect();
      const delta =
        point.y < box.top + 24 ? -16 : point.y > box.bottom - 24 ? 16 : 0;
      if (delta) {
        body.scrollTop += delta;
        extend();
        if (delta < 0 && body.scrollTop < 24) onReachStart?.();
      }
    }, 30);
  };
  const move = (event: MouseEvent) => {
    if (!dragging) return;
    if (!(event.buttons & 1)) return finish();
    point = { x: event.clientX, y: event.clientY };
  };
  const wheel = (event: WheelEvent) => {
    if (!dragging || event.ctrlKey || event.metaKey || !event.deltaY) return;
    event.preventDefault();
    event.stopPropagation();
    body.scrollTop +=
      event.deltaY *
      (event.deltaMode === 1
        ? 24
        : event.deltaMode === 2
          ? body.clientHeight
          : 1);
    extend();
    if (event.deltaY < 0 && body.scrollTop < 24) onReachStart?.();
  };
  body.addEventListener("mousedown", down);
  doc.addEventListener("mousemove", move, true);
  doc.addEventListener("mouseup", finish, true);
  body.addEventListener("wheel", wheel, { passive: false });
  win.addEventListener("blur", finish);
  return () => {
    finish();
    body.removeEventListener("mousedown", down);
    doc.removeEventListener("mousemove", move, true);
    doc.removeEventListener("mouseup", finish, true);
    body.removeEventListener("wheel", wheel);
    win.removeEventListener("blur", finish);
  };
}
