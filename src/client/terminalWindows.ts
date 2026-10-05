import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
} from "react";

let detachedIds: string[] = [];
const listeners = new Set<() => void>();
const browserWindows = new Map<string, Window>();
const browserReady = new Set<string>();
const readyBrowserIds = () =>
  [...browserWindows.keys()].filter((id) => browserReady.has(id));
let watching = false;
function update(ids: string[]) {
  const next = [...new Set(ids)].sort();
  if (next.join() === detachedIds.join()) return;
  detachedIds = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!watching && window.harborDesktop?.onDetachedTerminals) {
    watching = true;
    window.harborDesktop.onDetachedTerminals(update);
    void window.harborDesktop
      .detachedTerminals()
      .then(update)
      .catch(() => {});
  }
  return () => {
    listeners.delete(listener);
  };
}
export function useDetachedTerminals() {
  return useSyncExternalStore(subscribe, () => detachedIds);
}
export async function focusTerminalWindow(id: string) {
  if (window.harborDesktop?.focusTerminalWindow)
    return window.harborDesktop.focusTerminalWindow(id);
  const popup = browserWindows.get(id);
  if (popup && !popup.closed) {
    popup.focus();
    popup.postMessage({ type: "harbor:terminal-select", id }, location.origin);
    return true;
  }
  if (
    new URLSearchParams(location.search).has("terminal") &&
    window.opener &&
    !window.opener.closed
  ) {
    try {
      if (window.opener.location.origin !== location.origin) return false;
      window.opener.postMessage(
        { type: "harbor:terminal-select", id },
        location.origin,
      );
      window.opener.focus();
      return true;
    } catch {}
  }
  return false;
}

export function useTerminalSelection(onSelect: (id: string) => void) {
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  useEffect(() => {
    const native = window.harborDesktop?.onTerminalSelection?.((id) =>
      selectRef.current(id),
    );
    const browser = (event: MessageEvent) => {
      if (
        event.origin !== location.origin ||
        event.data?.type !== "harbor:terminal-select"
      )
        return;
      if (
        !(window.opener && event.source === window.opener) &&
        ![...browserWindows.values()].some((popup) => popup === event.source)
      )
        return;
      if (typeof event.data.id === "string") selectRef.current(event.data.id);
    };
    window.addEventListener("message", browser);
    return () => {
      native?.();
      window.removeEventListener("message", browser);
    };
  }, []);
}
export async function detachTerminal(id: string) {
  if (window.harborDesktop?.detachTerminal)
    return window.harborDesktop.detachTerminal(id);
  const existing = browserWindows.get(id);
  if (existing && !existing.closed) {
    existing.focus();
    return true;
  }
  // Keep this synchronous with the click/drag gesture for popup permissions.
  const popup = window.open(
    `/?terminal=${encodeURIComponent(id)}`,
    `harbor-terminal-${id}`,
  );
  if (!popup) return false;
  browserWindows.set(id, popup);
  const interval = window.setInterval(() => {
    if (popup.closed) {
      window.clearInterval(interval);
      browserWindows.delete(id);
      browserReady.delete(id);
      update(readyBrowserIds());
    }
  }, 250);
  // Browser popups can fail or be blocked: do not remove the source prematurely.
  const deadline = Date.now() + 15000;
  while (!popup.closed && Date.now() < deadline) {
    try {
      if (
        popup.location.origin === location.origin &&
        popup.document.readyState === "complete" &&
        popup.document.querySelector(`[data-terminal-id="${id}"]`)
      ) {
        browserReady.add(id);
        update(readyBrowserIds());
        return true;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  window.clearInterval(interval);
  browserWindows.delete(id);
  browserReady.delete(id);
  update(readyBrowserIds());
  return false;
}

export function useTabDetach(onError: (message: string) => void) {
  const [draggingId, setDraggingId] = useState("");
  const drag = useRef<{
    id: string;
    token: Promise<string | null>;
    cancelled: boolean;
  } | null>(null);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !drag.current) return;
      const current = drag.current;
      current.cancelled = true;
      void current.token.then((token) => {
        if (token) window.harborDesktop?.cancelTabDrag(token);
      });
    };
    window.addEventListener("keydown", cancel, true);
    return () => {
      window.removeEventListener("keydown", cancel, true);
      if (drag.current)
        void drag.current.token.then((token) => {
          if (token) window.harborDesktop?.cancelTabDrag(token);
        });
    };
  }, []);
  const startDrag = (event: DragEvent, id: string) => {
    if (!event.nativeEvent.isTrusted) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData("application/x-harbor-terminal-tab", id);
    event.dataTransfer.effectAllowed = "move";
    drag.current = {
      id,
      cancelled: false,
      token: window.harborDesktop?.startTabDrag(id) || Promise.resolve(null),
    };
    setDraggingId(id);
  };
  const endDrag = async (event: DragEvent) => {
    const handledDrop = event.dataTransfer.dropEffect !== "none";
    const current = drag.current;
    drag.current = null;
    setDraggingId("");
    if (!current) return;
    try {
      if (window.harborDesktop?.endTabDrag) {
        const token = await current.token;
        if (!token) return;
        if (current.cancelled || handledDrop)
          window.harborDesktop.cancelTabDrag(token);
        else await window.harborDesktop.endTabDrag(token);
      }
    } catch (error) {
      errorRef.current(
        (error as Error).message || "터미널 창을 열지 못했습니다.",
      );
    }
  };
  const open = async (id: string) => {
    try {
      if (!(await detachTerminal(id)))
        errorRef.current(
          "새 창을 열지 못했습니다. 팝업 허용 설정을 확인하세요.",
        );
    } catch (error) {
      errorRef.current((error as Error).message);
    }
  };
  return { draggingId, startDrag, endDrag, open };
}
