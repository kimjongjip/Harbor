export const remoteDesktop =
  typeof location !== "undefined" &&
  (location.pathname === "/desktop" ||
    location.pathname.startsWith("/desktop/"));
export const desktopClientId = remoteDesktop ? crypto.randomUUID() : "local";
const leases = new Map<string, string>();
export function setDesktopLease(id: string, token?: string) {
  if (token) leases.set(id, token);
  else leases.delete(id);
}
export function desktopLease(id: string) {
  return leases.get(id);
}
export function desktopHeaders(): Record<string, string> {
  return remoteDesktop
    ? {
        "X-Harbor-Client": desktopClientId,
        "X-Harbor-Leases": JSON.stringify(Object.fromEntries(leases)),
      }
    : {};
}
export function desktopMessage(value: unknown) {
  if (!remoteDesktop || !value || typeof value !== "object") return value;
  const message = value as { id?: string };
  return {
    ...value,
    clientId: desktopClientId,
    controlToken: message.id ? leases.get(message.id) : undefined,
  };
}
