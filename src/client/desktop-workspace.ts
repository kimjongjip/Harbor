import { useEffect, useRef } from "react";
import { api } from "./api";
import { remoteDesktop } from "./desktop-session";
import {
  desktopPreferenceKeys,
  type DesktopWorkspace,
} from "../shared/desktop-workspace";

export function restoreDesktopAppearance(workspace?: DesktopWorkspace) {
  if (!workspace) return;
  const query = new URLSearchParams(location.search);
  if (query.has("terminal") || query.get("preview") === "1") return;
  for (const key of desktopPreferenceKeys) {
    try {
      const value = workspace.preferences?.[key];
      if (typeof value === "string") localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {}
  }
}
export function useDesktopWorkspace(
  ready: boolean,
  view: Omit<DesktopWorkspace, "preferences">,
  popup: boolean,
) {
  const latest = useRef(view);
  latest.current = view;
  const publish = useRef<() => void>(() => {});
  useEffect(() => {
    if (remoteDesktop || !ready || popup) return;
    let previous = "",
      busy = false;
    const update = async () => {
      if (busy) return;
      const preferences: DesktopWorkspace["preferences"] = {};
      for (const key of desktopPreferenceKeys) {
        try {
          const value = localStorage.getItem(key);
          if (value !== null) preferences[key] = value;
        } catch {}
      }
      const body = { ...latest.current, preferences },
        next = JSON.stringify(body);
      if (next === previous) return;
      busy = true;
      try {
        await api("/desktop/workspace", body, "PUT");
        previous = next;
      } catch {
      } finally {
        // Older running hosts do not have this endpoint until normal restart.
        busy = false;
      }
    };
    publish.current = () => {
      void update();
    };
    void update();
    const timer = setInterval(update, 2000);
    return () => {
      clearInterval(timer);
      publish.current = () => {};
    };
  }, [ready, popup]);
  useEffect(() => {
    const timer = setTimeout(() => publish.current(), 150);
    return () => clearTimeout(timer);
  }, [
    view.activeId,
    view.page,
    view.workspaceView,
    view.sidebar,
    view.sidebarVisible,
  ]);
}
