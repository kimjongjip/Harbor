import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Client, ClientChannel } from "ssh2";
import type {
  HostConfig,
  TerminalInfo,
  TerminalConnectionIssue,
} from "../shared/types.js";
import { shellQuote } from "./ssh.js";
import { peerRuntimeSchema, type PeerRuntime } from "./peer-delivery.js";

export type DisconnectCategory = TerminalConnectionIssue;
export function safeSshErrorDetails(error: unknown): {
  code?: string;
  level?: string;
} {
  const value = error as { code?: unknown; level?: unknown } | undefined;
  const codes = [
    "ECONNRESET",
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EPIPE",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ERR_SOCKET_CLOSED",
    "ERR_STREAM_DESTROYED",
  ];
  const levels = [
    "client-socket",
    "client-timeout",
    "client-authentication",
    "client-ssh",
    "client-dns",
    "protocol",
  ];
  return {
    ...(typeof value?.code === "string" && codes.includes(value.code)
      ? { code: value.code }
      : {}),
    ...(typeof value?.level === "string" && levels.includes(value.level)
      ? { level: value.level }
      : {}),
  };
}
export class DurableSshError extends Error {
  constructor(
    readonly category: DisconnectCategory,
    message: string,
  ) {
    super(message);
  }
}
export function disconnectCategory(error: unknown): DisconnectCategory {
  if (error instanceof DurableSshError) return error.category;
  const value = error as { code?: string; level?: string; message?: string };
  if (
    value?.level === "client-authentication" ||
    /authentication|인증/i.test(value?.message || "")
  )
    return "authentication";
  if (
    /TIMEOUT|TIMEDOUT/.test(value?.code || "") ||
    /timed out|timeout/i.test(value?.message || "")
  )
    return "timeout";
  if (
    /ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EPIPE/.test(
      value?.code || "",
    )
  )
    return "network";
  return "transport";
}
export interface DurableRecord {
  info: TerminalInfo;
  target: string;
  socket: string;
  session: string;
  remotePort: number;
}
export const hostFingerprint = (host: HostConfig) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        host.id,
        host.address,
        host.username,
        host.port,
        host.identityFile,
      ]),
    )
    .digest("hex");

/** Private metadata contains identifiers only; bridge secrets stay in tmux's environment. */
export class DurableRegistry {
  private records = new Map<string, DurableRecord>();
  private readonly file: string;
  private readonly diagnostics: string;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, "durable-terminals.json");
    this.diagnostics = join(directory, "terminal-disconnects.jsonl");
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.terminals))
        throw Error("Invalid durable terminal registry");
      for (const record of data.terminals) {
        if (
          !/^[a-f0-9-]{36}$/.test(record.info?.id || "") ||
          !/^[a-f0-9]{64}$/.test(record.target || "") ||
          !/^harbor-[a-f0-9]{32}$/.test(record.socket || "") ||
          record.session !== `h-${record.info.id}` ||
          !Number.isInteger(record.remotePort) ||
          record.remotePort < 0 ||
          record.remotePort > 65535
        )
          throw Error("Invalid durable terminal record");
        this.records.set(record.info.id, record);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          "장기 SSH 세션 목록을 읽지 못했습니다. 개인 데이터 폴더의 durable-terminals.json을 확인하세요.",
        );
    }
  }
  list() {
    return [...this.records.values()].map((record) => structuredClone(record));
  }
  put(record: DurableRecord) {
    this.records.set(record.info.id, structuredClone(record));
    this.save();
  }
  remove(id: string) {
    this.records.delete(id);
    this.save();
  }
  private save() {
    const temp = `${this.file}.tmp`;
    writeFileSync(
      temp,
      JSON.stringify({ version: 1, terminals: [...this.records.values()] }),
      { mode: 0o600 },
    );
    renameSync(temp, this.file);
  }
  diagnose(
    id: string,
    category: DisconnectCategory,
    attempt = 0,
    state?: TerminalInfo["connectionState"],
  ) {
    this.trace(id, category, { attempt, state });
  }
  trace(
    id: string,
    category:
      | DisconnectCategory
      | "power-suspend"
      | "power-resume"
      | "user-close"
      | "state",
    detail: {
      at?: number;
      attempt?: number;
      state?: TerminalInfo["connectionState"];
      source?: "ssh-error" | "ssh-close" | "channel-error" | "channel-close";
      code?: string;
      level?: string;
    } = {},
  ) {
    // Never log exception messages, addresses, credentials, commands or terminal output.
    try {
      // Bound the diagnostic journal; it is a reason trace, not a terminal transcript.
      try {
        if (readFileSync(this.diagnostics).length > 256 * 1024)
          writeFileSync(this.diagnostics, "", { mode: 0o600 });
      } catch {
        /* first event */
      }
      appendFileSync(
        this.diagnostics,
        `${JSON.stringify({ at: detail.at ?? Date.now(), terminalId: id, category, ...(detail.attempt !== undefined ? { attempt: detail.attempt } : {}), ...(detail.state ? { state: detail.state } : {}), ...(detail.source ? { source: detail.source } : {}), ...safeSshErrorDetails(detail) })}\n`,
        { mode: 0o600 },
      );
    } catch {
      /* A full disk must not kill a running remote job. */
    }
  }
}

