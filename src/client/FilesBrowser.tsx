import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  File,
  FileCode2,
  FileImage,
  Folder,
  FolderPlus,
  Globe2,
  HardDrive,
  Link,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  Search,
  Terminal,
  Upload,
  X,
} from "lucide-react";
import type { DirectoryView, FileEntry, HostView } from "../shared/types";
import { api, getToken } from "./api";
import { Modal } from "./Dialogs";
import { usePreview } from "./ResourcePreview";

interface UploadItem {
  id: string;
  name: string;
  size: number;
  percent: number;
  status: "queued" | "uploading" | "done" | "error" | "cancelled";
  error?: string;
}
function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}
function FileIcon({ entry }: { entry: FileEntry }) {
  return entry.kind === "directory" ? (
    <Folder size={19} className="folder-icon" />
  ) : entry.kind === "symlink" ? (
    <Link size={18} />
  ) : /\.(png|jpe?g|webp|gif|svg)$/i.test(entry.name) ? (
    <FileImage size={18} />
  ) : /\.(tsx?|jsx?|py|rs|go|json|md|ya?ml|sh|css|html|toml)$/i.test(
      entry.name,
    ) ? (
    <FileCode2 size={18} />
  ) : (
    <File size={18} />
  );
}
function remembered(host: HostView | undefined) {
  if (!host) return "";
  try {
    return localStorage.getItem(`harbor.files.${host.id}`) || host.defaultCwd;
  } catch {
    return host.defaultCwd;
  }
}

