let token = "";
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
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined && method === "GET" ? "GET" : method,
    headers: { "Content-Type": "application/json", "X-Harbor-Token": token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error || `요청 실패 (${response.status})`);
  return value;
}
export const sid = (id: string) => `/sessions/${encodeURIComponent(id)}`;
