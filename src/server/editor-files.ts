import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { Router, json, type Request } from "express";
import iconv from "iconv-lite";
import type { SFTPWrapper, Stats } from "ssh2";
import type {
  DirectoryView,
  HostConfig,
  TerminalInfo,
} from "../shared/types.js";
import type { Files } from "./files.js";
import { fileMediaKind } from "../shared/file-media.js";

export const EDITOR_MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 5000;
type Entry = DirectoryView["entries"][number];
type FileStat = Pick<Stats, "size" | "mode" | "isDirectory" | "isFile">;
export type EditorEncoding = "utf-8" | "utf-16le" | "utf-16be" | "cp949";
export interface EditorFileDetails {
  terminalId: string;
  hostId: string;
  root: string;
  path: string;
  size: number;
  preview: "image" | "pdf" | "html" | "download";
  encodings?: EditorEncoding[];
}

export interface EditorTree {
  terminalId: string;
  hostId: string;
  root: string;
  cwd: string;
  path: string;
  parent: string | null;
  entries: Entry[];
  truncated: boolean;
  binding: string;
}

export interface EditorDocument {
  terminalId: string;
  hostId: string;
  root: string;
  cwd: string;
  path: string;
  content: string;
  version: string;
  binding: string;
  encoding: EditorEncoding;
  bom: boolean;
}

export class EditorError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly current?: EditorDocument,
    readonly details?: EditorFileDetails,
  ) {
    super(message);
  }
}

/** Internal transport, injected in tests. Never selected or configured by a client. */
export interface EditorTransport {
  realpath(filename: string): Promise<string>;
  stat(filename: string): Promise<FileStat>;
  list(directory: string): Promise<{ entries: Entry[]; truncated: boolean }>;
  read(filename: string, limit: number): Promise<Buffer>;
  replace(
    filename: string,
    bytes: Buffer,
    mode: number,
    beforeCommit: () => Promise<void>,
  ): Promise<void>;
}

interface EditorOptions {
  files: Files;
  terminal: (id: string) => TerminalInfo | undefined;
  host: (id: string) => HostConfig;
  prepareHost?: (hostId: string) => Promise<unknown>;
  transport?: (host: HostConfig) => Promise<EditorTransport>;
}

interface Scope {
  terminal: TerminalInfo;
  host: HostConfig;
  identity: string;
  rootSource: string;
  root: string;
  binding: string;
  io: EditorTransport;
  paths: typeof path;
}

const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const call = <T>(
  fn: (cb: (error: Error | null | undefined, value: T) => void) => void,
) =>
  new Promise<T>((resolve, reject) =>
    fn((error, value) => (error ? reject(error) : resolve(value))),
  );
const tooLarge = () =>
  new EditorError(
    413,
    "EDITOR_TOO_LARGE",
    "IDE에서는 2MB 이하의 텍스트 파일을 편집할 수 있습니다.",
  );
const changed = () =>
  new EditorError(
    409,
    "EDITOR_SESSION_CHANGED",
    "터미널의 대화나 서버 홈 폴더가 변경됐습니다. 파일을 다시 열어주세요.",
  );
const forbidden = () =>
  new EditorError(
    403,
    "EDITOR_OUTSIDE_WORKSPACE",
    "선택한 서버의 홈 폴더 안에 있는 파일만 열 수 있습니다.",
  );

const encodings: EditorEncoding[] = ["utf-8", "utf-16le", "utf-16be", "cp949"];
function encodingOption(value: unknown): EditorEncoding | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && encodings.includes(value as EditorEncoding))
    return value as EditorEncoding;
  throw new EditorError(
    400,
    "EDITOR_INVALID_ENCODING",
    "지원하는 문자 인코딩을 선택하세요.",
  );
}

const binary = () =>
  new EditorError(
    415,
    "EDITOR_BINARY",
    "이미지·문서 또는 바이너리 파일입니다. 미리보기나 다운로드로 확인하세요.",
  );
