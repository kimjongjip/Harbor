import { mkdir, realpath, readdir, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import headless from "@xterm/headless";
import type { AccountQuota, QuotaWindow } from "../shared/host-insights.js";
import type { HostConfig } from "../shared/types.js";
import { findAntigravity } from "./antigravity.js";
import { spawnLocalPty } from "./local-pty.js";
import type { Files } from "./files.js";

const cols = 180,
  rows = 100;
export interface QuotaConsole {
  cwd: string;
  ownedEmpty: () => Promise<boolean>;
  write(text: string): void;
  close(): void;
  onData(f: (data: string) => void): void;
  onExit(f: () => void): void;
}

export function parseAntigravityQuota(
  screen: string,
  now = Date.now(),
): AccountQuota | undefined {
  const start = screen.indexOf("Models & Quota");
  if (start < 0) return;
  const lines = screen
    .slice(start)
    .split("\n")
    .map((s) => s.trim());
  const windows: QuotaWindow[] = [];
  let family = "";
  for (let i = 1; i < lines.length; i++) {
    const group = lines[i].match(/^([A-Z][A-Z0-9 &+.-]{1,60}) MODELS$/);
    if (group) {
      family =
        group[1] === "GEMINI"
          ? "Gemini"
          : group[1] === "CLAUDE AND GPT"
            ? "Claude · GPT"
            : group[1];
      continue;
    }
    const span =
      lines[i] === "Weekly Limit Remaining"
        ? "7일"
        : lines[i] === "Five Hour Limit Remaining"
          ? "5시간"
          : "";
    if (!family || !span) continue;
    const percent = lines[i + 1]?.match(/\]\s*(\d{1,3}(?:\.\d+)?)%\s*$/);
    if (!percent || Number(percent[1]) > 100) continue;
    const duration = /^Refreshes in\s+(.+)$/.exec(lines[i + 2] || "")?.[1];
    let delay = 0;
    if (duration && /^(?:\d+[dhms]\s*)+$/.test(duration))
      for (const [, n, unit] of duration.matchAll(/(\d+)([dhms])/g))
        delay +=
          Number(n) * ({ d: 86400, h: 3600, m: 60, s: 1 }[unit] || 0) * 1000;
    windows.push({
      label: family + " · " + span,
      remaining: Number(percent[1]),
      ...(delay > 0 && delay <= 32 * 86400000 ? { resetsAt: now + delay } : {}),
    });
  }
  if (!windows.length) return;
  const account = lines
    .map((l) => l.match(/^Account:\s*([^\s]+@[^\s]+)$/)?.[1])
    .find(Boolean);
  return {
    provider: "antigravity",
    ...(account ? { account } : {}),
    windows,
    updatedAt: now,
  };
}

/** Drive only the CLI's own verified /usage menu in this dedicated empty workspace. */
export async function readQuotaConsole(
  console: QuotaConsole,
): Promise<AccountQuota> {
  const term = new headless.Terminal({
    cols,
    rows,
    scrollback: 0,
    allowProposedApi: true,
  });
  try {
    return await new Promise<AccountQuota>((resolve, reject) => {
      const viewport = () => {
        const b = term.buffer.active;
        return Array.from(
          { length: rows },
          (_, i) =>
            b
              .getLine(b.viewportY + i)
              ?.translateToString(true)
              .trim() || "",
        );
      };
      const trustScreen = (lines: string[]) =>
        lines.includes(console.cwd) &&
        lines.includes("Do you trust the contents of this project?") &&
        lines.includes("> Yes, I trust this folder");
      let done = false,
        step: "start" | "menu" | "panel" = "start",
        trusted = false;
      const finish = (result?: AccountQuota) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        if (result) resolve(result);
        else
          reject(Error("Antigravity CLI의 /usage 응답을 확인할 수 없습니다."));
      };
      const timeout = setTimeout(() => finish(), 18000);
      term.onData((reply) => {
        if (!done && /^\x1b[\[\]>?0-9;cR]+$/.test(reply)) console.write(reply);
      });
      console.onExit(() => finish());
      console.onData((data) => {
        if (done) return;
        term.write(data, () => {
          if (done) return;
          const lines = viewport();
          const screen = lines.join("\n");
          if (step === "start" && !trusted && trustScreen(lines)) {
            trusted = true;
            void console.ownedEmpty().then(
              (empty) => {
                if (done) return;
                if (empty && step === "start" && trustScreen(viewport()))
                  console.write("\r");
                else finish();
              },
              () => finish(),
            );
          } else if (
            step === "start" &&
            /Antigravity CLI \d+\.\d+/.test(screen) &&
            lines.some((line) => line === ">") &&
            !screen.includes("Do you trust")
          ) {
            step = "menu";
            console.write("/usage");
          } else if (
            step === "menu" &&
            lines.some((line) =>
              /^>\s*\/usage\s+View model quota usage\s*$/i.test(line),
            )
          ) {
            step = "panel";
            console.write("\r");
          } else if (step === "panel" && screen.includes("esc Close")) {
            const result = parseAntigravityQuota(screen);
            if (result) finish(result);
          }
        });
      });
    });
  } finally {
    console.close();
    term.dispose();
  }
}

