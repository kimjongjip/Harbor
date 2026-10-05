import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import type { HostView } from "../shared/types";

export const HOST_DRAG_MIME = "application/x-harbor-host";
export const SERVER_ORDER_KEY = "harbor.serverOrder.v1";
export type HostDropPosition = "before" | "after";
export type MoveHost = (
  sourceId: string,
  targetId: string,
  position: HostDropPosition,
) => void;

function parseOrder(raw: string | null): string[] {
  if (!raw || raw.length > 100000) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed.filter(
          (id): id is string =>
            typeof id === "string" &&
            id.length > 0 &&
            id.length <= 200 &&
            !/[\x00-\x1f]/.test(id),
        ),
      ),
    ].slice(0, 1000);
  } catch {
    return [];
  }
}
function storedOrder() {
  try {
    return parseOrder(localStorage.getItem(SERVER_ORDER_KEY));
  } catch {
    return undefined;
  }
}
export function orderServerHosts(hosts: HostView[], order: string[]) {
  const known = new Map(hosts.map((host) => [host.id, host]));
  const ids = [
    ...new Set([
      ...order.filter((id) => known.has(id)),
      ...hosts.map((host) => host.id),
    ]),
  ];
  return ids.map((id) => known.get(id)!);
}

export function useServerOrder(input: HostView[]) {
  const [order, setOrder] = useState(() => storedOrder() || []);
  const inputRef = useRef(input),
    orderRef = useRef(order);
  inputRef.current = input;
  orderRef.current = order;
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === SERVER_ORDER_KEY || event.key === null)
        setOrder(storedOrder() || []);
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const moveHost = useCallback<MoveHost>((sourceId, targetId, position) => {
    const ids = orderServerHosts(
      inputRef.current,
      storedOrder() || orderRef.current,
    ).map((host) => host.id);
    if (
      sourceId === targetId ||
      !ids.includes(sourceId) ||
      !ids.includes(targetId)
    )
      return;
    const next = ids.filter((id) => id !== sourceId);
    next.splice(
      next.indexOf(targetId) + (position === "after" ? 1 : 0),
      0,
      sourceId,
    );
    if (next.every((id, index) => id === ids[index])) return;
    orderRef.current = next;
    setOrder(next);
    try {
      localStorage.setItem(SERVER_ORDER_KEY, JSON.stringify(next));
    } catch {
      /* Keep the current window usable when storage is unavailable. */
    }
  }, []);
  const moveBy = useCallback(
    (id: string, direction: -1 | 1) => {
      const ids = orderServerHosts(
        inputRef.current,
        storedOrder() || orderRef.current,
      ).map((host) => host.id);
      const index = ids.indexOf(id),
        target = ids[index + direction];
      if (index >= 0 && target)
        moveHost(id, target, direction === -1 ? "before" : "after");
    },
    [moveHost],
  );
  const hosts = useMemo(() => orderServerHosts(input, order), [input, order]);
  return { hosts, moveHost, moveBy };
}

function isHostDrag(transfer: DataTransfer) {
  return (
    transfer.types.includes(HOST_DRAG_MIME) &&
    !transfer.types.includes("Files") &&
    !transfer.types.includes("application/x-harbor-file") &&
    !transfer.types.includes("application/x-harbor-terminal-tab")
  );
}
export function useHostReorderDrag(
  onMove?: MoveHost,
  axis: "vertical" | "horizontal" = "vertical",
) {
  const [draggingId, setDraggingId] = useState("");
  const [over, setOver] = useState<{
    id: string;
    position: HostDropPosition;
  } | null>(null);
  const clear = useCallback(() => {
    setDraggingId("");
    setOver(null);
  }, []);
  useEffect(() => {
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
      window.removeEventListener("blur", clear);
    };
  }, [clear]);
  const position = (event: DragEvent<HTMLElement>): HostDropPosition => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return axis === "horizontal"
      ? event.clientX < bounds.left + bounds.width / 2
        ? "before"
        : "after"
      : event.clientY < bounds.top + bounds.height / 2
        ? "before"
        : "after";
  };
  const dragProps = (id: string) => ({
    draggable: !!onMove,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      if (!onMove) return;
      event.stopPropagation();
      event.dataTransfer.setData(HOST_DRAG_MIME, id);
      event.dataTransfer.effectAllowed = "move";
      setDraggingId(id);
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!onMove || !isHostDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      if (draggingId !== id) setOver({ id, position: position(event) });
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      )
        return;
      setOver((previous) => (previous?.id === id ? null : previous));
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!onMove || !isHostDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      const source = event.dataTransfer.getData(HOST_DRAG_MIME);
      clear();
      if (source && source.length <= 200 && source !== id)
        onMove(source, id, position(event));
    },
    onDragEnd: clear,
  });
  return {
    dragProps,
    draggingId,
    dropPosition: (id: string) => (over?.id === id ? over.position : undefined),
  };
}
