import type { FileEntry } from "../../shared/types";

export type IdeEncoding = "utf-8" | "utf-16le" | "utf-16be" | "cp949";
export interface IdeFileDetails {
  terminalId: string;
  hostId: string;
  root: string;
  path: string;
  size: number;
  preview: "image" | "pdf" | "html" | "download";
  encodings?: IdeEncoding[];
}
export interface IdeFile {
  terminalId: string;
  hostId: string;
  root: string;
  cwd?: string;
  path: string;
  content: string;
  version: string;
  binding: string;
  encoding?: IdeEncoding;
  bom?: boolean;
}
export interface IdeTree {
  terminalId: string;
  hostId: string;
  root: string;
  cwd?: string;
  path: string;
  parent: string | null;
  binding: string;
  entries: FileEntry[];
  truncated: boolean;
}
export interface IdeApi {
  tree(terminalId: string, path?: string): Promise<IdeTree>;
  read(
    terminalId: string,
    path: string,
    encoding?: IdeEncoding,
  ): Promise<IdeFile>;
  save(file: IdeFile, content: string): Promise<IdeFile>;
}
export interface IdeSelection {
  terminalId: string;
  hostId: string;
  path: string;
  root: string;
  text: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  unsaved: boolean;
}
export class IdeApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly current?: IdeFile,
    readonly details?: IdeFileDetails,
  ) {
    super(message);
  }
}

/** Authentication is owned by the caller: local token or paired desktop cookie. */
export function createIdeApi(
  request: (path: string, init: RequestInit) => Promise<Response>,
  base = "/api/editor",
): IdeApi {
  async function call<T>(
    terminalId: string,
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await request(
      `${base}/${encodeURIComponent(terminalId)}${path}`,
      init,
    );
    const body = await response.json();
    if (!response.ok)
      throw new IdeApiError(
        body.error || `파일 요청 실패 (${response.status})`,
        body.code,
        body.current,
        body.details,
      );
    return body;
  }
  return {
    tree: (id, path) =>
      call(id, `/tree${path ? `?${new URLSearchParams({ path })}` : ""}`),
    read: (id, path, encoding) =>
      call(
        id,
        `/file?${new URLSearchParams({ path, ...(encoding ? { encoding } : {}) })}`,
      ),
    save: (file, content) =>
      call(file.terminalId, "/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: file.path,
          content,
          expectedVersion: file.version,
          binding: file.binding,
          encoding: file.encoding,
        }),
      }),
  };
}
