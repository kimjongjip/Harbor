import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { TerminalInfo } from "../shared/types";

type Preferences = { pins: string[]; attention: boolean };
export function parsePreferences(value: string): Preferences {
  try {
    const data = JSON.parse(value);
    return {
      pins: Array.isArray(data?.pins)
        ? [
            ...new Set<string>(
              data.pins.filter(
                (id: unknown) => typeof id === "string" && id.length <= 256,
              ),
            ),
          ].slice(0, 256)
        : [],
      attention: data?.attention === true,
    };
  } catch {
    return { pins: [], attention: false };
  }
}
const unavailableStorage = new Map<string, string>();
function read(key: string) {
  if (unavailableStorage.has(key)) return unavailableStorage.get(key)!;
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}
export function useSessionDiscovery(device?: string) {
  const key = "harbor.session-list." + device;
  const subscribe = useCallback(
    (changed: () => void) => {
      const onChange = (e: Event) => {
        if (
          e.type === "storage" &&
          (e as StorageEvent).key !== key &&
          (e as StorageEvent).key !== null
        )
          return;
        changed();
      };
      window.addEventListener("storage", onChange);
      window.addEventListener("harbor-session-list", onChange);
      return () => {
        window.removeEventListener("storage", onChange);
        window.removeEventListener("harbor-session-list", onChange);
      };
    },
    [key],
  );
  const raw = useSyncExternalStore(
    subscribe,
    () => (device ? read(key) : ""),
    () => "",
  );
  const preferences = useMemo(() => parsePreferences(raw), [raw]);
  function write(update: (p: Preferences) => Preferences) {
    if (!device) return;
    const next = JSON.stringify(update(parsePreferences(read(key))));
    try {
      localStorage.setItem(key, next);
      unavailableStorage.delete(key);
    } catch {
      unavailableStorage.set(key, next);
    }
    window.dispatchEvent(new Event("harbor-session-list"));
  }
  return {
    ...preferences,
    togglePin: (id: string) =>
      write((p) => ({
        ...p,
        pins: p.pins.includes(id)
          ? p.pins.filter((x) => x !== id)
          : [id, ...p.pins].slice(0, 256),
      })),
    toggleAttention: () => write((p) => ({ ...p, attention: !p.attention })),
  };
}

export function discoverSessions(
  terminals: TerminalInfo[],
  hosts: { id: string; name: string }[],
  pending: ReadonlySet<string>,
  query: string,
  preferences: Preferences,
) {
  if (!query.trim() && !preferences.attention && !preferences.pins.length)
    return terminals;
  const pins = new Set(preferences.pins),
    names = new Map(hosts.map((h) => [h.id, h.name]));
  const terms = query
    .normalize("NFC")
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const result = terminals.filter((t) => {
    if (
      preferences.attention &&
      (t.exited ||
        (!pending.has(t.id) &&
          t.agentState !== "waiting" &&
          t.connectionState !== "disconnected"))
    )
      return false;
    const text = [t.title, t.cwd, t.agentKind, names.get(t.hostId)]
      .join(" ")
      .normalize("NFC")
      .toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
  return result.sort((a, b) => Number(pins.has(b.id)) - Number(pins.has(a.id)));
}
