import { getToken } from "./api";

export const TERMINAL_FILE_MIME = "application/x-harbor-file";
export const TERMINAL_TAB_MIME = "application/x-harbor-terminal-tab";
export const TERMINAL_UPLOAD_LIMIT = 512 * 1024 * 1024;
export const TERMINAL_UPLOAD_COUNT = 16;
export interface TerminalUploadTarget {
  terminalId: string;
  hostId: string;
  /** Before prepare: session cwd; after prepare: managed attachment directory. */
  cwd: string;
  attachmentUploadUrl?: string;
}
export interface TerminalUploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export function isTerminalPasteShortcut(event: KeyboardEvent) {
  if (event.altKey) return false;
  const key = event.key.toLowerCase();
  return (
    (key === "v" && event.ctrlKey !== event.metaKey) ||
    (key === "insert" && event.shiftKey && !event.ctrlKey && !event.metaKey)
  );
}

/** Only selection owned by this terminal may enter its local clipboard flow. */
export function terminalSelectedText(
  mount: HTMLElement,
  terminalSelection: string,
) {
  const selection = mount.ownerDocument.getSelection();
  if (
    selection &&
    !selection.isCollapsed &&
    selection.anchorNode &&
    selection.focusNode &&
    mount.contains(selection.anchorNode) &&
    mount.contains(selection.focusNode)
  )
    return selection.toString();
  return terminalSelection;
}

export function terminalClipboardImages(transfer: DataTransfer | null) {
  const files = Array.from(transfer?.files || []).filter((file) =>
    file.type.startsWith("image/"),
  );
  if (files.length) return files;
  // Some native clipboard providers expose images only through their items.
  return Array.from(transfer?.items || []).flatMap((item) => {
    if (item.kind !== "file" || !item.type.startsWith("image/")) return [];
    const file = item.getAsFile();
    return file ? [file] : [];
  });
}

export function validTerminalPath(path: string) {
  if (
    !path ||
    /[\x00-\x1f\x7f]/.test(path) ||
    !/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(path)
  )
    throw new Error("터미널에 입력할 수 없는 파일 경로입니다.");
  return path;
}
export function quoteTerminalImagePath(path: string) {
  validTerminalPath(path);
  return /^[a-z]:[\\/]|^\\\\/i.test(path)
    ? `'${path.replaceAll("'", "''")}'`
    : `'${path.replaceAll("'", "'\\''")}'`;
}
export function terminalPathForPaste(path: string, nativeImage: boolean) {
  validTerminalPath(path);
  if (nativeImage) {
    // A quoted, encoded file URI is recognized by native Codex on both platforms
    // and remains a literal string if the CLI exits before this paste arrives.
    const encode = (segment: string) =>
      encodeURIComponent(segment).replaceAll("'", "%27");
    let uri: string;
    if (/^[a-z]:[\\/]/i.test(path)) {
      const normalized = path.replaceAll("\\", "/");
      uri = `file:///${normalized.slice(0, 2)}${normalized.slice(2).split("/").map(encode).join("/")}`;
    } else if (path.startsWith("\\\\")) {
      const [host, ...parts] = path.slice(2).split("\\");
      if (!/^[a-z0-9._-]+$/i.test(host))
        throw new Error("네트워크 파일 경로의 서버 이름을 확인하세요.");
      uri = `file://${host}/${parts.map(encode).join("/")}`;
    } else uri = `file://${path.split("/").map(encode).join("/")}`;
    return `'${uri}'`;
  }
  return quoteTerminalImagePath(path);
}

export function terminalImageFile(name: string) {
  return /\.(?:png|jpe?g|webp|gif|bmp|avif|tiff?|ico)$/i.test(name);
}

export function isTerminalFileDrag(transfer: DataTransfer | null) {
  if (!transfer || transfer.types.includes(TERMINAL_TAB_MIME)) return false;
  return (
    transfer.types.includes("Files") ||
    transfer.types.includes(TERMINAL_FILE_MIME)
  );
}
let navigationGuards = 0;
const preventFileNavigation = (event: DragEvent) => {
  if (isTerminalFileDrag(event.dataTransfer)) event.preventDefault();
};
export function protectTerminalFileNavigation() {
  if (++navigationGuards === 1) {
    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
  }
  return () => {
    if (--navigationGuards === 0) {
      window.removeEventListener("dragover", preventFileNavigation);
      window.removeEventListener("drop", preventFileNavigation);
    }
  };
}