const encodingRequired = () =>
  new EditorError(
    415,
    "EDITOR_ENCODING_REQUIRED",
    "UTF-8로 읽을 수 없는 파일입니다. 한글 문서라면 CP949 / EUC-KR로 다시 열어보세요. 원본 파일은 변경되지 않습니다.",
  );
const invalidEncodedText = (encoding: EditorEncoding) =>
  new EditorError(
    415,
    "EDITOR_INVALID_ENCODING_DATA",
    `${encoding.toUpperCase()} 인코딩으로 온전히 읽을 수 없습니다. 파일이 손상됐거나 다른 인코딩일 수 있습니다. 다운로드로 원본을 확인하세요.`,
  );
const hasBinaryControls = (content: string) =>
  /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(content);

function encoded(content: string, encoding: EditorEncoding, bom: boolean) {
  let bytes =
    encoding === "cp949"
      ? iconv.encode(content, "cp949")
      : Buffer.from(content, encoding === "utf-8" ? "utf8" : "utf16le");
  if (encoding === "utf-16be") bytes = bytes.swap16();
  if (bom) {
    const prefix =
      encoding === "utf-8"
        ? [0xef, 0xbb, 0xbf]
        : encoding === "utf-16le"
          ? [0xff, 0xfe]
          : [0xfe, 0xff];
    bytes = Buffer.concat([Buffer.from(prefix), bytes]);
  }
  return bytes;
}

function text(bytes: Buffer, requested?: EditorEncoding) {
  if (bytes.length > EDITOR_MAX_BYTES) throw tooLarge();
  let encoding = requested || "utf-8";
  let prefix = 0;
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    encoding = "utf-8";
    prefix = 3;
  } else if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    encoding = "utf-16le";
    prefix = 2;
  } else if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    encoding = "utf-16be";
    prefix = 2;
  }
  const payload = bytes.subarray(prefix);
  // Recognize common non-text containers even if their headers happen to be ASCII.
  if (
    !prefix &&
    (/^(?:%PDF-|GIF8[79]a|PK\x03\x04|\x7fELF)/.test(
      bytes.subarray(0, 8).toString("latin1"),
    ) ||
      bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ||
      bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
  )
    throw binary();
  // UTF-16 contains expected zero bytes, so classify its decoded text instead.
  if (
    (encoding === "utf-8" || encoding === "cp949") &&
    hasBinaryControls(payload.toString("latin1"))
  )
    throw binary();
  let content: string;
  try {
    content =
      encoding === "cp949"
        ? iconv.decode(payload, "cp949", { stripBOM: false })
        : new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(
            payload,
          );
  } catch {
    throw encoding === "utf-8" && !prefix
      ? encodingRequired()
      : invalidEncodedText(encoding);
  }
  // CP949's decoder replaces malformed input. Byte-for-byte round-trip rejects it.
  if (!encoded(content, encoding, !!prefix).equals(bytes))
    throw encoding === "utf-8" && !prefix
      ? encodingRequired()
      : invalidEncodedText(encoding);
  if (hasBinaryControls(content)) throw binary();
  return { content, encoding, bom: !!prefix };
}

function encodeEdit(content: string, encoding: EditorEncoding, bom: boolean) {
  if (
    Buffer.from(content, "utf8").toString("utf8") !== content ||
    hasBinaryControls(content)
  )
    throw new EditorError(
      400,
      "EDITOR_INVALID_TEXT",
      "올바른 텍스트를 입력하세요. 원본 파일은 유지했습니다.",
    );
  const bytes = encoded(content, encoding, bom);
  if (bytes.length > EDITOR_MAX_BYTES) throw tooLarge();
  if (text(bytes, encoding).content !== content)
    throw new EditorError(
      400,
      "EDITOR_UNREPRESENTABLE_TEXT",
      "현재 파일 인코딩으로 저장할 수 없는 문자가 있습니다. 원본 파일은 유지했습니다.",
    );
  return bytes;
}