async function localConsole(): Promise<QuotaConsole> {
  const exe = findAntigravity();
  if (!exe) throw Error("이 컴퓨터에서 Antigravity CLI를 찾을 수 없습니다.");
  const home = await realpath(homedir()),
    cwd = path.join(home, ".cache", "harbor", "agy-quota-view");
  for (const part of [
    path.join(home, ".cache"),
    path.join(home, ".cache", "harbor"),
    cwd,
  ]) {
    await mkdir(part, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const st = await lstat(part);
    if (
      !st.isDirectory() ||
      st.isSymbolicLink() ||
      (await realpath(part)) !== part ||
      (typeof process.getuid === "function" && st.uid !== process.getuid())
    )
      throw Error("한도 조회 폴더 소유자를 확인하세요.");
  }
  const ownedEmpty = async () => {
    const st = await lstat(cwd);
    return (
      (await realpath(cwd)) === cwd &&
      st.isDirectory() &&
      !st.isSymbolicLink() &&
      (typeof process.getuid !== "function" || st.uid === process.getuid()) &&
      !(await readdir(cwd)).length
    );
  };
  if (!(await ownedEmpty()))
    throw Error("Antigravity 한도 조회용 빈 폴더를 확인하세요.");
  const term = await spawnLocalPty(exe, ["--sandbox"], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: { ...process.env, TERM: "xterm-256color" },
  });
  return {
    cwd,
    ownedEmpty,
    write: (s) => term.write(s),
    close: () => term.kill(),
    onData: (f) => term.onData(f),
    onExit: (f) => term.onExit(f),
  };
}

export class AntigravityQuota {
  private cache = new Map<
    string,
    { value?: AccountQuota; pending?: Promise<AccountQuota>; at: number }
  >();
  constructor(
    private files: Files,
    private password: (id: string) => Promise<string | undefined>,
  ) {}
  async read(host: HostConfig, force = false): Promise<AccountQuota> {
    const key = JSON.stringify([
      host.id,
      host.kind,
      host.address,
      host.port,
      host.username,
      host.identityFile,
    ]);
    const old = this.cache.get(key);
    if (old?.pending) return old.pending;
    if (
      old?.value &&
      Date.now() - old.at < (force ? 60000 : 600000) &&
      !old.value.windows.some(
        (w) => w.resetsAt !== undefined && w.resetsAt <= Date.now(),
      )
    )
      return old.value;
    const pending = (async () => {
      try {
        const console =
          host.kind === "local"
            ? await localConsole()
            : (await this.password(host.id),
              await this.files.antigravityQuotaConsole(host, cols, rows));
        return await readQuotaConsole(console);
      } catch {
        const error =
          "CLI의 /usage 한도를 확인할 수 없습니다. 해당 서버의 설치와 로그인을 확인하세요.";
        return {
          provider: "antigravity" as const,
          windows: [],
          updatedAt: Date.now(),
          error,
        };
      }
    })();
    this.cache.set(key, { pending, at: Date.now() });
    const value = await pending;
    this.cache.set(key, { value, at: Date.now() });
    if (this.cache.size > 64)
      for (const [id, entry] of this.cache)
        if (!entry.pending && id !== key) {
          this.cache.delete(id);
          break;
        }
    return value;
  }
}