export function durableNames(id: string) {
  return {
    socket: `harbor-${randomUUID().replaceAll("-", "")}`,
    session: `h-${id}`,
  };
}
export function tmux(record: Pick<DurableRecord, "socket">) {
  return `tmux -L ${shellQuote(record.socket)} -f /dev/null`;
}
/** The colon disambiguates an exact session from a window target in tmux. */
export function tmuxTarget(record: Pick<DurableRecord, "session">) {
  return shellQuote(`=${record.session}:`);
}
/** tmux reads a short-lived mode-600 file, never capability values in argv. */
export function durableEnvironmentScript(
  record: DurableRecord,
  name: "HARBOR_SESSION_TOKEN" | "HARBOR_HOOK_TOKEN" | "HARBOR_CODEX_RUNTIME",
  value: string,
) {
  if (!/^[A-Za-z0-9+/_=-]{1,4096}$/.test(value))
    throw new Error("Invalid private terminal capability");
  const line = `set-environment -t ${tmuxTarget(record)} ${name} ${shellQuote(value)}`;
  return `(umask 077; harbor_env=$(mktemp) || exit 1; trap 'rm -f -- "$harbor_env"' EXIT; printf '%s\\n' ${shellQuote(line)} > "$harbor_env"; ${tmux(record)} source-file "$harbor_env")`;
}
export function execRemote(
  connection: Client,
  command: string,
  input?: string,
  limit = 64 * 1024,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let channel: ClientChannel | undefined,
      settled = false,
      output = "",
      code: number | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.off("close", closed);
      if (error) {
        channel?.close();
        reject(error);
      } else resolve(output);
    };
    const closed = () =>
      finish(
        new DurableSshError(
          "transport",
          "SSH 연결이 끊겼습니다. 재연결 후 서버 작업 상태를 확인합니다.",
        ),
      );
    const timer = setTimeout(
      () =>
        finish(
          new DurableSshError("timeout", "SSH 세션 확인 시간이 초과됐습니다."),
        ),
      20000,
    );
    timer.unref();
    connection.once("close", closed);
    connection.exec(command, (error, stream) => {
      if (error) return finish(error);
      if (settled) {
        stream.close();
        return;
      }
      channel = stream;
      stream.setEncoding("utf8");
      stream.stderr.resume();
      stream.on("data", (data: string) => {
        output += data;
        if (output.length > limit)
          finish(new Error("SSH 관리 응답이 너무 큽니다."));
      });
      stream.once("error", finish);
      stream.once("exit", (value) => {
        code = value;
      });
      stream.once("close", () => {
        if (code === 72)
          finish(
            new DurableSshError(
              "capability",
              "장기 SSH 세션에는 서버의 tmux가 필요합니다. 서버에서 tmux를 설치한 뒤 다시 연결하세요. 일반 SSH로 조용히 대체하지 않습니다.",
            ),
          );
        else if (code === 73)
          finish(
            new DurableSshError(
              "capability",
              "장기 SSH 세션에는 서버의 bash가 필요합니다.",
            ),
          );
        else if (code === 74)
          finish(
            new DurableSshError(
              "remote-missing",
              "서버의 유지 세션을 찾을 수 없습니다. 서버 재부팅 또는 외부 종료 여부를 확인하세요. CLI를 자동 재실행하지 않습니다.",
            ),
          );
        else if (code !== 0)
          finish(
            new DurableSshError(
              "management",
              "서버의 유지 세션을 확인하지 못했습니다.",
            ),
          );
        else finish();
      });
      stream.end(input);
    });
  });
}

