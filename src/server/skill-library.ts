import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { SFTPWrapper, Stats } from "ssh2";
import { Router } from "express";
import { z } from "zod";
import source from "./skill-source.json";
import {
  SKILL_CATALOG,
  SKILL_SOURCE,
  type SkillProvider,
  type SkillLibraryStatus,
  type SkillInstallResult,
} from "../shared/skill-catalog.js";
import type { HostConfig } from "../shared/types.js";
import type { Files } from "./files.js";

type SkillFile = { path: string; mode: string; sha: string; size: number };
export type SkillPayload = {
  path: string;
  bytes: Buffer;
  executable: boolean;
}[];
type FileStat = Pick<
  Stats,
  "size" | "isDirectory" | "isFile" | "isSymbolicLink"
>;
export interface SkillTransport {
  paths: typeof path;
  stat(filename: string): Promise<FileStat | undefined>;
  mkdir(directory: string): Promise<void>;
  read(filename: string): Promise<Buffer>;
  write(filename: string, bytes: Buffer, executable: boolean): Promise<void>;
  publish(temporary: string, filename: string): Promise<void>;
  unlink(filename: string): Promise<void>;
  rmdir(directory: string): Promise<void>;
}
const call = <T>(
  fn: (cb: (error: Error | null | undefined, result: T) => void) => void,
) =>
  new Promise<T>((resolve, reject) =>
    fn((e, value) => (e ? reject(e) : resolve(value))),
  );
const missing = (e: unknown) =>
  ["ENOENT", 2].includes((e as { code?: string | number }).code ?? "");
const MAX_FILE = 8 * 1024 * 1024;
const MARKER = ".harbor-skill.json";

export function skillTransport(sftp?: SFTPWrapper): SkillTransport {
  return {
    paths: sftp ? path.posix : path,
    async stat(name) {
      try {
        return sftp
          ? await call<Stats>((cb) => sftp.lstat(name, cb))
          : await fs.lstat(name);
      } catch (e) {
        if (missing(e)) return undefined;
        throw e;
      }
    },
    async mkdir(name) {
      if (sftp) await call<void>((cb) => sftp.mkdir(name, { mode: 0o700 }, cb));
      else await fs.mkdir(name, { mode: 0o700 });
    },
    async read(name) {
      const stat = await this.stat(name);
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 8192)
        throw new Error("스킬 설치 기록을 읽을 수 없습니다.");
      if (!sftp) {
        const handle = await fs.open(name, "r");
        try {
          const b = Buffer.alloc(8193);
          const { bytesRead } = await handle.read(b);
          if (bytesRead > 8192) throw new Error("설치 기록 크기 초과");
          return b.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }
      }
      const stream = sftp.createReadStream(name, { start: 0, end: 8192 });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > 8192) {
          stream.destroy();
          throw new Error("설치 기록 크기 초과");
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },
    async write(name, bytes, executable) {
      const mode = executable ? 0o700 : 0o600;
      if (!sftp) {
        const handle = await fs.open(name, "wx", mode);
        try {
          await handle.writeFile(bytes);
        } catch (e) {
          await handle.close().catch(() => {});
          await fs.unlink(name).catch(() => {});
          throw e;
        }
        await handle.close();
        return;
      }
      const handle = await call<Buffer>((cb) =>
        sftp.open(name, "wx", mode, cb),
      );
      try {
        for (let offset = 0; offset < bytes.length; offset += 65536) {
          const length = Math.min(65536, bytes.length - offset);
          await call<void>((cb) =>
            sftp.write(handle, bytes, offset, length, offset, (e) =>
              cb(e, undefined),
            ),
          );
        }
        await call<void>((cb) => sftp.close(handle, cb));
      } catch (e) {
        await call<void>((cb) => sftp.close(handle, cb)).catch(() => {});
        await call<void>((cb) => sftp.unlink(name, cb)).catch(() => {});
        throw e;
      }
    },
    async publish(temporary, name) {
      // SFTP v3 rename fails if the destination exists (do not use posix-rename).
      if (sftp) await call<void>((cb) => sftp.rename(temporary, name, cb));
      else {
        await fs.link(temporary, name);
        await fs.unlink(temporary).catch(() => {});
      }
    },
    async unlink(name) {
      if (sftp) await call<void>((cb) => sftp.unlink(name, cb));
      else await fs.unlink(name);
    },
    async rmdir(name) {
      if (sftp) await call<void>((cb) => sftp.rmdir(name, cb));
      else await fs.rmdir(name);
    },
  };
}

