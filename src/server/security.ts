import { timingSafeEqual } from "node:crypto";

export function allowedHost(value: string | undefined, port: number): boolean {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(
    value || "",
  );
}
export function allowedOrigin(
  value: string | undefined,
  port: number,
): boolean {
  if (!value) return true;
  return [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ].includes(value);
}
export function validToken(value: unknown, expected: string): boolean {
  if (typeof value !== "string") return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