async function readStream(stream: Readable, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) throw tooLarge();
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  } finally {
    stream.destroy();
  }
}

export function localEditorTransport(): EditorTransport {
  return {
    realpath: (filename) => fs.realpath(filename),
    stat: (filename) => fs.stat(filename),
    async list(directory) {
      const children = await fs.readdir(directory, { withFileTypes: true });
      const entries: Entry[] = [];
      // Bounded batches avoid thousands of simultaneous local stat operations.
      const selected = children.slice(0, MAX_ENTRIES);
      for (let offset = 0; offset < selected.length; offset += 32) {
        await Promise.all(
          selected.slice(offset, offset + 32).map(async (entry) => {
            const filename = path.join(directory, entry.name);
            const stat = await fs.lstat(filename).catch(() => undefined);
            if (stat)
              entries.push({
                name: entry.name,
                path: filename,
                kind: stat.isSymbolicLink()
                  ? "symlink"
                  : stat.isDirectory()
                    ? "directory"
                    : stat.isFile()
                      ? "file"
                      : "other",
                size: stat.size,
                modifiedAt: stat.mtimeMs,
                mode: stat.mode,
              });
          }),
        );
      }
      return { entries, truncated: children.length > MAX_ENTRIES };
    },
    async read(filename, limit) {
      const file = await fs.open(filename, "r");
      try {
        const stat = await file.stat();
        if (!stat.isFile())
          throw new EditorError(
            415,
            "EDITOR_NOT_FILE",
            "일반 파일만 편집할 수 있습니다.",
          );
        if (stat.size > limit) throw tooLarge();
        const bytes = Buffer.alloc(Math.min(limit + 1, stat.size + 1));
        let size = 0;
        while (size < bytes.length) {
          const result = await file.read(
            bytes,
            size,
            bytes.length - size,
            null,
          );
          if (!result.bytesRead) break;
          size += result.bytesRead;
        }
        if (size > limit) throw tooLarge();
        // A file growing during a read is not a trustworthy edit base.
        const after = await file.stat();
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
          throw new EditorError(
            409,
            "EDITOR_FILE_CHANGED",
            "파일이 변경 중입니다. 다시 열어주세요.",
          );
        return bytes.subarray(0, size);
      } finally {
        await file.close();
      }
    },
    async replace(filename, bytes, mode, beforeCommit) {
      const temporary = path.join(
        path.dirname(filename),
        `.harbor-edit-${randomUUID()}.tmp`,
      );
      let created = false;
      try {
        const file = await fs.open(temporary, "wx", mode & 0o777);
        created = true;
        try {
          await file.writeFile(bytes);
          await file.chmod(mode & 0o777);
          await file.sync();
        } finally {
          await file.close();
        }
        await beforeCommit();
        await fs.rename(temporary, filename);
        created = false;
      } finally {
        if (created) await fs.unlink(temporary).catch(() => {});
      }
    },
  };
}