export function validateSkillFiles(
  id: string,
  entries: SkillFile[],
): SkillFile[] {
  if (!SKILL_CATALOG.some((s) => s.id === id))
    throw new Error("목록에 없는 스킬입니다.");
  const files = entries.filter((f) => f.path.startsWith(`skills/${id}/`));
  if (
    !files.length ||
    files.length > 512 ||
    files.reduce((n, f) => n + f.size, 0) > 32 * 1024 * 1024
  )
    throw new Error("스킬 파일 수 또는 크기가 허용 범위를 넘었습니다.");
  const seen = new Set<string>();
  for (const file of files) {
    const relative = file.path.slice(`skills/${id}/`.length);
    const parts = relative.split("/");
    if (
      parts.some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          /[\x00-\x1f\\:*?"<>|]/.test(p) ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      ) ||
      relative === MARKER ||
      relative.startsWith(".harbor-origin/")
    )
      throw new Error("안전하지 않은 스킬 파일 경로입니다.");
    if (seen.has(relative.toLowerCase()))
      throw new Error("중복된 스킬 파일 경로입니다.");
    seen.add(relative.toLowerCase());
    if (
      !["100644", "100755"].includes(file.mode) ||
      !/^[a-f0-9]{40}$/.test(file.sha) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_FILE
    )
      throw new Error("지원하지 않는 스킬 파일 형식입니다.");
  }
  if (!files.some((f) => f.path === `skills/${id}/SKILL.md`))
    throw new Error("SKILL.md가 없는 스킬입니다.");
  return files;
}

async function fetchFile(file: SkillFile, fetcher: typeof fetch) {
  const url = `https://raw.githubusercontent.com/${SKILL_SOURCE.repository}/${SKILL_SOURCE.commit}/${file.path.split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetcher(url, {
    redirect: "error",
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      `GitHub 다운로드 실패 (${response.status}). 잠시 후 다시 시도하세요.`,
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > file.size || size > MAX_FILE)
        throw new Error("다운로드 크기가 원본과 다릅니다.");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = Buffer.concat(chunks);
  const hash = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  if (bytes.length !== file.size || hash !== file.sha)
    throw new Error("다운로드한 스킬이 확인된 원본과 일치하지 않습니다.");
  return bytes;
}

export async function downloadSkill(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<SkillPayload> {
  if (
    source.commit !== SKILL_SOURCE.commit ||
    source.repository !== SKILL_SOURCE.repository
  )
    throw new Error("스킬 목록 버전이 일치하지 않습니다.");
  const files = validateSkillFiles(id, source.files);
  const notice = source.files.find((f) => f.path === "THIRD_PARTY_NOTICES.md")!;
  const selected = [...files, notice];
  const payload: SkillPayload = [];
  // Six bounded requests, with all rejections observed before returning.
  for (let offset = 0; offset < selected.length; offset += 6) {
    const results = await Promise.allSettled(
      selected.slice(offset, offset + 6).map(async (file) => ({
        path:
          file === notice
            ? ".harbor-origin/THIRD_PARTY_NOTICES.md"
            : file.path.slice(`skills/${id}/`.length),
        bytes: await fetchFile(file, fetcher),
        executable: file.mode === "100755",
      })),
    );
    const failed = results.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    for (const r of results)
      if (r.status === "fulfilled") payload.push(r.value);
  }
  return payload;
}

/** Check every existing ancestor. A status read never creates directories. */
async function directory(
  io: SkillTransport,
  name: string,
  create: boolean,
): Promise<boolean> {
  const parent = io.paths.dirname(name);
  if (parent !== name && !(await directory(io, parent, create))) return false;
  let stat = await io.stat(name);
  if (!stat && create) {
    try {
      await io.mkdir(name);
    } catch (e) {
      if (!(await io.stat(name))) throw e;
    }
    stat = await io.stat(name);
  }
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(
      "스킬 저장 경로에 링크 또는 일반 파일이 있습니다. 실제 폴더 경로를 사용하세요.",
    );
  return true;
}

export async function installSkill(
  io: SkillTransport,
  root: string,
  id: string,
  payload: SkillPayload,
): Promise<"installed" | "existing"> {
  if (!SKILL_CATALOG.some((s) => s.id === id) || !io.paths.isAbsolute(root))
    throw new Error("올바르지 않은 설치 경로입니다.");
  const destination = io.paths.join(root, id);
  await directory(io, root, true);
  // mkdir is the exclusive claim, including across Harbor processes. Never replace a directory.
  try {
    await io.mkdir(destination);
  } catch (e) {
    if (await io.stat(destination)) return "existing";
    throw e;
  }
  const written: string[] = [],
    directories = [destination];
  try {
    const files = [
      ...payload.filter((f) => f.path !== "SKILL.md"),
      {
        path: MARKER,
        bytes: Buffer.from(
          JSON.stringify({
            source: SKILL_SOURCE.repository,
            commit: SKILL_SOURCE.commit,
            id,
          }),
        ),
        executable: false,
      },
      ...payload.filter((f) => f.path === "SKILL.md"),
    ];
    if (files.filter((f) => f.path === "SKILL.md").length !== 1)
      throw new Error("SKILL.md가 없는 스킬입니다.");
    for (const file of files) {
      const parts = file.path.split("/");
      if (
        parts.some(
          (p) =>
            !p || p === "." || p === ".." || /[\x00-\x1f\\:*?"<>|]/.test(p),
        )
      )
        throw new Error("안전하지 않은 스킬 파일 경로입니다.");
      let folder = destination;
      for (const part of parts.slice(0, -1)) {
        folder = io.paths.join(folder, part);
        if (!directories.includes(folder)) {
          await io.mkdir(folder);
          directories.push(folder);
        }
      }
      // No skill is discoverable until every resource is present and SKILL.md is written last.
      await directory(io, folder, false);
      const filename = io.paths.join(
        destination,
        ...(file.path === "SKILL.md" ? [".harbor-SKILL.pending"] : parts),
      );
      await io.write(filename, file.bytes, file.executable);
      written.push(filename);
      if (file.path === "SKILL.md") {
        await io.publish(filename, io.paths.join(destination, "SKILL.md"));
        written[written.length - 1] = io.paths.join(destination, "SKILL.md");
      }
    }
    return "installed";
  } catch (e) {
    // Only exact files inside the directory claimed by this request; never recursive deletion.
    // Concurrently added user files keep their containing directories from being removed.
    for (const name of written.reverse()) {
      const relative = io.paths.relative(destination, name);
      if (
        relative &&
        !relative.startsWith("..") &&
        !io.paths.isAbsolute(relative) &&
        (await directory(io, io.paths.dirname(name), false).catch(() => false))
      )
        await io.unlink(name).catch(() => {});
    }
    for (const name of directories.reverse())
      await io.rmdir(name).catch(() => {});
    throw e;
  }
}

interface Options {
  files: Pick<Files, "skillLocations" | "editorSftp">;
  download?: typeof downloadSkill;
  transport?: (host: HostConfig) => Promise<SkillTransport>;
}
export class SkillLibrary {
  private busy = new Set<string>();
  constructor(private options: Options) {}
  private async scope(host: HostConfig) {
    const locations = await this.options.files.skillLocations(host);
    const io = this.options.transport
      ? await this.options.transport(host)
      : skillTransport(
          host.kind === "ssh"
            ? await this.options.files.editorSftp(host)
            : undefined,
        );
    if (
      ![locations.home, locations.claudeConfig].every(
        (p) => io.paths.isAbsolute(p) && !/[\0\r\n]/.test(p),
      )
    )
      throw new Error("스킬 저장 위치는 절대 경로여야 합니다.");
    return {
      io,
      roots: {
        claude: io.paths.join(locations.claudeConfig, "skills"),
        codex: io.paths.join(locations.home, ".agents", "skills"),
      },
    };
  }
  async status(host: HostConfig): Promise<SkillLibraryStatus> {
    const { io, roots } = await this.scope(host);
    const skills: SkillLibraryStatus["skills"] = Object.fromEntries(
      SKILL_CATALOG.map((s) => [
        s.id,
        { claude: "available", codex: "available" },
      ]),
    );
    const errors: SkillLibraryStatus["errors"] = {};
    for (const provider of ["claude", "codex"] as const) {
      try {
        if (!(await directory(io, roots[provider], false))) continue;
        for (const skill of SKILL_CATALOG) {
          const folder = io.paths.join(roots[provider], skill.id),
            stat = await io.stat(folder);
          if (!stat) continue;
          skills[skill.id][provider] = "existing";
          if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
          try {
            const marker = JSON.parse(
              (await io.read(io.paths.join(folder, MARKER))).toString(),
            );
            const entry = await io.stat(io.paths.join(folder, "SKILL.md"));
            if (
              marker.source === SKILL_SOURCE.repository &&
              marker.commit === SKILL_SOURCE.commit &&
              marker.id === skill.id &&
              entry?.isFile() &&
              !entry.isSymbolicLink()
            )
              skills[skill.id][provider] = "installed";
          } catch {
            /* Existing user skills remain untouched, including malformed markers. */
          }
        }
      } catch (e) {
        errors[provider] = (e as Error).message;
        for (const skill of SKILL_CATALOG)
          skills[skill.id][provider] = "unavailable";
      }
    }
    return { roots, skills, ...(Object.keys(errors).length ? { errors } : {}) };
  }
  async install(
    host: HostConfig,
    ids: string[],
    providers: SkillProvider[],
  ): Promise<SkillInstallResult[]> {
    if (this.busy.has(host.id))
      throw new Error(
        "이 서버에 스킬을 설치하고 있습니다. 완료 후 다시 시도하세요.",
      );
    this.busy.add(host.id);
    try {
      const { io, roots } = await this.scope(host);
      const results: SkillInstallResult[] = [];
      for (const id of [...new Set(ids)]) {
        let payload: SkillPayload | undefined, downloadError: Error | undefined;
        for (const provider of [...new Set(providers)]) {
          try {
            if (
              !SKILL_CATALOG.some((s) => s.id === id) ||
              !["claude", "codex"].includes(provider)
            )
              throw new Error("올바르지 않은 스킬 선택입니다.");
            await directory(io, roots[provider], false);
            if (await io.stat(io.paths.join(roots[provider], id))) {
              results.push({ id, provider, state: "existing" });
              continue;
            }
            if (downloadError) throw downloadError;
            if (!payload) {
              try {
                payload = await (this.options.download || downloadSkill)(id);
              } catch (e) {
                downloadError = e as Error;
                throw e;
              }
            }
            results.push({
              id,
              provider,
              state: await installSkill(io, roots[provider], id, payload),
            });
          } catch (e) {
            results.push({
              id,
              provider,
              state: "error",
              message: (e as Error).message,
            });
          }
        }
      }
      return results;
    } finally {
      this.busy.delete(host.id);
    }
  }
}

export function createSkillRouter(
  library: SkillLibrary,
  host: (id: string) => HostConfig,
  prepare: (id: string) => Promise<unknown>,
) {
  const router = Router();
  const input = z
    .object({
      ids: z
        .array(
          z.string().refine((id) => SKILL_CATALOG.some((s) => s.id === id)),
        )
        .min(1)
        .max(SKILL_CATALOG.length),
      providers: z
        .array(z.enum(["claude", "codex"]))
        .min(1)
        .max(2),
    })
    .strict();
  router.get("/:id/skills", async (req, res) => {
    const selected = host(String(req.params.id));
    await prepare(selected.id);
    res.json(await library.status(selected));
  });
  router.post("/:id/skills/install", async (req, res) => {
    const selection = input.parse(req.body),
      selected = host(String(req.params.id));
    await prepare(selected.id);
    res.json({
      results: await library.install(
        selected,
        selection.ids,
        selection.providers,
      ),
    });
  });
  return router;
}