export default function FilesBrowser({
  hosts,
  initialHostId,
  initialPath,
  onTerminal,
  onConnect,
}: {
  hosts: HostView[];
  initialHostId?: string;
  initialPath?: string;
  onTerminal: (host: HostView, path: string) => void;
  onConnect: (host: HostView) => void;
}) {
  const openPreview = usePreview();
  const [hostId, setHostId] = useState(
    initialHostId || hosts[0]?.id || "local",
  );
  const host = hosts.find((h) => h.id === hostId)!;
  const [address, setAddress] = useState(initialPath || remembered(host));
  const [directory, setDirectory] = useState<DirectoryView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState("");
  const [menu, setMenu] = useState<{
    entry: FileEntry;
    x: number;
    y: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [uploadTarget, setUploadTarget] = useState("");
  const [uploading, setUploading] = useState(false);
  const xhr = useRef<XMLHttpRequest | null>(null);
  const cancelled = useRef(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const location = useRef({ hostId, path: directory?.path });
  location.current = { hostId, path: directory?.path };
  const [folder, setFolder] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState("");
  const [copied, setCopied] = useState(false);
  async function load(path: string, targetHost = hostId) {
    const gen = ++generation.current;
    setBusy(true);
    setError("");
    setMenu(null);
    setSelected("");
    try {
      const result = await api<DirectoryView>(
        `/hosts/${targetHost}/files?${new URLSearchParams({ path })}`,
        undefined,
        "GET",
      );
      if (generation.current !== gen || !mounted.current) return;
      setDirectory(result);
      setAddress(result.path);
      localStorage.setItem(`harbor.files.${targetHost}`, result.path);
    } catch (e) {
      if (generation.current === gen && mounted.current)
        setError((e as Error).message);
    } finally {
      if (generation.current === gen && mounted.current) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    const id = initialHostId || hosts[0]?.id || "local";
    setHostId(id);
    setDirectory(null);
    void load(initialPath || remembered(hosts.find((h) => h.id === id)), id);
    return () => {
      generation.current++;
    };
  }, [initialHostId, initialPath]);
  useEffect(
    () => () => {
      mounted.current = false;
      cancelled.current = true;
      xhr.current?.abort();
    },
    [],
  );
  useEffect(() => {
    const close = (e: Event) => {
      if (!(e.target as Element)?.closest(".file-context-menu")) setMenu(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", key);
    };
  }, []);
  useEffect(() => {
    if (!uploading) return;
    const beforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [uploading]);
  function chooseHost(id: string) {
    if (uploading) return;
    setHostId(id);
    setDirectory(null);
    setQuery("");
    const path = remembered(hosts.find((h) => h.id === id));
    setAddress(path);
    void load(path, id);
  }
  function download(entry: FileEntry) {
    const link = document.createElement("a");
    link.href = `/api/hosts/${hostId}/files/download?${new URLSearchParams({ path: entry.path, token: getToken() })}`;
    link.download = entry.name;
    link.rel = "noreferrer";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setMenu(null);
  }
  function updateUpload(id: string, value: Partial<UploadItem>) {
    if (mounted.current)
      setUploads((prev) =>
        prev.map((item) => (item.id === id ? { ...item, ...value } : item)),
      );
  }
  async function upload(files: File[]) {
    if (inFlight.current || !directory || !files.length) return;
    const target = { hostId, path: directory.path, name: host.name };
    const queue = files.map((file) => ({ id: crypto.randomUUID(), file }));
    if (files.some((f) => f.size > 512 * 1024 * 1024)) {
      setError("파일은 개당 512MB까지 업로드할 수 있습니다.");
      return;
    }
    inFlight.current = true;
    cancelled.current = false;
    setUploading(true);
    setError("");
    setUploadTarget(`${target.name} · ${target.path}`);
    setUploads(
      queue.map(({ id, file }) => ({
        id,
        name: file.name,
        size: file.size,
        percent: 0,
        status: "queued",
      })),
    );
    for (const { id, file } of queue) {
      if (cancelled.current) {
        updateUpload(id, { status: "cancelled" });
        continue;
      }
      updateUpload(id, { status: "uploading" });
      try {
        await new Promise<void>((resolve, reject) => {
          const request = new XMLHttpRequest();
          xhr.current = request;
          request.open(
            "PUT",
            `/api/hosts/${target.hostId}/files/upload?${new URLSearchParams({ path: target.path, name: file.name })}`,
          );
          request.setRequestHeader("X-Harbor-Token", getToken());
          request.setRequestHeader("Content-Type", "application/octet-stream");
          request.upload.onprogress = (e) => {
            if (e.lengthComputable)
              updateUpload(id, {
                percent: Math.round((e.loaded / e.total) * 100),
              });
          };
          request.onload = () => {
            if (request.status >= 200 && request.status < 300) resolve();
            else {
              let message = "업로드에 실패했습니다.";
              try {
                message = JSON.parse(request.responseText).error || message;
              } catch {}
              reject(new Error(message));
            }
          };
          request.onerror = () =>
            reject(new Error("연결이 끊겼습니다. 서버 연결을 확인하세요."));
          request.onabort = () => reject(new Error("업로드를 취소했습니다."));
          request.send(file);
        });
        updateUpload(id, { status: "done", percent: 100 });
      } catch (e) {
        updateUpload(id, {
          status: cancelled.current ? "cancelled" : "error",
          error: (e as Error).message,
        });
      }
    }
    xhr.current = null;
    inFlight.current = false;
    if (mounted.current) {
      setUploading(false);
      if (
        location.current.hostId === target.hostId &&
        location.current.path === target.path
      )
        void load(target.path, target.hostId);
    }
  }
  const entries = (directory?.entries || [])
    .filter(
      (e) =>
        (hidden || !e.name.startsWith(".")) &&
        e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(b.kind === "directory") - Number(a.kind === "directory") ||
        a.name.localeCompare(b.name, "ko", { numeric: true }),
    );
  const selectedEntry = entries.find((e) => e.path === selected);
  return (
    <div className="files-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">FROM HERE TO THERE</div>
          <h1>파일 탐색</h1>
          <p>서버의 파일을 살펴보고, 내 컴퓨터와 주고받으세요.</p>
        </div>
        <div className="file-heading-actions">
          <button
            className="button secondary small"
            disabled={!directory || busy || uploading}
            onClick={() => {
              setFolder("");
              setFolderError("");
            }}
          >
            <FolderPlus size={15} />새 폴더
          </button>
          <button
            className="button primary small"
            disabled={!directory || uploading || busy}
            onClick={() => input.current?.click()}
          >
            <Upload size={15} />
            파일 업로드
          </button>
          <input
            ref={input}
            data-testid="file-upload-input"
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void upload([...(e.target.files || [])]);
              e.target.value = "";
            }}
          />
        </div>
      </div>
      <div className="file-connection">
        <span className="file-server-icon">
          {host?.kind === "local" ? (
            <HardDrive size={17} />
          ) : (
            <Globe2 size={17} />
          )}
        </span>
        <select
          aria-label="파일 탐색 서버"
          value={hostId}
          disabled={uploading}
          onChange={(e) => chooseHost(e.target.value)}
        >
          {hosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
              {h.kind === "ssh" ? " · SSH / SFTP" : " · 로컬"}
            </option>
          ))}
        </select>
        <span className="file-transport">
          {host?.kind === "ssh" ? "SFTP" : "LOCAL"}
        </span>
        <span className="file-host-address">
          {host?.kind === "ssh" ? `${host.address}:${host.port}` : "내 컴퓨터"}
        </span>
      </div>
      <div className="file-address">
        <button
          className="icon-button"
          title="상위 폴더"
          aria-label="상위 폴더"
          disabled={!directory || directory.path === directory.parent || busy}
          onClick={() => void load(directory!.parent)}
        >
          <ArrowUp size={17} />
        </button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void load(address);
          }}
        >
          <Folder size={15} />
          <input
            aria-label="파일 경로"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="폴더의 절대 경로"
          />
          <button
            className="icon-button compact"
            title="경로로 이동"
            aria-label="경로로 이동"
          >
            <ChevronRight size={16} />
          </button>
        </form>
        <button
          className="icon-button"
          title="새로고침"
          aria-label="파일 새로고침"
          disabled={busy}
          onClick={() => void load(directory?.path || address)}
        >
          {busy ? (
            <LoaderCircle size={17} className="spin" />
          ) : (
            <RefreshCw size={17} />
          )}
        </button>
        <button
          className="icon-button"
          title="이 폴더에서 터미널"
          aria-label="파일 폴더에서 터미널"
          disabled={!directory}
          onClick={() => onTerminal(host, directory!.path)}
        >
          <Terminal size={17} />
        </button>
      </div>
      <div className="file-tools">
        <div className="file-search">
          <Search size={14} />
          <input
            aria-label="파일 이름 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="이 폴더에서 검색"
          />
        </div>
        <label className="hidden-files">
          <input
            type="checkbox"
            checked={hidden}
            onChange={(e) => setHidden(e.target.checked)}
          />
          숨김 파일
        </label>
        <span>{entries.length}개 항목</span>
      </div>
      {error && (
        <div className="file-error">
          <div className="inline-error" role="alert">
            {error}
          </div>
          {host?.kind === "ssh" && host.status !== "connected" && (
            <button
              className="button secondary small"
              onClick={() => onConnect(host)}
            >
              SSH 연결 설정
            </button>
          )}
          <button
            className="button ghost small"
            onClick={() => void load(address)}
          >
            다시 시도
          </button>
        </div>
      )}
      <div
        className={`file-drop-area ${dragging ? "dragging" : ""}`}
        data-testid="file-drop-area"
        onDragEnter={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          dragDepth.current++;
          setDragging(true);
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            e.dataTransfer.dropEffect =
              uploading || !directory ? "none" : "copy";
          }
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          if (--dragDepth.current <= 0) {
            dragDepth.current = 0;
            setDragging(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          if (
            [...e.dataTransfer.items].some(
              (i) => i.webkitGetAsEntry?.()?.isDirectory,
            )
          ) {
            setError(
              "파일을 선택해서 올려주세요. 폴더를 통째로 올릴 때는 먼저 압축해 주세요.",
            );
            return;
          }
          void upload([...e.dataTransfer.files]);
        }}
      >
        {dragging && (
          <div className="file-drop-overlay">
            <Upload size={34} />
            <b>
              {uploading
                ? "현재 업로드가 끝난 뒤 놓아주세요"
                : `${host?.name}에 파일 업로드`}
            </b>
            <span>{directory?.path || "먼저 업로드할 폴더를 여세요."}</span>
          </div>
        )}
        <div className="file-table" role="table" aria-label="파일 목록">
          <div className="file-table-header" role="row">
            <span role="columnheader">이름</span>
            <span role="columnheader">크기</span>
            <span role="columnheader">수정한 날짜</span>
            <span />
          </div>
          <div className="file-table-body">
            {busy && !directory ? (
              <div className="file-list-empty">
                <LoaderCircle size={24} className="spin" />
                <p>폴더를 열고 있습니다…</p>
              </div>
            ) : !entries.length ? (
              <div className="file-list-empty">
                <Folder size={35} />
                <h3>
                  {query ? "검색 결과가 없습니다" : "파일을 여기에 놓으세요"}
                </h3>
                <p>
                  {query
                    ? "다른 파일 이름으로 검색해 보세요."
                    : "로컬 파일을 끌어다 놓거나 업로드 버튼을 누르세요."}
                </p>
              </div>
            ) : (
              entries.map((entry) => (
                <div
                  key={entry.path}
                  className={`file-row ${selected === entry.path ? "selected" : ""}`}
                  role="row"
                  tabIndex={0}
                  draggable={entry.kind === "file"}
                  onDragStart={(event) => {
                    if (entry.kind !== "file") {
                      event.preventDefault();
                      return;
                    }
                    event.dataTransfer.effectAllowed = "copy";
                    event.dataTransfer.setData(
                      "application/x-harbor-file",
                      JSON.stringify({
                        hostId,
                        path: entry.path,
                        kind: "file",
                      }),
                    );
                    event.dataTransfer.setData("text/plain", entry.path);
                  }}
                  onClick={() => setSelected(entry.path)}
                  onDoubleClick={() =>
                    entry.kind === "directory" || entry.kind === "symlink"
                      ? void load(entry.path)
                      : openPreview(entry.path, {
                          hostId,
                          cwd: directory!.path,
                        })
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      if (entry.kind === "directory") void load(entry.path);
                      else
                        openPreview(entry.path, {
                          hostId,
                          cwd: directory!.path,
                        });
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setSelected(entry.path);
                    setMenu({
                      entry,
                      x: Math.min(e.clientX, innerWidth - 216),
                      y: Math.min(e.clientY, innerHeight - 165),
                    });
                  }}
                >
                  <span role="cell" className="file-name">
                    <FileIcon entry={entry} />
                    <span title={entry.name}>{entry.name}</span>
                    {entry.kind === "directory" && <ChevronRight size={13} />}
                  </span>
                  <span role="cell" className="file-size">
                    {entry.kind === "directory" ? "—" : size(entry.size)}
                  </span>
                  <span role="cell" className="file-date">
                    {new Date(entry.modifiedAt).toLocaleString("ko-KR", {
                      year: "2-digit",
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <button
                    className="icon-button compact"
                    title={`${entry.name} 메뉴`}
                    aria-label={`${entry.name} 메뉴`}
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      setSelected(entry.path);
                      setMenu({
                        entry,
                        x: Math.min(rect.right - 210, innerWidth - 216),
                        y: Math.min(rect.bottom, innerHeight - 165),
                      });
                    }}
                  >
                    <MoreHorizontal size={17} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
        <div className="file-bottom">
          <span>더블클릭으로 미리보기 · 우클릭으로 다운로드</span>
          {selectedEntry && selectedEntry.kind === "file" && (
            <button onClick={() => download(selectedEntry)}>
              <ArrowDownToLine size={14} />
              선택 파일 다운로드
            </button>
          )}
          {directory?.truncated && <span>처음 5,000개 항목 표시</span>}
        </div>
      </div>
      {uploads.length > 0 && (
        <div className="upload-panel">
          <header>
            <span>
              <Upload size={14} />
              <b>{uploading ? "파일을 올리고 있습니다" : "파일 전송 결과"}</b>
              <small>
                {uploads.filter((u) => u.status === "done").length}/
                {uploads.length}
              </small>
            </span>
            {uploading ? (
              <button
                onClick={() => {
                  cancelled.current = true;
                  xhr.current?.abort();
                }}
              >
                취소
              </button>
            ) : (
              <button
                className="icon-button compact"
                aria-label="업로드 결과 닫기"
                onClick={() => setUploads([])}
              >
                <X size={14} />
              </button>
            )}
          </header>
          <div className="upload-destination">{uploadTarget}</div>
          <div className="upload-items">
            {uploads.map((item) => (
              <div key={item.id} className={`upload-item ${item.status}`}>
                <span className="upload-state">
                  {item.status === "done" ? (
                    <CheckCircle2 size={15} />
                  ) : item.status === "uploading" ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : item.status === "error" || item.status === "cancelled" ? (
                    <X size={15} />
                  ) : (
                    <File size={15} />
                  )}
                </span>
                <div>
                  <b>{item.name}</b>
                  {item.error && <p>{item.error}</p>}
                  {item.status === "uploading" && (
                    <div className="upload-progress">
                      <i style={{ width: `${item.percent}%` }} />
                    </div>
                  )}
                </div>
                <span>
                  {item.status === "uploading"
                    ? `${item.percent}%`
                    : item.status === "done"
                      ? size(item.size)
                      : item.status === "queued"
                        ? "대기 중"
                        : item.status === "cancelled"
                          ? "취소됨"
                          : "실패"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="file-help">
        <span>
          <Upload size={13} />
          파일당 최대 512MB · 같은 이름의 파일은 유지됩니다.
        </span>
        <span>
          <ArrowDownToLine size={13} />
          {window.harborDesktop
            ? "저장 창에서 다운로드할 위치를 선택하세요."
            : "다운로드는 브라우저의 저장 설정을 따릅니다."}
        </span>
      </div>
      {menu && (
        <div
          className="file-context-menu"
          role="menu"
          style={{ left: Math.max(6, menu.x), top: Math.max(6, menu.y) }}
        >
          <div className="context-filename">{menu.entry.name}</div>
          {menu.entry.kind === "file" && (
            <button
              role="menuitem"
              onClick={() => {
                openPreview(menu.entry.path, { hostId, cwd: directory!.path });
                setMenu(null);
              }}
            >
              <File size={15} />
              미리보기
            </button>
          )}
          {menu.entry.kind === "directory" ? (
            <button role="menuitem" onClick={() => void load(menu.entry.path)}>
              <Folder size={15} />
              폴더 열기
            </button>
          ) : (
            <button role="menuitem" onClick={() => download(menu.entry)}>
              <ArrowDownToLine size={15} />내 컴퓨터로 다운로드
            </button>
          )}
          <button
            role="menuitem"
            onClick={() => {
              void navigator.clipboard
                .writeText(menu.entry.path)
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                })
                .catch((e) => setError(e.message));
              setMenu(null);
            }}
          >
            <Copy size={15} />
            경로 복사
          </button>
          <button
            role="menuitem"
            onClick={() => {
              onTerminal(
                host,
                menu.entry.kind === "directory"
                  ? menu.entry.path
                  : directory!.path,
              );
              setMenu(null);
            }}
          >
            <Terminal size={15} />이 위치에서 터미널
          </button>
        </div>
      )}
      {copied && (
        <div className="file-copy-notice" role="status">
          <Check size={14} />
          경로를 복사했습니다.
        </div>
      )}
      {folder !== null && (
        <Modal
          title="새 폴더"
          subtitle={`${host.name} · ${directory?.path}`}
          onClose={() => setFolder(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setFolderBusy(true);
              setFolderError("");
              try {
                await api(`/hosts/${hostId}/files/mkdir`, {
                  path: directory!.path,
                  name: folder,
                });
                setFolder(null);
                void load(directory!.path);
              } catch (err) {
                setFolderError((err as Error).message);
              } finally {
                setFolderBusy(false);
              }
            }}
          >
            <div className="modal-body">
              <label className="field">
                폴더 이름
                <input
                  required
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  placeholder="새 폴더"
                  maxLength={100}
                />
              </label>
              {folderError && <div className="form-error">{folderError}</div>}
            </div>
            <footer className="modal-footer">
              <button
                type="button"
                className="button ghost"
                onClick={() => setFolder(null)}
              >
                취소
              </button>
              <button className="button primary" disabled={folderBusy}>
                {folderBusy ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <FolderPlus size={15} />
                )}
                폴더 만들기
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </div>
  );
}
