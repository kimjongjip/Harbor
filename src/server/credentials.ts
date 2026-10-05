import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostConfig } from "../shared/types.js";

type CredentialHost = Pick<
  HostConfig,
  "id" | "kind" | "address" | "username" | "port"
>;
type RecordValue = { target: string; ciphertext: string };
type VaultData = {
  version: 1;
  provider: "windows-dpapi";
  entries: Record<string, RecordValue>;
};

// A saved credential belongs to this connection target, not just an editable profile ID.
function target(host: CredentialHost) {
  return createHash("sha256")
    .update(JSON.stringify([host.kind, host.address, host.username, host.port]))
    .digest("hex");
}

function dpapi(
  operation: "Protect" | "Unprotect",
  input: Buffer,
): Promise<Buffer> {
  if (process.platform !== "win32")
    return Promise.reject(
      new Error(
        "이 운영체제에서는 비밀번호를 저장할 수 없습니다. 이번 연결에만 사용하세요.",
      ),
    );
  // The script and argv contain no credential. Input and output use private pipes.
  const script = `$ErrorActionPreference='Stop'; try { Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $entropy=[Text.Encoding]::UTF8.GetBytes('Harbor.Credentials.v1'); $result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result)); [Array]::Clear($bytes,0,$bytes.Length); [Array]::Clear($result,0,$result.Length) } catch { exit 1 }`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    let output = "";
    let finished = false;
    const timer = setTimeout(() => {
      child.kill();
      fail();
    }, 15000);
    const fail = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(
        new Error(
          operation === "Protect"
            ? "Windows 보안 저장소에 비밀번호를 저장하지 못했습니다."
            : "저장된 비밀번호를 이 Windows 계정에서 열 수 없습니다. 비밀번호를 다시 입력하세요.",
        ),
      );
    };
    child.once("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("ascii");
      if (output.length > 64000) {
        child.kill();
        fail();
      }
    });
    child.once("close", (code) => {
      if (finished) return;
      if (code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) return fail();
      finished = true;
      clearTimeout(timer);
      resolve(Buffer.from(output, "base64"));
    });
    child.stdin.end(input.toString("base64"));
  });
}

export class Credentials {
  readonly available = process.platform === "win32";
  readonly file: string;
  private data: VaultData = {
    version: 1,
    provider: "windows-dpapi",
    entries: {},
  };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, "credentials.json");
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as VaultData;
      if (
        data.version !== 1 ||
        data.provider !== "windows-dpapi" ||
        !data.entries ||
        Array.isArray(data.entries)
      )
        throw new Error("Unsupported credential store");
      for (const entry of Object.values(data.entries))
        if (
          !entry ||
          typeof entry.target !== "string" ||
          typeof entry.ciphertext !== "string" ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(entry.ciphertext)
        )
          throw new Error("Invalid credential record");
      this.data = data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("저장된 SSH 인증 정보 파일을 읽을 수 없습니다.");
    }
  }
  has(host: CredentialHost) {
    return (
      this.available && this.data.entries[host.id]?.target === target(host)
    );
  }
  async get(host: CredentialHost): Promise<string | undefined> {
    await this.queue;
    if (!this.has(host)) return undefined;
    const record = this.data.entries[host.id];
    const clear = await dpapi(
      "Unprotect",
      Buffer.from(record.ciphertext, "base64"),
    );
    try {
      return clear.toString("utf8");
    } finally {
      clear.fill(0);
    }
  }
  set(host: CredentialHost, password: string) {
    if (host.kind !== "ssh")
      return Promise.reject(
        new Error("SSH 서버에만 비밀번호를 저장할 수 있습니다."),
      );
    if (!password || password.length > 2000)
      return Promise.reject(new Error("저장할 비밀번호를 입력하세요."));
    return this.mutate(async () => {
      const clear = Buffer.from(password, "utf8");
      let encrypted: Buffer;
      try {
        encrypted = await dpapi("Protect", clear);
      } finally {
        clear.fill(0);
      }
      const next = {
        ...this.data.entries,
        [host.id]: {
          target: target(host),
          ciphertext: encrypted.toString("base64"),
        },
      };
      this.save(next);
    });
  }
  remove(id: string) {
    return this.mutate(async () => {
      const next = { ...this.data.entries };
      delete next[id];
      this.save(next);
    });
  }
  private mutate(action: () => Promise<void>) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private save(entries: VaultData["entries"]) {
    const next: VaultData = { ...this.data, entries };
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
    renameSync(temp, this.file);
    this.data = next;
  }
}
