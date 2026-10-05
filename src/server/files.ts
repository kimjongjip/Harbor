import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Client, SFTPWrapper, Stats } from "ssh2";
import type { DirectoryView, HostConfig } from "../shared/types.js";
import { passwordConnection } from "./ssh-connect.js";
import { shellQuote } from "./ssh.js";

export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
export function safeFilename(name: string) {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.length > 255 ||
    /[\x00-\x1f/\\]/.test(name)
  )
    throw new Error("파일 이름에 경로 또는 제어 문자를 사용할 수 없습니다.");
  return name;
}
export function validateFilePath(
  host: Pick<HostConfig, "kind">,
  value: string,
) {
  if (
    !value ||
    /[\0\r\n]/.test(value) ||
    !(host.kind === "ssh"
      ? path.posix.isAbsolute(value)
      : path.isAbsolute(value))
  )
    throw new Error("파일의 절대 경로를 입력하세요.");
  return value;
}
const call = <T>(
  fn: (cb: (error: Error | undefined | null, result: T) => void) => void,
) =>
  new Promise<T>((resolve, reject) =>
    fn((e, result) => (e ? reject(e) : resolve(result))),
  );
export class Files {
  private connections = new Map<
    string,
    { connection: Client; sftp: SFTPWrapper }
  >();
  private opening = new Map<string, Promise<SFTPWrapper>>();
  private generations = new Map<string, number>();
  private attachmentHomes = new Map<string, Promise<string>>();
  constructor(private password: (id: string) => string | undefined) {}
  private async sftp(host: HostConfig) {
    const existing = this.connections.get(host.id);
    if (existing) return existing.sftp;
    const pending = this.opening.get(host.id);
    if (pending) return pending;
    const generation = this.generations.get(host.id) ?? 0;
    const promise = (async () => {
      const connection = await passwordConnection(host, this.password(host.id));
      try {
        if ((this.generations.get(host.id) ?? 0) !== generation)
          throw new Error("파일 연결이 취소됐습니다. 서버에 다시 연결하세요.");
        const sftp = await call<SFTPWrapper>((cb) => connection.sftp(cb));
        if ((this.generations.get(host.id) ?? 0) !== generation)
          throw new Error("파일 연결이 취소됐습니다. 서버에 다시 연결하세요.");
        this.connections.set(host.id, { connection, sftp });
        const closed = () => {
          const entry = this.connections.get(host.id);
          if (entry?.connection === connection) {
            this.connections.delete(host.id);
            this.attachmentHomes.delete(host.id);
          }
        };
        connection.on("close", closed);
        sftp.on("close", closed);
        sftp.on("error", () => {
          closed();
          connection.end();
        });
        return sftp;
      } catch (e) {
        connection.end();
        throw e;
      }
    })().finally(() => {
      if (this.opening.get(host.id) === promise) this.opening.delete(host.id);
    });
    this.opening.set(host.id, promise);
    return promise;
  }
  async list(host: HostConfig, directory: string): Promise<DirectoryView> {
    if (host.kind === "local") {
      const canonical = await fs.realpath(
        validateFilePath(host, directory || host.defaultCwd),
      );
      const names = await fs.readdir(canonical, { withFileTypes: true });
      const entries: DirectoryView["entries"] = [];
      // Bound filesystem concurrency for large directories.
      const visible = names.slice(0, 5000);
      for (let start = 0; start < visible.length; start += 30)
        await Promise.all(
          visible.slice(start, start + 30).map(async (entry) => {
            const full = path.join(canonical, entry.name);
            try {
              const stat = await fs.lstat(full);
              entries.push({
                name: entry.name,
                path: full,
                kind: stat.isDirectory()
                  ? "directory"
                  : stat.isSymbolicLink()
                    ? "symlink"
                    : stat.isFile()
                      ? "file"
                      : "other",
                size: stat.size,
                modifiedAt: stat.mtimeMs,
                mode: stat.mode,
              });
            } catch {
              /* File may disappear while listing. */
            }
          }),
        );
      return {
        path: canonical,
        parent: path.dirname(canonical),
        entries,
        truncated: names.length > 5000,
      };
    }
    const sftp = await this.sftp(host);
    const canonical = await call<string>((cb) =>
      sftp.realpath(
        directory ? validateFilePath(host, directory) : host.defaultCwd || ".",
        cb,
      ),
    );
    const entries = await call<any[]>((cb) => sftp.readdir(canonical, cb));
    return {
      path: canonical,
      parent: path.posix.dirname(canonical),
      entries: entries.slice(0, 5000).map((e) => ({
        name: e.filename,
        path: path.posix.join(canonical, e.filename),
        kind: e.attrs.isDirectory()
          ? "directory"
          : e.attrs.isSymbolicLink()
            ? "symlink"
            : e.attrs.isFile()
              ? "file"
              : "other",
        size: e.attrs.size,
        modifiedAt: e.attrs.mtime * 1000,
        mode: e.attrs.mode,
      })),
      truncated: entries.length > 5000,
    };
  }
  async download(host: HostConfig, filename: string) {
    validateFilePath(host, filename);
    const sftp = host.kind === "ssh" ? await this.sftp(host) : undefined;
    const stat = sftp
      ? await call<Stats>((cb) => sftp.stat(filename, cb))
      : await fs.stat(filename);
    if (!stat.isFile()) throw new Error("파일을 선택해 다운로드해 주세요.");
    return {
      size: stat.size,
      name: (host.kind === "ssh" ? path.posix : path).basename(filename),
      stream: sftp
        ? sftp.createReadStream(filename)
        : createReadStream(filename),
    };
  }
  async resolvePath(host: HostConfig, filename: string, cwd: string) {
    if (!filename || /[\0\r\n]/.test(filename))
      throw new Error("파일 경로를 확인하세요.");
    const paths = host.kind === "ssh" ? path.posix : path;
    if (paths.isAbsolute(filename)) return validateFilePath(host, filename);
    const isHomePath = (value: string) =>
      value === "~" ||
      value.startsWith("~/") ||
      (host.kind === "local" && value.startsWith("~\\"));
    let home: string | undefined;
    const getHome = async () => {
      if (!home) {
        if (host.kind === "local") home = homedir();
        else {
          const sftp = await this.sftp(host);
          home = await call<string>((cb) => sftp.realpath(".", cb));
        }
        // Never allow path.posix.resolve to fall back to this machine's cwd.
        validateFilePath(host, home);
      }
      return home;
    };
    if (isHomePath(filename))
      return paths.resolve(await getHome(), filename.slice(2));
    let base = cwd || host.defaultCwd || "~";
    if (/[\0\r\n]/.test(base)) throw new Error("Invalid working directory");
    if (isHomePath(base)) base = paths.resolve(await getHome(), base.slice(2));
    else if (!paths.isAbsolute(base))
      base = paths.resolve(await getHome(), base);
    return paths.resolve(validateFilePath(host, base), filename);
  }
  async preview(host: HostConfig, filename: string, cwd: string) {
    const resolved = await this.resolvePath(host, filename, cwd);
    const sftp = host.kind === "ssh" ? await this.sftp(host) : undefined;
    const stat = sftp
      ? await call<Stats>((cb) => sftp.stat(resolved, cb))
      : await fs.stat(resolved);
    const base = {
      name: (host.kind === "ssh" ? path.posix : path).basename(resolved),
      path: resolved,
      size: stat.size,
    };
    if (stat.isDirectory()) return { ...base, kind: "directory" };
    if (!stat.isFile()) throw new Error("일반 파일만 미리볼 수 있습니다.");
    if (/\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(resolved)) {
      if (stat.size > 20 * 1024 * 1024)
        throw new Error("20MB보다 큰 이미지는 다운로드해서 확인해 주세요.");
      return { ...base, kind: "image" };
    }
    const stream = sftp
      ? sftp.createReadStream(resolved, { start: 0, end: 256 * 1024 - 1 })
      : createReadStream(resolved, { start: 0, end: 256 * 1024 - 1 });
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (bytes.includes(0)) return { ...base, kind: "binary" };
    return {
      ...base,
      kind: "text",
      text: bytes.toString("utf8"),
      truncated: stat.size > bytes.length,
    };
  }
  async image(host: HostConfig, filename: string) {
    const file = await this.download(host, filename);
    if (file.size > 20 * 1024 * 1024) {
      file.stream.destroy();
      throw new Error("이미지 미리보기는 20MB까지 지원합니다.");
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of file.stream) {
        size += chunk.length;
        if (size > 20 * 1024 * 1024) throw new Error("이미지가 너무 큽니다.");
        chunks.push(Buffer.from(chunk));
      }
    } finally {
      file.stream.destroy();
    }
    const bytes = Buffer.concat(chunks);
    const mime = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "image/png"
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        ? "image/jpeg"
        : /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())
          ? "image/gif"
          : bytes.subarray(0, 4).toString() === "RIFF" &&
              bytes.subarray(8, 12).toString() === "WEBP"
            ? "image/webp"
            : bytes.subarray(0, 2).toString() === "BM"
              ? "image/bmp"
              : bytes.subarray(4, 12).toString() === "ftypavif"
                ? "image/avif"
                : undefined;
    if (!mime) throw new Error("미리보기를 지원하는 이미지 형식이 아닙니다.");
    return { bytes, mime };
  }
  async upload(
    host: HostConfig,
    directory: string,
    name: string,
    input: Readable,
    mode = 0o644,
  ) {
    validateFilePath(host, directory);
    safeFilename(name);
    if (
      host.kind === "local" &&
      process.platform === "win32" &&
      /[<>:"|?*]|[. ]$/.test(name)
    )
      throw new Error("Windows에서 사용할 수 없는 파일 이름입니다.");
    const destination = (host.kind === "ssh" ? path.posix : path).join(
      directory,
      name,
    );
    const sftp = host.kind === "ssh" ? await this.sftp(host) : undefined;
    let opened = false;
    let bytes = 0;
    // Exclusive creation is mandatory: an existing file is never overwritten, including symlinks.
    const output = sftp
      ? sftp.createWriteStream(destination, { flags: "wx", mode })
      : createWriteStream(destination, { flags: "wx", mode });
    const limit = new Transform({
      transform(chunk, _encoding, cb) {
        bytes += chunk.length;
        cb(
          bytes > MAX_UPLOAD_BYTES
            ? new Error("파일은 개당 512MB까지 업로드할 수 있습니다.")
            : null,
          chunk,
        );
      },
    });
    try {
      // Detect collisions before piping the HTTP request; pipeline would otherwise destroy its socket.
      await new Promise<void>((resolve, reject) => {
        output.once("open", () => {
          opened = true;
          resolve();
        });
        output.once("error", reject);
      });
      await pipeline(input, limit, output);
      return { path: destination, size: bytes };
    } catch (error) {
      if (opened) {
        // Only the exact file exclusively created by this request may be removed on failure.
        if (sftp)
          await call<void>((cb) => sftp.unlink(destination, cb as any)).catch(
            () => {},
          );
        else await fs.unlink(destination).catch(() => {});
      }
      if ((error as any).code === "EEXIST" || (!opened && host.kind === "ssh"))
        throw new Error(
          "업로드할 수 없습니다. 같은 이름의 파일이 있거나 폴더에 쓰기 권한이 없는지 확인하세요. 기존 파일은 덮어쓰지 않습니다.",
        );
      throw error;
    }
  }
  private async attachmentHome(host: HostConfig) {
    if (host.kind === "local")
      return validateFilePath(
        host,
        process.env.CODEX_HOME || path.join(homedir(), ".codex"),
      );
    const existing = this.attachmentHomes.get(host.id);
    if (existing) return existing;
    const pending = (async () => {
      await this.sftp(host);
      const connection = this.connections.get(host.id)!.connection;
      // Login initialization matches native Codex's host environment. Its stdout
      // is hidden; only the selected path is emitted through the preserved fd.
      const command = `exec "\${SHELL:-/bin/sh}" -lc ${shellQuote("printf '%s\\0' \"${CODEX_HOME:-$HOME/.codex}\" >&3")} 3>&1 >/dev/null`;
      return new Promise<string>((resolve, reject) => {
        connection.exec(command, (error, channel) => {
          if (error) {
            reject(error);
            return;
          }
          let output = "";
          const timer = setTimeout(() => {
            channel.close();
            reject(
              new Error("Codex 첨부 저장 폴더를 확인하는 시간이 초과됐습니다."),
            );
          }, 10000);
          channel.setEncoding("utf8");
          channel.on("data", (chunk: string) => {
            output += chunk;
            if (output.length > 16000) {
              channel.close();
              reject(new Error("Codex 저장 경로가 너무 깁니다."));
            }
          });
          channel.stderr.resume();
          channel.on("error", (error: Error) => {
            clearTimeout(timer);
            reject(error);
          });
          channel.on("close", (code: number) => {
            clearTimeout(timer);
            try {
              if (code || !output.endsWith("\0"))
                throw new Error("Codex 첨부 저장 폴더를 확인하지 못했습니다.");
              resolve(validateFilePath(host, output.slice(0, -1)));
            } catch (error) {
              reject(error);
            }
          });
        });
      });
    })();
    this.attachmentHomes.set(host.id, pending);
    pending.catch(() => {
      if (this.attachmentHomes.get(host.id) === pending)
        this.attachmentHomes.delete(host.id);
    });
    return pending;
  }
  async prepareAttachments(host: HostConfig, terminalId: string) {
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(terminalId))
      throw new Error("첨부파일을 저장할 터미널 ID를 확인하세요.");
    const paths = host.kind === "ssh" ? path.posix : path;
    let directory = await this.attachmentHome(host);
    const sftp = host.kind === "ssh" ? await this.sftp(host) : undefined;
    // CODEX_HOME may itself be an intentional user symlink. Canonicalize it,
    // then reject symlinks in Harbor-owned descendants rather than following them.
    if (sftp) {
      await call<void>((cb) =>
        sftp.mkdir(directory, { mode: 0o700 }, cb),
      ).catch(async (error) => {
        const existing = await call<Stats>((cb) => sftp.stat(directory, cb));
        if (!existing.isDirectory()) throw error;
      });
      directory = await call<string>((cb) => sftp.realpath(directory, cb));
    } else {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      directory = await fs.realpath(directory);
    }
    for (const name of ["harbor", "attachments", terminalId]) {
      directory = paths.join(directory, name);
      if (sftp) {
        await call<void>((cb) =>
          sftp.mkdir(directory, { mode: 0o700 }, cb),
        ).catch(() => {});
        const stat = await call<Stats>((cb) => sftp.lstat(directory, cb));
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error("첨부 저장 폴더에 일반 폴더가 아닌 항목이 있습니다.");
      } else {
        await fs.mkdir(directory, { mode: 0o700 }).catch((error) => {
          if (error.code !== "EEXIST") throw error;
        });
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error("첨부 저장 폴더에 일반 폴더가 아닌 항목이 있습니다.");
      }
    }
    return directory;
  }
  async mkdir(host: HostConfig, directory: string, name: string) {
    validateFilePath(host, directory);
    safeFilename(name);
    if (
      host.kind === "local" &&
      process.platform === "win32" &&
      /[<>:"|?*]|[. ]$/.test(name)
    )
      throw new Error("Windows에서 사용할 수 없는 폴더 이름입니다.");
    const destination = (host.kind === "ssh" ? path.posix : path).join(
      directory,
      name,
    );
    if (host.kind === "local") await fs.mkdir(destination);
    else {
      const sftp = await this.sftp(host);
      await call<void>((cb) => sftp.mkdir(destination, { mode: 0o755 }, cb));
    }
    return { path: destination };
  }
  close(id: string) {
    this.attachmentHomes.delete(id);
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.opening.delete(id);
    const entry = this.connections.get(id);
    if (entry) {
      this.connections.delete(id);
      entry.connection.end();
    }
  }
  shutdown() {
    for (const id of new Set([
      ...this.connections.keys(),
      ...this.opening.keys(),
    ]))
      this.close(id);
  }
}
