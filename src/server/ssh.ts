import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HostConfig } from "../shared/types.js";

export function shellQuote(text: string): string {
  if (/[\0\r\n]/.test(text))
    throw new Error("경로에 줄바꿈을 사용할 수 없습니다.");
  return `'${text.replaceAll("'", "'\\''")}'`;
}

export function shellDirectory(path: string): string {
  if (path === "~") return '"$HOME"';
  if (path.startsWith("~/")) return `"$HOME"/${shellQuote(path.slice(2))}`;
  return shellQuote(path);
}

/** Run in the user's login environment, retaining a clean stdout for JSON-RPC. */
export function remoteCodexCommand(
  host: Pick<HostConfig, "codexPath">,
  args: string[],
  cwd?: string,
): string {
  const configured = host.codexPath || "codex";
  const executable = configured.startsWith("~/")
    ? `"$HOME"/${shellQuote(configured.slice(2))}`
    : shellQuote(configured);
  const directory = cwd ? `cd ${shellDirectory(cwd)} || exit; ` : "";
  const launch = `exec ${executable} ${args.map(shellQuote).join(" ")} 1>&3 3>&-`;
  const found = `[ -n "$(command -v ${executable} 2>/dev/null)" ]`;
  const missing = `printf '%s\\n' ${shellQuote(`Harbor: Codex 실행 파일을 찾을 수 없습니다: ${configured}. 서버 설정의 Codex 경로를 확인하세요.`)} >&2; exit 127`;
  // Some installations (e.g. nvm) initialize PATH only in interactive startup files.
  // An explicitly configured path must never silently select another installation.
  const fallback = configured.includes("/")
    ? missing
    : `exec "\${SHELL:-/bin/sh}" -ilc ${shellQuote(`${directory}if ${found}; then ${launch}; else ${missing}; fi`)} >/dev/null`;
  const body = `${directory}if ${found}; then ${launch}; else ${fallback}; fi`;
  // fd 3 preserves SSH stdout; startup banners cannot corrupt the app-server stream.
  return `exec 3>&1; exec "\${SHELL:-/bin/sh}" -lc ${shellQuote(body)} >/dev/null`;
}
export function sshArgs(host: HostConfig, interactive = false): string[] {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:@%+-]*$/.test(host.address))
    throw new Error("올바른 SSH 별칭 또는 호스트 주소를 입력하세요.");
  if (host.username && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(host.username))
    throw new Error("올바른 SSH 사용자 이름을 입력하세요.");
  const args = [
    "-o",
    "ConnectTimeout=12",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ];
  if (!interactive)
    args.push("-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-T");
  else args.push("-tt");
  // Leaving the default port unset preserves a Port directive in ~/.ssh/config.
  if (host.port !== 22) args.push("-p", String(host.port));
  if (host.identityFile)
    args.push("-i", host.identityFile.replace(/^~(?=[/\\])/, homedir()));
  if (host.username) args.push("-l", host.username);
  args.push("--", host.address);
  return args;
}
export function sshAliases(): string[] {
  try {
    const content = readFileSync(join(homedir(), ".ssh", "config"), "utf8");
    return [
      ...new Set(
        content.split(/\r?\n/).flatMap((line) => {
          const match = line.match(/^\s*Host\s+(.+?)\s*(?:#.*)?$/i);
          return match
            ? match[1]
                .split(/\s+/)
                .filter((h) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(h))
            : [];
        }),
      ),
    ];
  } catch {
    return [];
  }
}
export function processCommand(
  host: HostConfig,
  shared: boolean,
): { command: string; args: string[] } {
  const cliArgs = shared
    ? ["app-server", "proxy"]
    : ["app-server", "--listen", "stdio://"];
  if (host.kind === "local")
    return { command: host.codexPath || "codex", args: cliArgs };
  return {
    command: "ssh",
    args: [...sshArgs(host), remoteCodexCommand(host, cliArgs)],
  };
}
