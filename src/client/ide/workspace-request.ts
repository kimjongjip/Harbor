import { apiHeaders } from "../api";
export const workspaceClientId = crypto.randomUUID();
export const workspaceLeases = new Map<string, string>();
export function workspaceLeaseKey(host: string, terminal: string) {
  return host + ":" + terminal;
}
export function workspaceRequest(hostId: string, mobile: boolean) {
  const base =
    (mobile ? "/mobile-api" : "/api") +
    "/workspaces/" +
    encodeURIComponent(hostId) +
    "/chat";
  return (path: string, init?: RequestInit) => {
    const terminal = new Headers(init?.headers).get("X-Harbor-Terminal");
    const lease =
      terminal && workspaceLeases.get(workspaceLeaseKey(hostId, terminal));
    return fetch(base + path, {
      ...init,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(mobile ? { "X-Harbor-Mobile": "1" } : apiHeaders()),
        ...init?.headers,
        ...(lease
          ? { "X-Harbor-Client": workspaceClientId, "X-Harbor-Control": lease }
          : {}),
      },
    });
  };
}