export function droppedTerminalFiles(transfer: DataTransfer) {
  const items = Array.from(transfer.items || []);
  if (
    items.some(
      (item) => item.kind === "file" && item.webkitGetAsEntry?.()?.isDirectory,
    )
  )
    throw new Error(
      "폴더는 아직 올릴 수 없습니다. 폴더 안의 파일을 선택하거나 ZIP으로 묶어 주세요.",
    );
  const files = Array.from(transfer.files || []);
  if (!files.length)
    throw new Error(
      "드래그한 파일을 읽지 못했습니다. 파일 선택 버튼으로 다시 올려 주세요.",
    );
  return files;
}

export function droppedTerminalPath(transfer: DataTransfer, hostId: string) {
  const raw = transfer.getData(TERMINAL_FILE_MIME);
  if (!raw || raw.length > 12000)
    throw new Error("파일 드래그 정보를 확인하지 못했습니다.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("파일 드래그 정보를 확인하지 못했습니다.");
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("hostId" in value) ||
    !("path" in value) ||
    !("kind" in value)
  )
    throw new Error("파일 드래그 정보를 확인하지 못했습니다.");
  if (value.kind !== "file") throw new Error("폴더 대신 파일을 선택해 주세요.");
  if (value.hostId !== hostId)
    throw new Error(
      "다른 서버의 파일입니다. 로컬로 다운로드한 뒤 이 터미널에 올려 주세요.",
    );
  if (typeof value.path !== "string")
    throw new Error("파일 경로를 확인하지 못했습니다.");
  return validTerminalPath(value.path);
}

/** Retain recognizable names, avoid collisions, and fit Linux's 255-byte name limit. */
export function terminalUploadName(original: string) {
  let clean = (original.split(/[\\/]/).at(-1) || "file")
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "-")
    .replace(/[ .]+$/, "");
  if (!clean || clean === "." || clean === "..") clean = "file";
  const dot = clean.lastIndexOf(".");
  let extension = dot > 0 && clean.length - dot <= 25 ? clean.slice(dot) : "";
  let base = extension ? clean.slice(0, dot) : clean;
  const encoder = new TextEncoder();
  const truncate = (text: string, bytes: number) => {
    const chars = Array.from(text);
    while (encoder.encode(chars.join("")).length > bytes) chars.pop();
    return chars.join("");
  };
  extension = truncate(extension, 40);
  base = truncate(base, 170) || "file";
  return `${base}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${extension}`;
}

