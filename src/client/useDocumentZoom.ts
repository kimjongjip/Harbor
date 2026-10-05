import { useEffect, useRef, useState } from "react";

const storageKey = "harbor.documentZoom";
export function useDocumentZoom(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [percent, setPercent] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved >= 50 && saved <= 250) return saved;
    } catch {}
    return 100;
  });
  useEffect(() => {
    try { localStorage.setItem(storageKey, String(percent)); } catch {}
  }, [percent]);
  useEffect(() => {
    const root = ref.current;
    if (!root || !enabled) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey || !event.deltaY) return;
      event.preventDefault();
      event.stopPropagation();
      setPercent(value => Math.max(50, Math.min(250, value + (event.deltaY < 0 ? 10 : -10))));
    };
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "0") {
        event.preventDefault();
        event.stopPropagation();
        setPercent(100);
      }
    };
    root.addEventListener("wheel", wheel, { passive: false });
    document.addEventListener("keydown", key, true);
    return () => {
      root.removeEventListener("wheel", wheel);
      document.removeEventListener("keydown", key, true);
    };
  }, [enabled]);
  return { ref, percent, reset: () => setPercent(100) };
}
