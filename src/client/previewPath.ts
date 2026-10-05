import { api } from "./api";

// Older running backends expand ~/ for filenames, but reject it as cwd.
// Resolve through that existing endpoint without restarting any terminals.
export async function resolvePreviewBase(hostId: string, cwd: string) {
  if (cwd !== "~" && !cwd.startsWith("~/") && !cwd.startsWith("~\\")) return cwd;
  const result = await api<{ kind: string; path: string }>(
    `/hosts/${hostId}/files/preview?${new URLSearchParams({ path: cwd === "~" ? "~/" : cwd, cwd: "" })}`,
    undefined, "GET",
  );
  if (result.kind !== "directory") throw new Error("기준 폴더가 디렉터리가 아닙니다.");
  return result.path;
}
