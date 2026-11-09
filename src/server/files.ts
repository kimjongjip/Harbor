import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Client, SFTPWrapper, Stats } from "ssh2";
import type { DirectoryView, HostConfig } from "../shared/types.js";
import { passwordConnection } from "./ssh-connect.js";
import { shellQuote } from "./ssh.js";
import {
  uploadParts,
  validateUploadManifest,
  type UploadManifest,
  type UploadDestination,
} from "../shared/upload-tree.js";

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
  /** Server-only editor transport; callers must enforce their terminal workspace scope. */
  async editorSftp(host: HostConfig) {
    if (host.kind !== "ssh") throw new Error("SSH 서버를 선택하세요.");
    return this.sftp(host);
  }
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
    let resolved = await this.resolvePath(host, filename, cwd);
    const sftp = host.kind === "ssh" ? await this.sftp(host) : undefined;
    const statPath = (value: string) =>
      sftp ? call<Stats>((cb) => sftp.stat(value, cb)) : fs.stat(value);
    const paths = host.kind === "ssh" ? path.posix : path;
    const missing = (error: unknown) =>
      ["ENOENT", "ENOTDIR", 2].includes(
        (error as NodeJS.ErrnoException)?.code as string | number,
      );
    let resolvedFrom: string | undefined;
    let stat;
    try {
      stat = await statPath(resolved);
    } catch (error) {
      // CLI answers often use repository-relative links from a nested cwd.
      // Honor the exact location first; explicit relative/absolute paths stay exact.
      if (
        !missing(error) ||
        paths.isAbsolute(filename) ||
        /^(?:~(?:[/\\]|$)|\.\.?[/\\])/.test(filename) ||
        filename
          .split(host.kind === "ssh" ? /\// : /[/\\]/)
          .some((part) => part === "." || part === "..")
      )
        throw error;
      let directory = await this.resolvePath(host, ".", cwd);
      const originalDirectory = directory;
      let repository: string | undefined;
      const attempted = [resolved];
      for (let depth = 0; depth < 16; depth++) {
        let marker;
        try {
          marker = await statPath(paths.join(directory, ".git"));
        } catch (failure) {
          if (!missing(failure)) throw failure;
        }
        if (marker?.isDirectory() || marker?.isFile()) {
          repository = directory;
          // Stop at the nearest repository/worktree; never search other projects.
          const candidate = paths.resolve(directory, filename);
          const inside = paths.relative(directory, candidate);
          if (
            candidate !== resolved &&
            inside !== ".." &&
            !inside.startsWith(`..${paths.sep}`) &&
            !paths.isAbsolute(inside)
          ) {
            attempted.push(candidate);
            try {
              stat = await statPath(candidate);
              resolved = candidate;
              resolvedFrom = directory;
            } catch (failure) {
              if (!missing(failure)) throw failure;
            }
          }
          break;
        }
        const parent = paths.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
      // A non-Git document folder may also be repeated in a CLI link:
      // /project/docs + docs/guide.md means /project/docs/guide.md.
      // Only remove this explicit one-folder overlap, never search siblings.
      const first = filename.split(host.kind === "ssh" ? /\// : /[/\\]/)[0];
      const folder = paths.basename(originalDirectory);
      const sameFolder =
        host.kind === "local" && process.platform === "win32"
          ? first.toLowerCase() === folder.toLowerCase()
          : first === folder;
      if (!stat && sameFolder && filename.length > first.length) {
        const base = paths.dirname(originalDirectory);
        const candidate = paths.resolve(base, filename);
        const inside = repository ? paths.relative(repository, candidate) : "";
        if (
          candidate !== resolved &&
          inside !== ".." &&
          !inside.startsWith(`..${paths.sep}`) &&
          !paths.isAbsolute(inside)
        ) {
          attempted.push(candidate);
          try {
            stat = await statPath(candidate);
            resolved = candidate;
            resolvedFrom = base;
          } catch (failure) {
            if (!missing(failure)) throw failure;
          }
        }
      }
      if (!stat)
        throw new Error(
          `파일을 찾을 수 없습니다. 확인한 경로: ${attempted.join(" · ")}`,
          { cause: error },
        );
    }
    const base = {
      name: (host.kind === "ssh" ? path.posix : path).basename(resolved),
      path: resolved,
      size: stat.size,
      ...(resolvedFrom ? { resolvedFrom } : {}),
    };
    if (stat.isDirectory()) return { ...base, kind: "directory" };
    if (!stat.isFile()) throw new Error("일반 파일만 미리볼 수 있습니다.");
    if (/\.html?$/i.test(resolved)) return { ...base, kind: "html" };
    if (/\.pdf$/i.test(resolved)) return { ...base, kind: "pdf" };
    if (/\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(resolved)) {
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
  async htmlResource(host: HostConfig, root: string, relative: string) {
    const parts = relative.split("/");
    if (
      !relative ||
      /[\\:\x00-\x1f]/.test(relative) ||
      parts.some((part) => !part || part.startsWith("."))
    )
      throw new Error("HTML 문서 폴더 안의 파일만 열 수 있습니다.");
    const paths = host.kind === "ssh" ? path.posix : path;
    const sftp = host.kind === "ssh" ? await this.sftp(host) : undefined;
    const canonical = (value: string) =>
      sftp
        ? call<string>((cb) => sftp.realpath(value, cb))
        : fs.realpath(value);
    const base = await canonical(validateFilePath(host, root));
    const filename = await canonical(paths.join(base, ...parts));
    const child = paths.relative(base, filename);
    if (
      !child ||
      child === ".." ||
      child.startsWith(`..${paths.sep}`) ||
      paths.isAbsolute(child)
    )
      throw new Error("HTML 문서 폴더 밖의 파일은 읽을 수 없습니다.");
    const stat = sftp
      ? await call<Stats>((cb) => sftp.stat(filename, cb))
      : await fs.stat(filename);
    if (!stat.isFile())
      throw new Error("일반 HTML 파일과 리소스만 열 수 있습니다.");
    // Opening a preview is metadata-only. Read only when the browser requests
    // content; never buffer the entire HTML/JSON in the backend (or read it twice).
    return {
      root: base,
      size: stat.size,
      openRead: (range = { start: 0, end: stat.size - 1 }): Readable => {
        if (!stat.size) return Readable.from([]);
        const options = { ...range, highWaterMark: 64 * 1024 };
        return sftp
          ? sftp.createReadStream(filename, options)
          : createReadStream(filename, options);
      },
    };
  }
  async researchDirectory(host: HostConfig, directory: string) {
    const resolved = await this.resolvePath(host, directory, "~");
    const sftp = host.kind === "ssh" ? await this.sftp(host) : undefined;
    const canonical = sftp
      ? await call<string>((cb) => sftp.realpath(resolved, cb))
      : await fs.realpath(resolved);
    validateFilePath(host, canonical);
    const details = sftp
      ? await call<Stats>((cb) => sftp.stat(canonical, cb))
      : await fs.stat(canonical);
    if (!details.isDirectory())
      throw new Error("연구할 프로젝트 폴더를 확인하세요.");
    return canonical;
  }
  async researchArtifact(
    host: HostConfig,
    root: string,
    cwd: string,
    filename: string,
  ) {
    const sftp = host.kind === "ssh" ? await this.sftp(host) : undefined;
    const canonical = async (value: string) =>
      sftp
        ? call<string>((cb) => sftp.realpath(value, cb))
        : fs.realpath(value);
    const paths = host.kind === "ssh" ? path.posix : path;
    const base = await canonical(validateFilePath(host, root));
    const file = await canonical(await this.resolvePath(host, filename, cwd));
    const child = paths.relative(base, file);
    if (
      !child ||
      child === ".." ||
      child.startsWith(`..${paths.sep}`) ||
      paths.isAbsolute(child)
    )
      throw new Error(
        "참여자의 작업 폴더 안에 있는 산출물만 읽을 수 있습니다.",
      );
    const details = sftp
      ? await call<Stats>((cb) => sftp.stat(file, cb))
      : await fs.stat(file);
    const limit = 512 * 1024;
    if (!details.isFile() || details.size > limit)
      throw new Error("512 KB 이하의 텍스트 산출물만 읽을 수 있습니다.");
    const stream = sftp
      ? sftp.createReadStream(file, { start: 0, end: limit })
      : createReadStream(file, { start: 0, end: limit });
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > limit || bytes.includes(0))
          throw new Error("512 KB 이하의 텍스트 산출물만 읽을 수 있습니다.");
        chunks.push(bytes);
      }
    } finally {
      stream.destroy();
    }
    return { path: file, bytes: Buffer.concat(chunks) };
  }
  async researchCommand(host: HostConfig, command: string): Promise<string> {
    if (host.kind !== "ssh") throw new Error("SSH 서버를 선택하세요.");
    await this.sftp(host);
    const connection = this.connections.get(host.id)?.connection;
    if (!connection) throw new Error("연구 서버 연결이 종료되었습니다.");
    return new Promise((resolve, reject) => {
      connection.exec(command, (error, channel) => {
        if (error) {
          reject(error);
          return;
        }
        let stdout = "",
          stderr = "",
          exitCode: number | undefined;
        const timer = setTimeout(() => {
          channel.destroy();
          reject(new Error("연구 작업 폴더 준비 시간이 초과됐습니다."));
        }, 30000);
        channel.setEncoding("utf8");
        channel.stderr.setEncoding("utf8");
        channel.on("data", (value: string) => {
          stdout += value;
          if (Buffer.byteLength(stdout) > 1024 * 1024) {
            channel.destroy();
            reject(new Error("연구 서버의 응답이 너무 큽니다."));
          }
        });
        channel.stderr.on("data", (value: string) => {
          stderr = (stderr + value).slice(-4000);
        });
        channel.on("exit", (code: number) => {
          exitCode = code;
        });
        channel.on("error", (error: Error) => {
          clearTimeout(timer);
          reject(error);
        });
        channel.once("close", () => {
          clearTimeout(timer);
          if (exitCode === 0) resolve(stdout);
          else
            reject(
              new Error(
                stderr.trim() || "연구 서버의 작업 폴더 준비에 실패했습니다.",
              ),
            );
        });
      });
    });
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
                : /\.svg$/i.test(filename) &&
                    /^\s*(?:<\?xml[^>]*>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE\s+svg[^>]*>)\s*)*<svg(?:\s|>)/i.test(
                      bytes.toString("utf8"),
                    )
                  ? "image/svg+xml"
                  : undefined;
    if (!mime) throw new Error("미리보기를 지원하는 이미지 형식이 아닙니다.");
    return { bytes, mime };
  }
  async prepareUpload(
    host: HostConfig,
    directory: string,
    manifest: UploadManifest,
    signal?: AbortSignal,
  ) {
    validateUploadManifest(manifest);
    validateFilePath(host, directory);
    const paths = host.kind === "ssh" ? path.posix : path;
    const sftp = host.kind === "ssh" ? await this.sftp(host) : undefined;
    const target = sftp
      ? await call<string>((cb) => sftp.realpath(directory, cb))
      : await fs.realpath(directory);
    validateFilePath(host, target);
    const stat = sftp
      ? await call<Stats>((cb) => sftp.stat(target, cb))
      : await fs.stat(target);
    if (!stat.isDirectory())
      throw new Error("업로드할 대상 폴더를 선택하세요.");
    const names = [
      ...manifest.directories,
      ...manifest.files.map((f) => f.relativePath),
    ];
    const seen = new Set<string>();
    for (const name of names) {
      for (const part of uploadParts(name)) {
        safeFilename(part);
        if (
          host.kind === "local" &&
          process.platform === "win32" &&
          /[<>:"|?*]|[. ]$/.test(part)
        )
          throw new Error("Windows에서 사용할 수 없는 파일 이름입니다.");
      }
      const key =
        host.kind === "local" && process.platform === "win32"
          ? name.toLowerCase()
          : name;
      if (seen.has(key)) throw new Error("같은 업로드 경로가 중복되었습니다.");
      seen.add(key);
    }
    // Reserve new top-level folders, rather than merging into existing contents.
    // Preflight every root before creating anything; wx protects file writes too.
    const roots = [...new Set(names.map((name) => uploadParts(name)[0]))];
    for (const name of roots) {
      signal?.throwIfAborted();
      let exists = false;
      try {
        const destination = paths.join(target, name);
        if (sftp) await call<Stats>((cb) => sftp.lstat(destination, cb));
        else await fs.lstat(destination);
        exists = true;
      } catch (error) {
        if (!["ENOENT", 2].includes((error as any).code)) throw error;
      }
      if (exists)
        throw new Error(
          `대상에 같은 이름의 파일이나 폴더가 있습니다: ${name}. 이름을 바꾸거나 다른 폴더에 올려주세요. 기존 항목은 덮어쓰지 않습니다.`,
        );
    }
    const created: string[] = [];
    try {
      for (const relative of [...manifest.directories].sort(
        (a, b) => uploadParts(a).length - uploadParts(b).length,
      )) {
        signal?.throwIfAborted();
        const destination = paths.join(target, ...uploadParts(relative));
        if (sftp)
          await call<void>((cb) =>
            sftp.mkdir(destination, { mode: 0o755 }, cb),
          );
        else await fs.mkdir(destination, { mode: 0o755 });
        created.push(destination);
      }
      signal?.throwIfAborted();
      const files: UploadDestination[] = manifest.files.map((file) => {
        const parts = uploadParts(file.relativePath),
          name = parts.pop()!;
        return {
          relativePath: file.relativePath,
          directory: paths.join(target, ...parts),
          name,
        };
      });
      return { path: target, directoryCount: created.length, files };
    } catch (error) {
      // Only empty directories successfully created by this request are removed.
      for (const destination of created.reverse()) {
        if (sftp)
          await call<void>((cb) => sftp.rmdir(destination, cb)).catch(() => {});
        else await fs.rmdir(destination).catch(() => {});
      }
      throw error;
    }
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
