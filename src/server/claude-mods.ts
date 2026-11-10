import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ClientChannel } from "ssh2";
import type { HostConfig } from "../shared/types.js";
import {
  crewMod,
  type ClaudeModsJob,
  type ClaudeModsStatus,
} from "../shared/claude-mods.js";
import { installedClaudeExecutable } from "./ide-chat-claude.js";
import { passwordConnection } from "./ssh-connect.js";
import { remoteCodexCommand } from "./ssh.js";

type CommandResult = { code: number | null; stdout: string };
export type ModsRunner = (
  host: HostConfig,
  args: string[],
  password?: string,
) => Promise<CommandResult>;
export function modsEnvironment(source: NodeJS.ProcessEnv = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^(HARBOR_|CODEX_|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$)/.test(key))
      delete env[key];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** One owned child / SSH exec channel. Never attach to or write to a terminal. */
export const runModsCommand: ModsRunner = async (host, args, password) => {
  const timeout = args[1] === "install" ? 180000 : 20000;
  const connection =
    host.kind === "ssh" ? await passwordConnection(host, password) : undefined;
  const executable = connection ? undefined : await installedClaudeExecutable();
  return new Promise<CommandResult>((resolve, reject) => {
    let channel: ClientChannel | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    let stdout = "",
      bytes = 0,
      finished = false;
    const finish = (error?: Error, code: number | null = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) {
        child?.kill();
        channel?.signal("TERM");
      }
      channel?.close();
      connection?.end();
      error ? reject(error) : resolve({ code, stdout });
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "Mods 명령 실행 시간이 초과되었습니다. 설치 상태를 새로 확인해 주세요.",
          ),
        ),
      timeout,
    );
    timer.unref();
    const collect = (chunk: Buffer, output: boolean) => {
      bytes += chunk.length;
      if (bytes > 512 * 1024) {
        finish(new Error("Mods 명령 출력이 허용 크기를 초과했습니다."));
        return;
      }
      if (output) stdout += chunk.toString("utf8");
    };
    if (connection) {
      connection.on("error", () =>
        finish(new Error("Mods 설치용 SSH 연결에 실패했습니다.")),
      );
      connection.on("close", () => {
        if (!finished)
          finish(
            new Error(
              "Mods 설치용 SSH 연결이 끊겼습니다. 상태를 확인해 주세요.",
            ),
          );
      });
      connection.exec(
        remoteCodexCommand({ codexPath: "claude" }, args, "~"),
        (error, stream) => {
          if (error) {
            finish(new Error("서버의 Claude Code 명령을 실행하지 못했습니다."));
            return;
          }
          if (finished) {
            stream.close();
            return;
          }
          channel = stream;
          stream.on("data", (chunk: Buffer) => collect(chunk, true));
          stream.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
          stream.on("error", () =>
            finish(new Error("Mods 설치용 SSH 명령이 중단되었습니다.")),
          );
          let code: number | null = null;
          stream.on("exit", (value: number | null) => {
            code = value;
          });
          stream.on("close", () => finish(undefined, code));
          stream.end();
        },
      );
    } else {
      const javascript = /\.[cm]?js$/i.test(executable!);
      child = spawn(
        javascript ? process.execPath : executable!,
        javascript ? [executable!, ...args] : args,
        {
          shell: false,
          windowsHide: true,
          cwd: homedir(),
          env: modsEnvironment(),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout!.on("data", (chunk: Buffer) => collect(chunk, true));
      child.stderr!.on("data", (chunk: Buffer) => collect(chunk, false));
      child.on("error", () =>
        finish(
          new Error(
            "Claude Code를 실행하지 못했습니다. CLI 설치를 확인해 주세요.",
          ),
        ),
      );
      child.on("close", (code) => finish(undefined, code));
    }
  });
};

