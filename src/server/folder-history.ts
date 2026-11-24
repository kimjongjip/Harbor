import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import type { HistoryPage, HistoryThread } from "../shared/history.js";
import type { HostConfig } from "../shared/types.js";

type Phase = "folder" | "global";
export interface HistoryListOptions {
  cwd?: string;
  cursor?: string;
  search?: string;
  includeAutomation?: boolean;
  archived?: boolean;
  managed?: HistoryThread[];
}

function directoryKey(value: string, windows: boolean) {
  if (!value || /[\x00-\x1f]/.test(value)) return "";
  if (windows) {
    // Codex's Windows index stores extended paths even when the picker shows a drive path.
    const path = win32
      .normalize(value)
      .replace(/^\\\\\?\\UNC\\/i, "\\\\")
      .replace(/^\\\\\?\\/, "");
    if (!win32.isAbsolute(path)) return "";
    return path.replace(/\\+$/, "").toLowerCase();
  }
  if (!posix.isAbsolute(value)) return "";
  return posix.normalize(value).replace(/\/+$/, "") || "/";
}

/** Scan the exact folder first, then continue through the other folders in native recency order. */
export async function listFolderHistory(
  host: HostConfig,
  options: HistoryListOptions & { cwd: string },
  read: (cursor: string | null, cwd?: string) => Promise<HistoryPage>,
): Promise<HistoryPage> {
  const windows =
    host.kind === "local" && /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(options.cwd);
  const folder = directoryKey(options.cwd, windows);
  if (!folder) throw Error("기록을 조회할 작업 폴더의 절대경로를 확인하세요.");
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        host.id,
        host.kind,
        host.address,
        host.port,
        host.username,
        host.identityFile,
        host.codexPath,
        folder,
        options.search || "",
        !!options.includeAutomation,
        !!options.archived,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  let phase: Phase = "folder",
    cursor: string | null = null,
    upper: number | null = null;
  if (options.cursor) {
    const match =
      /^fh1\.([a-f0-9]{24})\.(folder|global)\.([0-9]{0,16})\.([\w-]*)$/.exec(
        options.cursor,
      );
    if (options.cursor.length > 8000 || !match || match[1] !== scope)
      throw Error(
        "작업 폴더 또는 검색 조건이 달라졌습니다. 기록을 다시 여세요.",
      );
    phase = match[2] as Phase;
    upper = match[3] ? Number(match[3]) : null;
    cursor = Buffer.from(match[4], "base64url").toString("utf8") || null;
  }
  const belongs = (thread: HistoryThread) =>
    directoryKey(thread.cwd, windows) === folder;
  const extra = options.managed || [];
  const extraIds = new Set(extra.map((t) => t.id));
  const seen = new Set<string>();
  const data: HistoryThread[] = [];
  // The native index canonicalizes Windows cwd filters (case, extended prefixes and UNC).
  // Apply our comparison too: some older app-servers ignore the optional native filter.
  const nativeFolder = windows ? win32.normalize(options.cwd) : folder;
  for (let scanned = 0; scanned < 8; scanned++) {
    const result = await read(
      cursor,
      phase === "folder" ? nativeFolder : undefined,
    );
    const rows = result.data.filter(
      (t) => belongs(t) === (phase === "folder") && !extraIds.has(t.id),
    );
    const lower = result.nextCursor
      ? (result.data.at(-1)?.updatedAt ?? upper)
      : null;
    rows.push(
      ...extra.filter(
        (t) =>
          belongs(t) === (phase === "folder") &&
          (upper === null || t.updatedAt < upper) &&
          (lower === null || t.updatedAt >= lower),
      ),
    );
    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const row of rows) {
      if (!seen.has(row.id)) data.push({ ...row, historyScope: phase });
      seen.add(row.id);
    }
    if (result.nextCursor) {
      if (result.nextCursor === cursor || result.nextCursor.length > 4096)
        throw Error("대화 기록 페이지를 읽을 수 없습니다.");
      cursor = result.nextCursor;
      upper = lower;
    } else if (phase === "folder") {
      phase = "global";
      cursor = null;
      upper = null;
    } else return { preferredCwd: options.cwd, data, nextCursor: null };
    if (data.length >= 50) break;
  }
  return {
    preferredCwd: options.cwd,
    data,
    nextCursor: `fh1.${scope}.${phase}.${upper ?? ""}.${Buffer.from(cursor || "").toString("base64url")}`,
  };
}