export function sshEditorTransport(sftp: SFTPWrapper): EditorTransport {
  return {
    realpath: (filename) => call<string>((cb) => sftp.realpath(filename, cb)),
    stat: (filename) => call<Stats>((cb) => sftp.stat(filename, cb)),
    async list(directory) {
      const children = await call<import("ssh2").FileEntryWithStats[]>((cb) =>
        sftp.readdir(directory, cb),
      );
      return {
        entries: children.slice(0, MAX_ENTRIES).map((entry) => ({
          name: entry.filename,
          path: path.posix.join(directory, entry.filename),
          kind: entry.attrs.isSymbolicLink()
            ? ("symlink" as const)
            : entry.attrs.isDirectory()
              ? ("directory" as const)
              : entry.attrs.isFile()
                ? ("file" as const)
                : ("other" as const),
          size: entry.attrs.size,
          modifiedAt: entry.attrs.mtime * 1000,
          mode: entry.attrs.mode,
        })),
        truncated: children.length > MAX_ENTRIES,
      };
    },
    read: (filename, limit) =>
      readStream(
        sftp.createReadStream(filename, { start: 0, end: limit }),
        limit,
      ),
    async replace(filename, bytes, mode, beforeCommit) {
      const temporary = path.posix.join(
        path.posix.dirname(filename),
        `.harbor-edit-${randomUUID()}.tmp`,
      );
      let opened = false;
      let handle: Buffer | undefined;
      try {
        handle = await call<Buffer>((cb) =>
          sftp.open(temporary, "wx", mode & 0o777, cb),
        );
        opened = true;
        // SSH writes can be partial; use the stream helper's bounded write loop internally.
        for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
          const length = Math.min(32 * 1024, bytes.length - offset);
          await call<void>((cb) =>
            sftp.write(handle!, bytes, offset, length, offset, cb),
          );
        }
        await call<void>((cb) => sftp.fchmod(handle!, mode & 0o777, cb));
        await call<void>((cb) => sftp.close(handle!, cb));
        handle = undefined;
        await beforeCommit();
        try {
          // Only atomic replace. Never unlink the original to emulate an unsupported rename.
          await call<void>((cb) =>
            sftp.ext_openssh_rename(temporary, filename, cb),
          );
        } catch (error) {
          if (
            (error as { code?: number }).code === 8 ||
            /unsupported|not supported/i.test(String((error as Error).message))
          )
            throw new EditorError(
              409,
              "EDITOR_ATOMIC_SAVE_UNAVAILABLE",
              "이 서버는 안전한 원자적 저장을 지원하지 않습니다. 원본 파일은 유지했습니다.",
            );
          throw error;
        }
        opened = false;
      } finally {
        if (handle)
          await call<void>((cb) => sftp.close(handle!, cb)).catch(() => {});
        if (opened)
          await call<void>((cb) => sftp.unlink(temporary, cb)).catch(() => {});
      }
    },
  };
}

export class EditorFiles {
  private readonly epoch = randomUUID();
  private writes = new Map<string, Promise<unknown>>();
  constructor(private readonly options: EditorOptions) {}

  private identity(terminal: TerminalInfo, host: HostConfig) {
    return JSON.stringify([
      terminal.id,
      terminal.hostId,
      terminal.program,
      terminal.agentKind,
      terminal.agentSessionId,
      terminal.resumeThreadId,
      host.kind,
      host.address,
      host.port,
      host.username,
      host.identityFile,
    ]);
  }

  private terminal(id: string) {
    const terminal = this.options.terminal(id);
    if (!terminal || terminal.exited)
      throw new EditorError(
        404,
        "EDITOR_TERMINAL_MISSING",
        "실행 중인 터미널을 선택하세요.",
      );
    return { ...terminal };
  }

  private async scope(id: string) {
    const terminal = this.terminal(id);
    const host = { ...this.options.host(terminal.hostId) };
    const identity = this.identity(terminal, host);
    await this.options.prepareHost?.(host.id);
    const io = this.options.transport
      ? await this.options.transport(host)
      : host.kind === "local"
        ? localEditorTransport()
        : sshEditorTransport(await this.options.files.editorSftp(host));
    const rootSource = await this.options.files.resolvePath(host, "~", "~");
    const root = await io.realpath(rootSource);
    const paths = host.kind === "ssh" ? path.posix : path;
    if (!paths.isAbsolute(root)) throw forbidden();
    if (!(await io.stat(root)).isDirectory())
      throw new EditorError(
        400,
        "EDITOR_WORKSPACE_MISSING",
        "서버의 홈 폴더를 찾을 수 없습니다.",
      );
    const binding = hash(`${this.epoch}\0${identity}\0${root}`);
    const scope: Scope = {
      terminal,
      host,
      identity,
      rootSource,
      root,
      binding,
      io,
      paths,
    };
    await this.assertCurrent(scope);
    return scope;
  }

