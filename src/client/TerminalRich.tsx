export { TerminalRich } from "./TerminalTypeset";

/** Copy the original TeX, never duplicate KaTeX's visual and MathML strings. */
export function richSelectedText(root: HTMLElement): string | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const owner = (node: Node) =>
    (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
      "[data-rich-block]",
    );
  const start = owner(range.startContainer),
    end = owner(range.endContainer);
  if (!start || !end || !root.contains(start) || !root.contains(end))
    return null;
  const content = (article: Element) =>
    article.querySelector(".terminal-rich-source") ||
    article.querySelector(".terminal-rich-content") ||
    article;
  const remap = (node: Node, from: Node, to: Node): Node | undefined => {
    const original = node;
    const indices: number[] = [];
    while (node !== from) {
      const parent = node.parentNode;
      if (!parent) return;
      indices.unshift(Array.prototype.indexOf.call(parent.childNodes, node));
      node = parent;
    }
    for (const index of indices) {
      if (!to.childNodes[index]) return;
      to = to.childNodes[index];
    }
    if (
      to.nodeType !== original.nodeType ||
      (to.nodeType === Node.TEXT_NODE &&
        to.textContent !== original.textContent)
    )
      return;
    return to;
  };
  const all = [...root.querySelectorAll<HTMLElement>("[data-rich-block]")];
  const ordered = all.slice(all.indexOf(start), all.indexOf(end) + 1);
  const unique = new Map<string, HTMLElement>();
  for (const article of ordered) {
    const id = article.dataset.richBlock!;
    if (
      !unique.has(id) &&
      (article.dataset.terminalRich === "true" ||
        article === start ||
        article === end)
    )
      unique.set(id, article);
  }
  const chunks: string[] = [];
  for (const [id, article] of unique) {
    // Every clipped fragment contains the same DOM. Map the two endpoints into
    // one copy of the answer instead of copying hidden duplicate fragments.
    const target = content(article),
      selected = root.ownerDocument.createRange();
    selected.selectNodeContents(target);
    if (id === start.dataset.richBlock) {
      const mapped = remap(range.startContainer, content(start), target);
      if (!mapped) return null;
      selected.setStart(mapped, range.startOffset);
    }
    if (id === end.dataset.richBlock) {
      const mapped = remap(range.endContainer, content(end), target);
      if (!mapped) return null;
      selected.setEnd(mapped, range.endOffset);
    }
    chunks.push(selectedRichRange(root, article, selected));
  }
  return chunks.join("\n\n");
}

function selectedRichRange(root: HTMLElement, node: Element, range: Range) {
  const startMath = range.startContainer.parentElement?.closest(".katex");
  if (startMath && startMath.contains(range.endContainer)) {
    const tex = startMath.querySelector(
      'annotation[encoding="application/x-tex"]',
    )?.textContent;
    if (tex) return `$${tex}$`;
  }
  for (const math of node.querySelectorAll(".katex")) {
    const tex = math.querySelector(
      'annotation[encoding="application/x-tex"]',
    )?.textContent;
    if (tex) math.setAttribute("data-harbor-tex", tex);
  }
  const fragment = range.cloneContents();
  for (const math of fragment.querySelectorAll(".katex")) {
    const tex =
      math.querySelector('annotation[encoding="application/x-tex"]')
        ?.textContent || math.getAttribute("data-harbor-tex");
    if (tex) math.replaceWith(root.ownerDocument.createTextNode(`$${tex}$`));
  }
  const container = root.ownerDocument.createElement("div");
  container.append(fragment);
  // Preserve meaningful paragraph/row breaks without reading unrelated blocks.
  for (const br of container.querySelectorAll("br")) br.replaceWith("\n");
  for (const cell of container.querySelectorAll("th,td")) cell.append("\t");
  for (const el of container.querySelectorAll(
    "p, h1, h2, h3, h4, li, tr, pre, blockquote",
  ))
    el.append("\n");
  return (container.textContent || "")
    .replace(/\t+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