export interface DurableSecrets {
  token: string;
  path: string;
  hookToken?: string;
  hookPath?: string;
  peerRuntime?: PeerRuntime;
}
export async function createDurableSession(
  connection: Client,
  record: DurableRecord,
  initialization: string,
  secrets?: DurableSecrets,
) {
  const command = tmux(record),
    target = tmuxTarget(record);
  // Only authenticated stdin carries the script and tokens. No secrets in ps/argv.
  const script =
    [
      "set +x +v; set -eu; umask 077",
      "command -v tmux >/dev/null 2>&1 || exit 72",
      "command -v bash >/dev/null 2>&1 || exit 73",
      `if ${command} has-session -t ${target} 2>/dev/null; then exit 75; fi`,
      'harbor_dir="$HOME/.codex/harbor/terminal-startup"; mkdir -p -- "$harbor_dir"; chmod 700 "$harbor_dir"',
      `harbor_file="$harbor_dir/${record.info.id}.bash"`,
      `printf '%s' ${shellQuote(Buffer.from(`rm -f -- "\${BASH_SOURCE[0]}"\nexport TERM=xterm-256color COLORTERM=truecolor\n${initialization}`).toString("base64"))} | base64 -d > "$harbor_file"`,
      `trap 'rm -f -- "$harbor_file"' EXIT`,
      `${command} new-session -d -s ${shellQuote(record.session)} -x 100 -y 30 'exec bash --noprofile --norc +x +v "$HOME/.codex/harbor/terminal-startup/${record.info.id}.bash"'`,
      `${command} set-option -t ${target} status off`,
      `${command} set-option -t ${target} remain-on-exit on`,
      // Fullscreen CLIs keep their conversation in an alternate screen and
      // need wheel events. Harbor's Shift-selection bridge still owns drags.
      `${command} set-option -t ${target} mouse on`,
      `${command} set-option -t ${target} prefix None`,
      `${command} set-option -g escape-time 0`,
      `${command} set-option -g default-terminal xterm-256color`,
      ...(secrets
        ? [
            durableEnvironmentScript(
              record,
              "HARBOR_SESSION_TOKEN",
              secrets.token,
            ),
            ...(secrets.hookToken
              ? [
                  durableEnvironmentScript(
                    record,
                    "HARBOR_HOOK_TOKEN",
                    secrets.hookToken,
                  ),
                ]
              : []),
          ]
        : []),
      "trap - EXIT",
    ].join("\n") + "\n";
  await execRemote(connection, "sh -s", script);
}
export async function checkDurableSession(
  connection: Client,
  record: DurableRecord,
): Promise<{ dead: boolean; code: number; signal?: string; cwd?: string }> {
  // tmux 3.2a wraps ENOENT in parentheses. An unlinked socket can still have
  // a live server, so preserve it when Linux retains that kernel socket.
  const socketStillLive = `if [ -r /proc/net/unix ] && LC_ALL=C grep -F -q -- ${shellQuote(`/${record.socket}`)} /proc/net/unix; then exit 75; fi`;
  const output = await execRemote(
    connection,
    `command -v tmux >/dev/null 2>&1 || exit 72; if ! ${tmux(record)} has-session -t ${tmuxTarget(record)} 2>/dev/null; then harbor_sessions=$(LC_ALL=C ${tmux(record)} list-sessions -F '#{session_name}' 2>&1); harbor_code=$?; if [ "$harbor_code" = 0 ]; then case "
$harbor_sessions
" in *'
${record.session}
'*) exit 1;; *) exit 74;; esac; else case "$harbor_sessions" in 'no server running on '*|'error connecting to '*' (No such file or directory)'|'failed to connect to server: No such file or directory') ${socketStillLive}; exit 74;; *) exit 1;; esac; fi; fi; ${tmux(record)} display-message -p -t ${tmuxTarget(record)} '#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}\n#{pane_current_path}'`,
  );
  const [status, path] = output.trimEnd().split("\n");
  const [dead, code, signal] = status.split("|");
  if (dead !== "0" && dead !== "1")
    throw new DurableSshError(
      "management",
      "서버의 유지 세션 상태 응답을 확인하지 못했습니다.",
    );
  return {
    dead: dead === "1",
    // A signaled process has no normal exit status. Never call that success.
    code: /^\d+$/.test(code || "") ? Number(code) : -1,
    ...(signal && /^(?:SIG)?[A-Z][A-Z0-9]{0,19}$/.test(signal)
      ? { signal }
      : {}),
    ...(path?.startsWith("/") && !/[\x00-\x1f]/.test(path)
      ? { cwd: path }
      : {}),
  };
}
export async function restoreDurableSecrets(
  connection: Client,
  record: DurableRecord,
): Promise<DurableSecrets> {
  const output = await execRemote(
    connection,
    `${tmux(record)} show-environment -t ${tmuxTarget(record)} HARBOR_SESSION_TOKEN; ${tmux(record)} show-environment -t ${tmuxTarget(record)} HARBOR_HOOK_TOKEN 2>/dev/null || true; ${tmux(record)} show-environment -t ${tmuxTarget(record)} HARBOR_CODEX_RUNTIME 2>/dev/null || true`,
  );
  const token = output.match(/^HARBOR_SESSION_TOKEN=([a-f0-9]{64})$/m)?.[1];
  const hookToken = output.match(/^HARBOR_HOOK_TOKEN=([a-f0-9]{64})$/m)?.[1];
  if (!token)
    throw new DurableSshError(
      "forwarding",
      "기존 세션의 Harbor 인증 연결을 복구하지 못했습니다. 세션은 서버에 유지되며 자동 재실행하지 않습니다.",
    );
  let peerRuntime: PeerRuntime | undefined;
  const encoded = output.match(
    /^HARBOR_CODEX_RUNTIME=([A-Za-z0-9+/=]{1,4096})$/m,
  )?.[1];
  if (encoded) {
    try {
      peerRuntime = peerRuntimeSchema.parse(
        JSON.parse(Buffer.from(encoded, "base64").toString("utf8")),
      );
    } catch {
      /* An old/invalid endpoint never becomes a new CLI launch. */
    }
  }
  return {
    token,
    path: "/bridge/mcp",
    ...(hookToken ? { hookToken, hookPath: "/bridge/permission" } : {}),
    ...(peerRuntime ? { peerRuntime } : {}),
  };
}
