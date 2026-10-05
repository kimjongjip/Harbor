import ssh2, { Client, type AnyAuthMethod, type ClientChannel } from "ssh2";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { HostConfig } from "../shared/types.js";
import { remoteCodexCommand, sshArgs } from "./ssh.js";

const exec = promisify(execFile);
export async function passwordConnection(
  host: HostConfig,
  password?: string,
): Promise<Client> {
  // OpenSSH resolves HostName/User/Port, including aliases and Include directives.
  const args = sshArgs(host).filter((x) => x !== "-T");
  const { stdout } = await exec("ssh", ["-G", ...args], {
    windowsHide: true,
    timeout: 10000,
  });
  const config = Object.fromEntries(
    stdout.split(/\r?\n/).map((line) => {
      const i = line.indexOf(" ");
      return [line.slice(0, i), line.slice(i + 1).trim()];
    }),
  );
  if (
    (config.proxyjump && config.proxyjump !== "none") ||
    (config.proxycommand && config.proxycommand !== "none")
  )
    throw new Error(
      "파일 탐색과 비밀번호 연결은 현재 직접 SSH 접속을 지원합니다. 점프 호스트의 Codex와 터미널은 SSH 키 방식으로 연결해 주세요.",
    );
  const hostname = config.hostname || host.address;
  const port = Number(config.port) || host.port;
  const username = host.username || config.user;
  const knownName = port === 22 ? hostname : `[${hostname}]:${port}`;
  let keys: Buffer[] = [];
  try {
    const known = await exec(
      "ssh-keygen",
      ["-F", knownName, "-f", join(homedir(), ".ssh", "known_hosts")],
      { windowsHide: true, timeout: 10000 },
    );
    keys = known.stdout
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => Buffer.from(l.trim().split(/\s+/)[2] || "", "base64"))
      .filter((k) => k.length > 0);
  } catch {
    /* Report a concrete first-connection action below. */
  }
  if (!keys.length) {
    const verifyCommand = [
      "ssh",
      ...(host.port !== 22 ? ["-p", String(host.port)] : []),
      ...(host.username ? ["-l", host.username] : []),
      host.address,
    ].join(" ");
    throw new Error(
      `서버 키가 아직 등록되지 않았습니다. 새 로컬 터미널에서 ${verifyCommand} 명령으로 서버 지문을 확인한 뒤 다시 연결하세요.`,
    );
  }
  const authHandler: AnyAuthMethod[] = [];
  if (password) {
    authHandler.push(
      { type: "password", username, password },
      {
        type: "keyboard-interactive",
        username,
        prompt: (_name, _instructions, _lang, prompts, finish) =>
          finish(prompts.map(() => password)),
      },
    );
  } else {
    const agent =
      config.identityagent &&
      config.identityagent !== "none" &&
      config.identityagent !== "SSH_AUTH_SOCK"
        ? config.identityagent
        : process.env.SSH_AUTH_SOCK ||
          (process.platform === "win32"
            ? "\\\\.\\pipe\\openssh-ssh-agent"
            : undefined);
    if (agent) authHandler.push({ type: "agent", username, agent });
    const identityFiles = host.identityFile
      ? [host.identityFile]
      : stdout
          .split(/\r?\n/)
          .filter((l) => l.startsWith("identityfile "))
          .map((l) => l.slice(13).trim());
    for (const filename of identityFiles) {
      try {
        const key = readFileSync(filename.replace(/^~(?=[/\\])/, homedir()));
        if (!(ssh2.utils.parseKey(key) instanceof Error))
          authHandler.push({ type: "publickey", username, key });
      } catch {
        /* Missing defaults and encrypted keys are handled by ssh-agent. */
      }
    }
    if (!authHandler.length)
      throw new Error(
        "SFTP 인증에 사용할 SSH 키가 없습니다. 서버 연결 창에서 비밀번호로 연결하거나 ssh-agent에 키를 추가해 주세요.",
      );
  }
  const connection = new Client();
  return new Promise((resolve, reject) => {
    let settled = false;
    const onError = (error: Error) => {
      if (!settled) {
        settled = true;
        connection.end();
        reject(error);
      }
    };
    connection.on("error", onError);
    connection.once("ready", () => {
      settled = true;
      resolve(connection);
    });
    connection.connect({
      host: hostname,
      port,
      username,
      authHandler,
      readyTimeout: 18000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer) =>
        keys.some(
          (known) => known.length === key.length && timingSafeEqual(known, key),
        ),
    });
  });
}
export async function sshCodexChannel(
  host: HostConfig,
  password: string,
  shared: boolean,
): Promise<{ connection: Client; channel: ClientChannel }> {
  const connection = await passwordConnection(host, password);
  const command = remoteCodexCommand(
    host,
    shared ? ["app-server", "proxy"] : ["app-server", "--listen", "stdio://"],
  );
  return new Promise((resolve, reject) => {
    connection.exec(command, (error, channel) => {
      if (error) {
        connection.end();
        reject(error);
      } else resolve({ connection, channel });
    });
  });
}