  private assertIdentity(scope: Scope, write = false) {
    const terminal = this.terminal(scope.terminal.id);
    const host = this.options.host(terminal.hostId);
    if (this.identity(terminal, host) !== scope.identity) throw changed();
    if (
      write &&
      terminal.connectionState &&
      terminal.connectionState !== "connected"
    )
      throw new EditorError(
        409,
        "EDITOR_SESSION_OFFLINE",
        "터미널 연결을 복구한 뒤 저장하세요. 편집 내용은 유지됩니다.",
      );
  }

  private async assertCurrent(scope: Scope, write = false) {
    this.assertIdentity(scope, write);
    if ((await scope.io.realpath(scope.rootSource)) !== scope.root)
      throw changed();
    this.assertIdentity(scope, write);
  }

  private inside(scope: Scope, filename: string) {
    const relative = scope.paths.relative(scope.root, filename);
    if (
      relative === ".." ||
      relative.startsWith(`..${scope.paths.sep}`) ||
      scope.paths.isAbsolute(relative)
    )
      throw forbidden();
    return filename;
  }

  private async filename(scope: Scope, value: string) {
    if (
      typeof value !== "string" ||
      value.length > 8192 ||
      /[\0\r\n]/.test(value)
    )
      throw new EditorError(
        400,
        "EDITOR_INVALID_PATH",
        "올바른 파일 경로를 지정하세요.",
      );
    const requested = scope.paths.resolve(scope.root, value || ".");
    this.inside(scope, requested);
    const canonical = await scope.io.realpath(requested);
    if (!scope.paths.isAbsolute(canonical)) throw forbidden();
    return this.inside(scope, canonical);
  }

  private async document(
    scope: Scope,
    filename: string,
    encoding?: EditorEncoding,
  ): Promise<EditorDocument> {
    const stat = await scope.io.stat(filename);
    if (!stat.isFile())
      throw new EditorError(
        415,
        "EDITOR_NOT_FILE",
        "일반 파일만 편집할 수 있습니다.",
      );
    try {
      // Media never enters the text-size/encoding path, regardless of its size.
      if (fileMediaKind(filename)) {
        if ((await scope.io.realpath(filename)) !== filename) throw forbidden();
        await this.assertCurrent(scope);
        throw binary();
      }
      if (stat.size > EDITOR_MAX_BYTES) throw tooLarge();
      const bytes = await scope.io.read(filename, EDITOR_MAX_BYTES);
      if ((await scope.io.realpath(filename)) !== filename) throw forbidden();
      await this.assertCurrent(scope);
      return {
        terminalId: scope.terminal.id,
        hostId: scope.host.id,
        root: scope.root,
        cwd: scope.terminal.cwd,
        path: filename,
        ...text(bytes, encoding),
        version: hash(bytes),
        binding: scope.binding,
      };
    } catch (error) {
      if (
        error instanceof EditorError &&
        [
          "EDITOR_BINARY",
          "EDITOR_ENCODING_REQUIRED",
          "EDITOR_INVALID_ENCODING_DATA",
          "EDITOR_TOO_LARGE",
        ].includes(error.code)
      ) {
        const extension = scope.paths.extname(filename).toLowerCase();
        throw new EditorError(
          error.status,
          error.code,
          error.message,
          undefined,
          {
            terminalId: scope.terminal.id,
            hostId: scope.host.id,
            root: scope.root,
            path: filename,
            size: stat.size,
            preview:
              fileMediaKind(filename) ||
              (/\.html?$/.test(extension) ? "html" : "download"),
            ...(error.code === "EDITOR_ENCODING_REQUIRED"
              ? { encodings: ["cp949" as const] }
              : {}),
          },
        );
      }
      throw error;
    }
  }