export async function resolveTerminalUploadTarget(
  target: TerminalUploadTarget,
  signal: AbortSignal,
) {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(target.terminalId))
    throw new Error("첨부파일을 올릴 터미널을 확인하세요.");
  const headers = { "X-Harbor-Token": getToken() };
  const endpoint = `/api/terminals/${encodeURIComponent(target.terminalId)}/attachments`;
  const response = await fetch(`${endpoint}/prepare`, {
    method: "POST",
    headers,
    signal,
  });
  // An old running backend may return either JSON or an HTML 404. Check its
  // status before parsing; no terminal command is needed for compatibility.
  if (response.status !== 404) {
    const result = await response.json().catch(() => ({}));
    if (
      !response.ok ||
      typeof result.path !== "string" ||
      result.hostId !== target.hostId
    )
      throw new Error(result.error || "첨부 저장 폴더를 준비하지 못했습니다.");
    return {
      ...target,
      cwd: validTerminalPath(result.path),
      attachmentUploadUrl: endpoint,
    };
  }
  const root = `/api/hosts/${encodeURIComponent(target.hostId)}/files`;
  const request = async (url: string, body?: unknown) => {
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: {
        ...headers,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      signal,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(value.error || "첨부 저장 폴더를 준비하지 못했습니다.");
    return value;
  };
  const home = await request(
    `${root}/preview?${new URLSearchParams({ path: "~/", cwd: target.cwd })}`,
  );
  if (home.kind !== "directory")
    throw new Error("서버의 홈 폴더를 확인하지 못했습니다.");
  let directory = validTerminalPath(home.path);
  for (const name of [".codex", "harbor", "attachments", target.terminalId]) {
    const listing = await request(
      `${root}?${new URLSearchParams({ path: directory })}`,
    );
    let entry = listing.entries?.find(
      (item: { name: string }) => item.name === name,
    );
    if (!entry) {
      try {
        await request(`${root}/mkdir`, { path: directory, name });
      } catch (error) {
        if (signal.aborted) throw error;
        const concurrent = await request(
          `${root}?${new URLSearchParams({ path: directory })}`,
        );
        entry = concurrent.entries?.find(
          (item: { name: string }) => item.name === name,
        );
        if (!entry) throw error;
      }
    }
    if (
      entry &&
      entry.kind !== "directory" &&
      !(name === ".codex" && entry.kind === "symlink")
    )
      throw new Error("첨부 저장 폴더에 일반 폴더가 아닌 항목이 있습니다.");
    const separator = /^[a-z]:|^\\\\/i.test(directory) ? "\\" : "/";
    directory = `${directory.replace(/[\\/]+$/, "")}${separator}${name}`;
    // Resolve an intentional ~/.codex symlink once, then keep Harbor children
    // inside that actual directory. Never follow symlinks in owned children.
    if (name === ".codex")
      directory = validTerminalPath(
        (await request(`${root}?${new URLSearchParams({ path: directory })}`))
          .path,
      );
  }
  return { ...target, cwd: directory };
}

export function uploadTerminalFile(
  file: File,
  target: TerminalUploadTarget,
  signal: AbortSignal,
  onProgress?: (value: TerminalUploadProgress) => void,
): Promise<string> {
  if (file.size > TERMINAL_UPLOAD_LIMIT)
    return Promise.reject(new Error("파일은 개당 512MB까지 올릴 수 있습니다."));
  if (signal.aborted)
    return Promise.reject(new DOMException("업로드 취소", "AbortError"));
  const name = terminalUploadName(file.name);
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const finish = () => signal.removeEventListener("abort", abort);
    request.open(
      "PUT",
      target.attachmentUploadUrl
        ? `${target.attachmentUploadUrl}?${new URLSearchParams({ name })}`
        : `/api/hosts/${encodeURIComponent(target.hostId)}/files/upload?${new URLSearchParams({ path: target.cwd, name })}`,
    );
    request.setRequestHeader("X-Harbor-Token", getToken());
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.upload.onprogress = (event) =>
      onProgress?.({
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : file.size,
        percent: Math.min(
          100,
          Math.round(
            (event.loaded /
              Math.max(1, event.lengthComputable ? event.total : file.size)) *
              100,
          ),
        ),
      });
    request.onload = () => {
      finish();
      let value: { error?: string; path?: string };
      try {
        value = JSON.parse(request.responseText);
      } catch {
        reject(new Error("서버의 업로드 응답을 읽지 못했습니다."));
        return;
      }
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(value.error || "파일을 올리지 못했습니다."));
        return;
      }
      try {
        resolve(validTerminalPath(value.path || ""));
      } catch (error) {
        reject(error);
      }
    };
    request.onerror = () => {
      finish();
      reject(new Error("파일 업로드 중 연결이 끊겼습니다."));
    };
    request.onabort = () => {
      finish();
      reject(new DOMException("업로드 취소", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    request.send(file);
  });
}

export async function uploadTerminalImage(
  file: File,
  target: TerminalUploadTarget,
  signal: AbortSignal,
) {
  if (
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)
  )
    throw new Error("PNG, JPEG, WebP, GIF 이미지를 선택하세요.");
  if (!file.size || file.size > 20 * 1024 * 1024)
    throw new Error("이미지는 파일당 20MB까지 올릴 수 있습니다.");
  return uploadTerminalFile(
    file,
    await resolveTerminalUploadTarget(target, signal),
    signal,
  );
}
