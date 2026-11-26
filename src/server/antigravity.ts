import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { HostConfig, MessageItem } from "../shared/types.js";
import type { HistoryDetail, HistoryThread } from "../shared/history.js";
import type { TerminalUsage } from "../shared/terminal-usage.js";

export function findAntigravity(env = process.env) {
  const windows = process.platform === "win32";
  const executable = windows ? "agy.exe" : "agy";
  const paths = [
    windows && env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "agy", "bin") : "",
    ...(env.PATH || "").split(delimiter).map((p) => p.replace(/^"|"$/g, "")),
  ];
  for (const dir of paths.filter((p) => p && isAbsolute(p))) {
    const file = join(dir, executable);
    try {
      if (statSync(file).isFile()) {
        accessSync(file, windows ? constants.F_OK : constants.X_OK);
        return file;
      }
    } catch {}
  }
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
/** Catalog reads never load a conversation or start a model turn. */
async function nativeSessions(exe: string): Promise<HistoryThread[]> {
  const child = spawn(exe, ["acp", "--stdio"], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const rows = createInterface({ input: child.stdout });
  const result: HistoryThread[] = [],
    cursors = new Set<string>();
  let seq = 0;
  const send = (method: string, params: unknown) =>
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }) + "\n",
    );
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(Error("Antigravity 기록 조회 시간 초과"));
      }, 12000);
      child.once("close", () => {
        clearTimeout(timer);
        reject(Error("Antigravity 기록 연결 종료"));
      });
      child.once("error", reject);
      child.stdin.on("error", reject);
      rows.on("line", (raw) => {
        try {
          const m = JSON.parse(raw);
          if (m.id !== seq || m.method) return;
          if (m.error) throw Error("Antigravity 기록 조회 실패");
          if (seq === 1) {
            send("session/list", {});
            return;
          }
          if (!Array.isArray(m.result?.sessions))
            throw Error("Antigravity 기록 형식을 확인하세요.");
          for (const s of m.result.sessions)
            if (uuid.test(s.sessionId) && typeof s.cwd === "string") {
              result.push({
                provider: "antigravity",
                id: s.sessionId,
                hostId: "local",
                title: String(s.title || "Antigravity"),
                cwd: s.cwd,
                preview: "",
                updatedAt: Date.parse(s.updatedAt) || 0,
                active: false,
                source: "cli",
              });
            }
          const cursor = m.result.nextCursor;
          if (cursor) {
            if (cursors.has(cursor)) throw Error("기록 페이지가 반복됐습니다.");
            cursors.add(cursor);
            send("session/list", { cursor });
          } else {
            clearTimeout(timer);
            resolve(result);
          }
        } catch (e) {
          clearTimeout(timer);
          reject(e);
        }
      });
      send("initialize", { protocolVersion: 1, clientCapabilities: {} });
    });
  } finally {
    rows.close();
    child.stdin.end();
    child.kill();
  }
}
export class AntigravityHistory {
  constructor(private root: string, private boundNativeRead?: (host:HostConfig,id:string,cursor?:string)=>Promise<HistoryDetail|undefined>) {}
  private catalog?: { at: number; pages: Promise<HistoryThread[]> };
  private native() {
    const exe = findAntigravity();
    if (!exe) return Promise.resolve([]);
    if (!this.catalog || Date.now() - this.catalog.at > 30000) {
      const pages = nativeSessions(exe);
      this.catalog = { at: Date.now(), pages };
      void pages.catch(() => {
        if (this.catalog?.pages === pages) this.catalog = undefined;
      });
    }
    return this.catalog.pages;
  }
  private folder(host: HostConfig, id: string) {
    if (host.kind !== "local" || !uuid.test(id))
      throw new Error("이 컴퓨터의 Antigravity 대화를 선택하세요.");
    return join(this.root, id);
  }
  async summary(
    host: HostConfig,
    _pass: string | undefined,
    id: string,
  ): Promise<HistoryThread> {
    const meta = await readFile(
      join(this.folder(host, id), "session.json"),
      "utf8",
    )
      .then((text) => JSON.parse(text))
      .catch((e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
    if (!meta) {
      const thread = (await this.native()).find((t) => t.id === id);
      if (thread) return thread;
      throw Error("Antigravity 대화를 찾을 수 없습니다.");
    }
    return {
      id,
      hostId: host.id,
      provider: "antigravity",
      title: meta.title,
      cwd: meta.cwd,
      preview: meta.title,
      updatedAt: meta.updatedAt,
      active: false,
      source: "cli",
    };
  }
  async list(
    host: HostConfig,
    pass: string | undefined,
    options: { search?: string; cursor?: string; archived?: boolean } = {},
  ) {
    if (host.kind !== "local" || options.archived)
      return { data: [], nextCursor: null };
    const ids = await readdir(this.root).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [];
      throw e;
    });
    const threads = await Promise.all(
      ids
        .filter((id) => uuid.test(id))
        .map((id) => this.summary(host, pass, id).catch(() => null)),
    );
    const all = new Map(
      (
        await this.native().catch((e) => {
          if (threads.some(Boolean)) return [];
          throw e;
        })
      ).map((t) => [t.id, t]),
    );
    for (const t of threads) if (t) all.set(t.id, t);
    const matches = [...all.values()]
      .filter(
        (t) =>
          !options.search ||
          (t.title + " " + t.cwd)
            .toLowerCase()
            .includes(options.search.toLowerCase()),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const start = offset(options.cursor);
    return {
      data: matches.slice(start, start + 50),
      nextCursor: start + 50 < matches.length ? String(start + 50) : null,
    };
  }
  async read(
    host: HostConfig,
    pass: string | undefined,
    id: string,
    cursor?: string,
    _options?: unknown,
  ): Promise<HistoryDetail> {
    const native=await this.boundNativeRead?.(host,id,cursor);
    if(native)return native;
    const dir = this.folder(host, id),
      thread = await this.summary(host, pass, id);
    const names = (
      await readdir(dir).catch((e) => {
        if (e.code === "ENOENT") return [] as string[];
        throw e;
      })
    )
      .filter((n) => /^turn-\d{13}-[a-f0-9-]+\.json$/.test(n))
      .sort();
    const end = cursor ? Math.min(offset(cursor), names.length) : names.length,
      start = Math.max(0, end - 4);
    const pages = await Promise.all(
      names
        .slice(start, end)
        .map(
          async (n) =>
            JSON.parse(await readFile(join(dir, n), "utf8")) as MessageItem[],
        ),
    );
    return {
      thread,
      items: pages.flat(),
      nextCursor: start ? String(start) : null,
      ...(!names.length
        ? {
            notice: "대화를 이어가면 Antigravity가 저장한 메시지를 불러옵니다.",
          }
        : {}),
    };
  }
  async usage(host: HostConfig, id: string): Promise<TerminalUsage | null> {
    if (host.kind !== "local") return null;
    const dir = this.folder(host, id);
    return readFile(join(dir, "usage.json"), "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => null);
  }
}
function offset(value?: string) {
  if (!value) return 0;
  if (!/^\d{1,12}$/.test(value))
    throw new Error("대화 기록 위치가 올바르지 않습니다.");
  return Number(value);
}
