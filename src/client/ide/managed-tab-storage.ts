import type { ChatEffort, IdeChatProvider } from "../../shared/ide-chat";

export interface SavedManagedTab {
  newChat?: boolean;
  /** Draft only. A bound conversation reads its policy from its host. */
  autoAccept?: true;
  permission?: import("../../shared/ide-chat").ChatPermission;
  model?: string;
  key: string;
  title?: string;
  provider: IdeChatProvider;
  conversationId?: string;
  nativeId?: string;
  runtimeId?: string;
  reconnectScope?: string;
  parentKey?: string;
  reviewOnly?: boolean;
  effort?: ChatEffort;
}

interface SavedTabs {
  selected: string;
  tabs: SavedManagedTab[];
}

export const maxManagedTabs = 100;
const prefix = "harbor.chat.tabs.v1.";
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[\w-]{1,160}$/.test(value);

function normalize(raw: unknown): SavedTabs | undefined {
  if (
    !raw ||
    typeof raw !== "object" ||
    !("tabs" in raw) ||
    !Array.isArray(raw.tabs)
  )
    return;
  const tabs: SavedManagedTab[] = [];
  const keys = new Set<string>();
  for (const tab of raw.tabs.slice(0, maxManagedTabs)) {
    if (
      !tab ||
      !id(tab.key) ||
      keys.has(tab.key) ||
      !["codex", "claude", "antigravity"].includes(tab.provider)
    )
      continue;
    keys.add(tab.key);
    tabs.push({
      key: tab.key,
      ...(typeof tab.title === "string" &&
        tab.title.trim() && { title: tab.title.trim().slice(0, 160) }),
      provider: tab.provider,
      ...(typeof tab.model === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9._:/@+\-\[\]]{0,159}$/.test(tab.model) && { model: tab.model }),
      ...(id(tab.conversationId) && { conversationId: tab.conversationId }),
      ...(id(tab.nativeId) && { nativeId: tab.nativeId }),
      ...(!tab.conversationId && !tab.nativeId && tab.newChat === true && {newChat: true as const}),
      ...(id(tab.runtimeId) && { runtimeId: tab.runtimeId }),
      ...(typeof tab.reconnectScope === "string" && /^[a-f0-9]{64}$/.test(tab.reconnectScope) && { reconnectScope: tab.reconnectScope }),
      ...(id(tab.parentKey) && { parentKey: tab.parentKey }),
      ...(tab.reviewOnly === true && { reviewOnly: true }),
      ...(!tab.conversationId && !tab.nativeId && !tab.reviewOnly && tab.permission!=="read-only" && tab.autoAccept===true && {autoAccept:true as const}),
      ...(["default", "read-only", "accept-edits", "auto-accept"].includes(
        tab.permission,
      ) && { permission: tab.permission }),
      ...([
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ].includes(tab.effort) && {
        effort: tab.effort,
      }),
    });
  }
  if (!tabs.length) return;
  const selected =
    "selected" in raw && id(raw.selected) && keys.has(raw.selected)
      ? raw.selected
      : tabs[0].key;
  return { selected, tabs };
}

export type WorkspaceChatRequest = { hostId: string; key: string } |
  { hostId: string; provider: IdeChatProvider; cwd: string };

export const managedTabsChanged = "harbor:managed-tabs-changed";

export function readManagedTabs(scope: string): SavedTabs | undefined {
  try {
    const data = localStorage.getItem(prefix + scope);
    if (data && data.length <= 128_000) return normalize(JSON.parse(data));
  } catch {
    /* Browser storage can be unavailable. */
  }
}

export function writeManagedTabs(scope: string, state: SavedTabs): void {
  try {
    const clean = normalize(state);
    if (clean) localStorage.setItem(prefix + scope, JSON.stringify(clean));
    else localStorage.removeItem(prefix + scope);
    window.dispatchEvent(new Event(managedTabsChanged));
  } catch {
    /* Open tabs still work without persistence. */
  }
}
