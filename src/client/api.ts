let token = "";
let connectionMonitoring = false;
export function setConnectionMonitoring(value: boolean) {
  connectionMonitoring = value;
}
export function hasConnectionMonitoring() {
  return connectionMonitoring;
}
export function reportViewConnection(
  terminalId: string | undefined,
  reason: string,
  code?: number,
) {
  if (!connectionMonitoring) return;
  void api(
    "/diagnostics/view-connection",
    { terminalId, reason, code },
    "POST",
    AbortSignal.timeout(3000),
  ).catch(() => {});
}
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}
export function setToken(value: string) {
  token = value;
}
export function getToken() {
  return token;
}
export async function api<T = any>(
  path: string,
  body?: unknown,
  method = "POST",
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    signal,
    method: body === undefined && method === "GET" ? "GET" : method,
    headers: { "Content-Type": "application/json", "X-Harbor-Token": token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok)
    throw new ApiError(
      value.error || `요청 실패 (${response.status})`,
      response.status,
      value.code,
    );
  return value;
}
export const sid = (id: string) => `/sessions/${encodeURIComponent(id)}`;