export function parseModsStatus(
  versionText: string,
  listText: string,
): ClaudeModsStatus {
  const version = versionText.match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (!version) throw new Error("Claude Code 버전을 확인하지 못했습니다.");
  const list: unknown = JSON.parse(listText);
  if (!Array.isArray(list))
    throw new Error("Claude 플러그인 목록 형식이 지원되지 않습니다.");
  const match = list.find(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      [entry.id, entry.name].some(
        (value) =>
          typeof value === "string" && value.split("@")[0] === crewMod.id,
      ),
  );
  const [major, minor, patch] = version.split(".").map(Number);
  return {
    version,
    compatible:
      major > 2 ||
      (major === 2 && (minor > 1 || (minor === 1 && patch >= 318))),
    installed: !!match,
    enabled: !!match && match.enabled !== false,
    ...(match && typeof match.id === "string"
      ? { pluginId: match.id.slice(0, 200) }
      : {}),
  };
}

export class ClaudeMods {
  private jobs = new Map<string, ClaudeModsJob>();
  private pending = new Map<string, Promise<void>>();
  constructor(private run: ModsRunner = runModsCommand) {}
  async status(host: HostConfig, password?: string) {
    const version = await this.run(host, ["--version"], password);
    const list = await this.run(host, ["plugin", "list", "--json"], password);
    if (version.code !== 0 || list.code !== 0)
      throw new Error(
        "서버에서 Claude Code 버전과 플러그인 목록을 확인하지 못했습니다. CLI 설치와 연결을 확인해 주세요.",
      );
    return parseModsStatus(version.stdout, list.stdout);
  }
  job(hostId: string) {
    return this.jobs.get(hostId);
  }
  install(host: HostConfig, password?: string) {
    const existing = this.jobs.get(host.id);
    if (existing?.status === "running") return { ...existing };
    const now = Date.now();
    const job: ClaudeModsJob = {
      id: randomUUID(),
      hostId: host.id,
      status: "running",
      message: "Claude Code와 설치 상태를 확인하고 있습니다.",
      startedAt: now,
      updatedAt: now,
    };
    this.jobs.set(host.id, job);
    const work = this.perform({ ...host }, password, job).finally(() =>
      this.pending.delete(host.id),
    );
    this.pending.set(host.id, work);
    return { ...job };
  }
  async settled(hostId: string) {
    await this.pending.get(hostId);
    return this.job(hostId);
  }
  private async perform(
    host: HostConfig,
    password: string | undefined,
    job: ClaudeModsJob,
  ) {
    try {
      let status = await this.status(host, password);
      if (!status.compatible)
        throw new Error(
          `Agent Crew는 Claude Code ${crewMod.minimumVersion} 이상이 필요합니다. 서버의 CLI를 업데이트해 주세요.`,
        );
      if (status.installed && !status.enabled)
        throw new Error(
          "Agent Crew가 설치되어 있지만 비활성화되어 있습니다. 해당 서버 Claude의 /plugin에서 활성화해 주세요.",
        );
      if (!status.installed) {
        job.message = "공개 저장소에서 Agent Crew를 설치하고 있습니다.";
        // No -y / accept-command: additional marketplace command approval is not bypassed.
        const result = await this.run(
          host,
          [
            "plugin",
            "install",
            crewMod.id,
            "--marketplace",
            crewMod.marketplace,
            "--scope",
            "user",
            "--json",
          ],
          password,
        );
        if (result.code !== 0)
          throw new Error(
            "Agent Crew 설치가 완료되지 않았습니다. 서버의 네트워크·Claude 버전을 확인해 주세요. 추가 명령 승인이 필요한 설치는 CLI에서 직접 확인하세요.",
          );
        status = await this.status(host, password);
        if (!status.installed || !status.enabled)
          throw new Error(
            "설치 명령은 끝났지만 Agent Crew 활성화를 확인하지 못했습니다. 설치 상태를 다시 확인해 주세요.",
          );
      }
      job.status = "succeeded";
      job.result = status;
      job.message =
        "Agent Crew 설치를 확인했습니다. 해당 서버에서 다음에 여는 Claude 세션부터 사용할 수 있습니다.";
    } catch (error) {
      job.status = "failed";
      job.message =
        error instanceof Error ? error.message : "Mods 설치에 실패했습니다.";
    } finally {
      job.updatedAt = Date.now();
    }
  }
}
