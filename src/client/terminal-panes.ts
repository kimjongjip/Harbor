export interface TerminalPanes {
  ids: string[];
  focusedId: string;
}

/** A drop swaps visible panes; replacing a hidden session leaves other panes intact. */
export function placeTerminalPane(
  previous: TerminalPanes,
  id: string,
  slot: number,
  capacity: number,
): TerminalPanes {
  const ids = previous.ids.slice(0, capacity);
  const target = Math.max(
    0,
    Math.min(Math.trunc(slot), ids.length, capacity - 1),
  );
  const source = ids.indexOf(id);
  if (source >= 0) {
    if (target >= ids.length) return { ids, focusedId: id };
    [ids[source], ids[target]] = [ids[target], ids[source]];
  } else ids[target] = id;
  return { ids, focusedId: id };
}

/** Keep a pane's session until the user replaces that pane or its view moves. */
export function reconcileTerminalPanes(
  previous: TerminalPanes,
  available: string[],
  selected: string,
  capacity: number,
): TerminalPanes {
  const ids = previous.ids
    .filter((id) => available.includes(id))
    .slice(0, capacity);
  if (selected && available.includes(selected) && !ids.includes(selected)) {
    if (ids.length < capacity) ids.push(selected);
    else {
      const previousSlot = ids.indexOf(previous.focusedId);
      ids[previousSlot < 0 ? ids.length - 1 : previousSlot] = selected;
    }
  }
  for (const id of available) {
    if (ids.length >= capacity) break;
    if (!ids.includes(id)) ids.push(id);
  }
  const focusedId = ids.includes(selected)
    ? selected
    : ids.includes(previous.focusedId)
      ? previous.focusedId
      : ids[0] || "";
  return { ids, focusedId };
}
