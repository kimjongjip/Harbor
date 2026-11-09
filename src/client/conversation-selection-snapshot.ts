interface Boundary {
  node: Node;
  offset: number;
  blockId?: string;
  text?: string;
  textOffset?: number;
}
export interface ConversationSelectionSnapshot {
  anchor: Boundary;
  focus: Boundary;
}

/** Keep the original nodes when possible; a page boundary can regroup a partial turn. */
export function captureConversationSelection(
  root: HTMLElement,
): ConversationSelectionSnapshot | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection?.anchorNode || !selection.focusNode || selection.isCollapsed)
    return null;
  const capture = (node: Node, offset: number): Boundary => {
    const article = (
      node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement
    )?.closest<HTMLElement>("[data-rich-block]");
    if (!article || !root.contains(article)) return { node, offset };
    const range = root.ownerDocument.createRange();
    range.selectNodeContents(article);
    range.setEnd(node, offset);
    return {
      node,
      offset,
      blockId: article.dataset.richBlock,
      text: article.textContent || "",
      textOffset: range.toString().length,
    };
  };
  return {
    anchor: capture(selection.anchorNode, selection.anchorOffset),
    focus: capture(selection.focusNode, selection.focusOffset),
  };
}

export function restoreConversationSelection(
  root: HTMLElement,
  snapshot: ConversationSelectionSnapshot,
): boolean {
  const resolve = (
    boundary: Boundary,
  ): { node: Node; offset: number } | undefined => {
    if (boundary.node.isConnected) return boundary;
    if (!boundary.blockId) return;
    const article = [
      ...root.querySelectorAll<HTMLElement>("[data-rich-block]"),
    ].find((element) => element.dataset.richBlock === boundary.blockId);
    if (!article || article.textContent !== boundary.text) return;
    const walker = root.ownerDocument.createTreeWalker(
      article,
      NodeFilter.SHOW_TEXT,
    );
    let remaining = boundary.textOffset || 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (remaining <= (node.textContent?.length || 0))
        return { node, offset: remaining };
      remaining -= node.textContent?.length || 0;
    }
  };
  const anchor = resolve(snapshot.anchor),
    focus = resolve(snapshot.focus);
  if (!anchor || !focus) return false;
  root.ownerDocument
    .getSelection()
    ?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  return true;
}