  async list(terminalId: string, directory = ""): Promise<EditorTree> {
    const scope = await this.scope(terminalId);
    const filename = await this.filename(scope, directory);
    if (!(await scope.io.stat(filename)).isDirectory())
      throw new EditorError(400, "EDITOR_NOT_DIRECTORY", "폴더를 선택하세요.");
    const result = await scope.io.list(filename);
    if ((await scope.io.realpath(filename)) !== filename) throw forbidden();
    await this.assertCurrent(scope);
    const entries = result.entries
      .filter(
        (entry) =>
          entry.name !== "." &&
          entry.name !== ".." &&
          !/[\0\r\n/\\]/.test(entry.name),
      )
      .map((entry) => ({
        ...entry,
        path: scope.paths.join(filename, entry.name),
      }));
    entries.sort(
      (left, right) =>
        Number(right.kind === "directory") -
          Number(left.kind === "directory") ||
        left.name.localeCompare(right.name),
    );
    return {
      terminalId,
      hostId: scope.host.id,
      root: scope.root,
      cwd: scope.terminal.cwd,
      path: filename,
      parent: filename === scope.root ? null : scope.paths.dirname(filename),
      entries,
      truncated: result.truncated,
      binding: scope.binding,
    };
  }

  async read(terminalId: string, filename: string, encoding?: EditorEncoding) {
    const scope = await this.scope(terminalId);
    return this.document(
      scope,
      await this.filename(scope, filename),
      encodingOption(encoding),
    );
  }

  async save(
    terminalId: string,
    input: {
      path: string;
      content: string;
      expectedVersion: string;
      binding: string;
      encoding?: EditorEncoding;
    },
    authorize?: () => Promise<unknown> | unknown,
  ) {
    if (
      !input ||
      typeof input.content !== "string" ||
      !/^[a-f\d]{64}$/.test(input.expectedVersion) ||
      !/^[a-f\d]{64}$/.test(input.binding)
    )
      throw new EditorError(
        400,
        "EDITOR_INVALID_SAVE",
        "파일의 원본 버전과 편집 내용을 함께 보내세요.",
      );
    const encoding = encodingOption(input.encoding);
    const scope = await this.scope(terminalId);
    if (scope.binding !== input.binding) throw changed();
    const filename = await this.filename(scope, input.path);
    // Canonical key also serializes aliases from different terminals in one host.
    const authority =
      scope.host.kind === "local"
        ? "local"
        : JSON.stringify([
            scope.host.address,
            scope.host.port,
            scope.host.username,
          ]);
    const key = `${authority}\0${process.platform === "win32" && scope.host.kind === "local" ? filename.toLowerCase() : filename}`;
    const previous = this.writes.get(key) || Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        await authorize?.();
        await this.assertCurrent(scope, true);
        if ((await this.filename(scope, input.path)) !== filename)
          throw forbidden();
        const current = await this.document(scope, filename, encoding);
        const conflict = (latest: EditorDocument) => {
          if (latest.version !== input.expectedVersion)
            throw new EditorError(
              409,
              "EDITOR_CONFLICT",
              "다른 작업에서 파일을 변경했습니다. 변경 내용을 비교한 뒤 다시 저장하세요.",
              latest,
            );
        };
        conflict(current);
        const bytes = encodeEdit(input.content, current.encoding, current.bom);
        const stat = await scope.io.stat(filename);
        const parent = scope.paths.dirname(filename);
        if ((await scope.io.realpath(parent)) !== parent) throw forbidden();
        await scope.io.replace(filename, bytes, stat.mode, async () => {
          await this.assertCurrent(scope, true);
          if (
            (await this.filename(scope, input.path)) !== filename ||
            (await scope.io.realpath(parent)) !== parent
          )
            throw forbidden();
          conflict(await this.document(scope, filename, encoding));
          // The final identity check follows all asynchronous filesystem reads.
          await this.assertCurrent(scope, true);
          // A paired device may have lost its write lease while this save waited.
          await authorize?.();
          this.assertIdentity(scope, true);
        });
        return { ...current, content: input.content, version: hash(bytes) };
      });
    this.writes.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.writes.get(key) === operation) this.writes.delete(key);
    }
  }
}

