export type DropEdge = "center" | "left" | "right" | "top" | "bottom";
export type DropScope = "pane" | "workspace";
export type PaneTree =
  | { kind: "leaf"; terminalId: string }
  | {
      kind: "split";
      id: string;
      axis: "column" | "row";
      ratio: number;
      first: PaneTree;
      second: PaneTree;
    };
export interface TerminalTree {
  tree: PaneTree | null;
  focusedId: string;
}
export interface TerminalPlacement {
  terminalId: string;
  targetTerminalId?: string;
  edge?: DropEdge;
  scope?: DropScope;
  slot?: number;
  layout?: 1 | 2;
  pairTerminalIds?: string[];
}
export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface DividerRect extends PaneRect {
  id: string;
  axis: "column" | "row";
  ratio: number;
  parent: PaneRect;
}
export const splitGap = 6;
const leaf = (terminalId: string): PaneTree => ({ kind: "leaf", terminalId });
const split = (
  axis: "column" | "row",
  first: PaneTree,
  second: PaneTree,
): PaneTree => ({
  kind: "split",
  id: crypto.randomUUID(),
  axis,
  ratio: 0.5,
  first,
  second,
});
export function paneIds(tree: PaneTree | null): string[] {
  return !tree
    ? []
    : tree.kind === "leaf"
      ? [tree.terminalId]
      : [...paneIds(tree.first), ...paneIds(tree.second)];
}
function mapLeaves(tree: PaneTree, map: (id: string) => string): PaneTree {
  return tree.kind === "leaf"
    ? leaf(map(tree.terminalId))
    : {
        ...tree,
        first: mapLeaves(tree.first, map),
        second: mapLeaves(tree.second, map),
      };
}
function filterTree(
  tree: PaneTree | null,
  keep: (id: string) => boolean,
): PaneTree | null {
  if (!tree) return null;
  if (tree.kind === "leaf") return keep(tree.terminalId) ? tree : null;
  const first = filterTree(tree.first, keep),
    second = filterTree(tree.second, keep);
  return first && second ? { ...tree, first, second } : first || second;
}
function replaceLeaf(
  tree: PaneTree,
  target: string,
  replacement: PaneTree,
): PaneTree {
  return tree.kind === "leaf"
    ? tree.terminalId === target
      ? replacement
      : tree
    : {
        ...tree,
        first: replaceLeaf(tree.first, target, replacement),
        second: replaceLeaf(tree.second, target, replacement),
      };
}
export function reconcileTree(
  previous: TerminalTree,
  available: string[],
  selected: string,
): TerminalTree {
  const seen = new Set<string>();
  let tree = filterTree(previous.tree, (id) => {
    if (!available.includes(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  let ids = paneIds(tree);
  if (!tree) {
    const id = available.includes(selected) ? selected : available[0];
    return { tree: id ? leaf(id) : null, focusedId: id || "" };
  }
  if (available.includes(selected) && !ids.includes(selected)) {
    const target = ids.includes(previous.focusedId)
      ? previous.focusedId
      : ids[0];
    tree = replaceLeaf(tree, target, leaf(selected));
    ids = paneIds(tree);
  }
  const focusedId = ids.includes(selected)
    ? selected
    : ids.includes(previous.focusedId)
      ? previous.focusedId
      : ids[0];
  return { tree, focusedId };
}
export function placeInTree(
  previous: TerminalTree,
  id: string,
  target: string | undefined,
  edge: DropEdge = "center",
  scope: DropScope = "pane",
): TerminalTree {
  if (!previous.tree) return { tree: leaf(id), focusedId: id };
  const ids = paneIds(previous.tree);
  const anchor =
    target && ids.includes(target)
      ? target
      : ids.includes(previous.focusedId)
        ? previous.focusedId
        : ids[0];
  if (edge === "center") {
    const tree = ids.includes(id)
      ? mapLeaves(previous.tree, (current) =>
          current === id ? anchor : current === anchor ? id : current,
        )
      : replaceLeaf(previous.tree, anchor, leaf(id));
    return { tree, focusedId: id };
  }
  if (
    (id === anchor && scope === "pane") ||
    (ids.length === 1 && ids[0] === id)
  )
    return { ...previous, focusedId: id };
  if (!ids.includes(id) && ids.length >= 16)
    throw new Error("한 화면에는 최대 16개 터미널을 배치할 수 있습니다.");
  let tree = filterTree(previous.tree, (current) => current !== id);
  if (!tree) return { tree: leaf(id), focusedId: id };
  const before = edge === "left" || edge === "top";
  const axis = edge === "left" || edge === "right" ? "column" : "row";
  if (scope === "workspace")
    tree = before ? split(axis, leaf(id), tree) : split(axis, tree, leaf(id));
  else {
    const currentAnchor = paneIds(tree).includes(anchor)
      ? anchor
      : paneIds(tree)[0];
    tree = replaceLeaf(
      tree,
      currentAnchor,
      before
        ? split(axis, leaf(id), leaf(currentAnchor))
        : split(axis, leaf(currentAnchor), leaf(id)),
    );
  }
  return { tree, focusedId: id };
}
export function presetTree(ids: string[], focusedId: string): TerminalTree {
  const distinct = [...new Set(ids)].slice(0, 16);
  const group = (items: string[], axis: "column" | "row"): PaneTree => {
    if (items.length === 1) return leaf(items[0]);
    const middle = Math.ceil(items.length / 2);
    return split(
      axis,
      group(items.slice(0, middle), axis === "row" ? "column" : "row"),
      group(items.slice(middle), axis === "row" ? "column" : "row"),
    );
  };
  const tree = distinct.length
    ? group(distinct, distinct.length < 3 ? "column" : "row")
    : null;
  return {
    tree,
    focusedId: distinct.includes(focusedId) ? focusedId : distinct[0] || "",
  };
}
export function resizeTree(
  tree: PaneTree | null,
  ratios: Record<string, number>,
): PaneTree | null {
  if (!tree || tree.kind === "leaf") return tree;
  return {
    ...tree,
    ratio: Number.isFinite(ratios[tree.id])
      ? Math.max(0.1, Math.min(0.9, ratios[tree.id]))
      : tree.ratio,
    first: resizeTree(tree.first, ratios)!,
    second: resizeTree(tree.second, ratios)!,
  };
}
export function treeRects(
  tree: PaneTree | null,
  width: number,
  height: number,
) {
  const panes: Record<string, PaneRect> = {},
    dividers: DividerRect[] = [];
  function visit(node: PaneTree, rect: PaneRect) {
    if (node.kind === "leaf") {
      panes[node.terminalId] = rect;
      return;
    }
    const vertical = node.axis === "column";
    const extent = Math.max(
      0,
      (vertical ? rect.width : rect.height) - splitGap,
    );
    const minimum = Math.min(
      0.45,
      (vertical ? 180 : 100) / Math.max(1, extent),
    );
    const ratio = Math.max(minimum, Math.min(1 - minimum, node.ratio));
    const size = extent * ratio;
    const divider = {
      ...rect,
      id: node.id,
      axis: node.axis,
      ratio,
      parent: rect,
    };
    if (vertical) {
      divider.x += size;
      divider.width = splitGap;
      visit(node.first, { ...rect, width: size });
      visit(node.second, {
        ...rect,
        x: rect.x + size + splitGap,
        width: extent - size,
      });
    } else {
      divider.y += size;
      divider.height = splitGap;
      visit(node.first, { ...rect, height: size });
      visit(node.second, {
        ...rect,
        y: rect.y + size + splitGap,
        height: extent - size,
      });
    }
    dividers.push(divider);
  }
  if (tree) visit(tree, { x: 0, y: 0, width, height });
  return { panes, dividers };
}
export function splitJunctions(dividers: DividerRect[]) {
  const groups = new Map<string, { x: number; y: number; ids: string[] }>();
  for (const column of dividers.filter((d) => d.axis === "column")) {
    for (const row of dividers.filter((d) => d.axis === "row")) {
      const x = column.x + splitGap / 2,
        y = row.y + splitGap / 2;
      if (
        x < row.x ||
        x > row.x + row.width ||
        y < column.y - splitGap ||
        y > column.y + column.height + splitGap
      )
        continue;
      const key = `${Math.round(x)},${Math.round(y)}`;
      const group = groups.get(key) || { x, y, ids: [] };
      group.ids = [...new Set([...group.ids, column.id, row.id])];
      groups.set(key, group);
    }
  }
  return [...groups.values()];
}
export function decodeTree(value: unknown): TerminalTree | null {
  if (!value || typeof value !== "object") return null;
  const saved = value as { tree?: unknown; focusedId?: unknown };
  const ids = new Set<string>(),
    splitIds = new Set<string>();
  function decode(raw: unknown, depth: number): PaneTree | null {
    if (!raw || typeof raw !== "object" || depth > 16) return null;
    const node = raw as Record<string, unknown>;
    if (
      node.kind === "leaf" &&
      typeof node.terminalId === "string" &&
      node.terminalId.length <= 256 &&
      !ids.has(node.terminalId) &&
      ids.size < 16
    ) {
      ids.add(node.terminalId);
      return leaf(node.terminalId);
    }
    if (
      node.kind !== "split" ||
      typeof node.id !== "string" ||
      splitIds.has(node.id) ||
      !["column", "row"].includes(String(node.axis)) ||
      typeof node.ratio !== "number" ||
      !Number.isFinite(node.ratio)
    )
      return null;
    splitIds.add(node.id);
    const first = decode(node.first, depth + 1),
      second = decode(node.second, depth + 1);
    return first && second
      ? {
          kind: "split",
          id: node.id,
          axis: node.axis as "row" | "column",
          ratio: Math.max(0.1, Math.min(0.9, node.ratio)),
          first,
          second,
        }
      : first || second;
  }
  const tree = decode(saved.tree, 0);
  return {
    tree,
    focusedId:
      typeof saved.focusedId === "string"
        ? saved.focusedId
        : paneIds(tree)[0] || "",
  };
}