/** Mount behind local authentication or paired desktop authentication, never publicly. */
export function createEditorRouter(
  service: EditorFiles,
  options: {
    authorize?: (
      request: Request,
      terminalId: string,
      write: boolean,
    ) => Promise<unknown> | unknown;
  } = {},
) {
  const router = Router();
  router.use(json({ limit: "12mb" }));
  const run =
    (
      write: boolean,
      action: (id: string, request: Request) => Promise<unknown>,
    ) =>
    async (request: Request, response: import("express").Response) => {
      try {
        const id = String(request.params.terminalId);
        if (!id || id.length > 128)
          throw new EditorError(
            400,
            "EDITOR_INVALID_TERMINAL",
            "터미널을 선택하세요.",
          );
        await options.authorize?.(request, id, write);
        response.setHeader("Cache-Control", "no-store");
        const result = await action(id, request);
        if (!write) await options.authorize?.(request, id, false);
        response.json(result);
      } catch (error) {
        response.setHeader("Cache-Control", "no-store");
        if (error instanceof EditorError) {
          response.status(error.status).json({
            error: error.message,
            code: error.code,
            ...(error.current ? { current: error.current } : {}),
            ...(error.details ? { details: error.details } : {}),
          });
        } else if (
          ["ENOENT", "ENOTDIR", 2].includes(
            (error as { code?: string | number })?.code || "",
          )
        ) {
          response.status(404).json({
            error: "파일이나 폴더를 찾을 수 없습니다.",
            code: "EDITOR_NOT_FOUND",
          });
        } else if (
          ["EACCES", "EPERM", 3].includes(
            (error as { code?: string | number })?.code || "",
          )
        ) {
          response.status(403).json({
            error: "파일 접근 권한이 없습니다.",
            code: "EDITOR_PERMISSION_DENIED",
          });
        } else {
          response.status(500).json({
            error:
              "파일 작업을 완료하지 못했습니다. 서버 연결과 파일 권한을 확인하세요.",
            code: "EDITOR_IO_ERROR",
          });
        }
      }
    };
  const queryPath = (request: Request, allowEncoding = false) => {
    if (
      Object.keys(request.query).some(
        (key) => key !== "path" && !(allowEncoding && key === "encoding"),
      ) ||
      (request.query.path !== undefined &&
        typeof request.query.path !== "string")
    )
      throw new EditorError(
        400,
        "EDITOR_INVALID_PATH",
        "파일 경로와 지원하는 인코딩만 지정할 수 있습니다.",
      );
    return String(request.query.path || "");
  };
  router.get(
    "/:terminalId/tree",
    run(false, (id, request) => service.list(id, queryPath(request))),
  );
  router.get(
    "/:terminalId/file",
    run(false, (id, request) =>
      service.read(
        id,
        queryPath(request, true),
        encodingOption(request.query.encoding),
      ),
    ),
  );
  router.put(
    "/:terminalId/file",
    run(true, (id, request) => {
      if (
        !request.body ||
        typeof request.body !== "object" ||
        Object.keys(request.body).some(
          (key) =>
            ![
              "path",
              "content",
              "expectedVersion",
              "binding",
              "encoding",
            ].includes(key),
        )
      )
        throw new EditorError(
          400,
          "EDITOR_INVALID_SAVE",
          "파일 경로·내용·원본 버전만 지정할 수 있습니다.",
        );
      return service.save(id, request.body, () =>
        options.authorize?.(request, id, true),
      );
    }),
  );
  return router;
}
