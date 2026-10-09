import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  Terminal,
  Upload,
  X,
} from "lucide-react";
import type { DirectoryView, FileEntry, HostView } from "../shared/types";
import { api, getToken } from "./api";
import { fileUrl, usePreview } from "./ResourcePreview";
import { useFileDrop } from "./useFileDrop";

export default function DirectoryTree({
  host,
  initialPath,
  onTerminal,
  onBrowse,
  onConnect,
}: {
  host?: HostView;
  initialPath?: string;
  onTerminal: (hostId: string, path: string) => void;
  onBrowse: (hostId: string, path: string) => void;
  onConnect: (host: HostView) => void;
}) {
  const preview = usePreview();
  const [root, setRoot] = useState<DirectoryView | null>(null);
  const [address, setAddress] = useState(initialPath || host?.defaultCwd || "");
  const [nodes, setNodes] = useState<Record<string, DirectoryView>>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState("");
  const [menu, setMenu] = useState<{
    entry: FileEntry;
    x: number;
    y: number;
  } | null>(null);
  const [uploadState, setUploadState] = useState("");
  const [uploading, setUploading] = useState(false);
  const generation = useRef(0);
  const uploadBusy = useRef(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const hostId = host?.id;
  const drop = useFileDrop({
    rootPath: root?.path,
    busy: uploading || busy,
    onFiles: (files, path) => void upload(files, path),
    onError: setError,
  });
  async function load(path: string) {
    if (!hostId) return;
    const gen = ++generation.current;
    setBusy(true);
    setError("");
    setMenu(null);
    try {
      const view = await api<DirectoryView>(
        `/hosts/${hostId}/files?${new URLSearchParams({ path })}`,
        undefined,
        "GET",
      );
      if (gen !== generation.current) return;
      setRoot(view);
      setAddress(view.path);
      setNodes({});
      setExpanded([]);
    } catch (err) {
      if (gen === generation.current) setError((err as Error).message);
    } finally {
      if (gen === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    setRoot(null);
    setNodes({});
    setExpanded([]);
    setSelected("");
    const path = initialPath || host?.defaultCwd || "";
    setAddress(path);
    if (hostId) void load(path);
    return () => {
      generation.current++;
    };
  }, [hostId, initialPath, host?.status]);
  async function toggle(entry: FileEntry) {
    if (expanded.includes(entry.path)) {
      setExpanded((prev) => prev.filter((p) => p !== entry.path));
      return;
    }
    const gen = generation.current;
    if (!nodes[entry.path]) {
      try {
        const view = await api<DirectoryView>(
          `/hosts/${hostId}/files?${new URLSearchParams({ path: entry.path })}`,
          undefined,
          "GET",
        );
        if (generation.current !== gen) return;
        setNodes((prev) => ({ ...prev, [entry.path]: view }));
      } catch (err) {
        if (generation.current === gen) setError((err as Error).message);
        return;
      }
    }
    if (generation.current === gen)
      setExpanded((prev) => [...new Set([...prev, entry.path])]);
  }
  async function upload(files: File[], target = root?.path) {
    if (!target || !hostId || uploadBusy.current || !files.length) return;
    uploadBusy.current = true;
    setUploading(true);
    setError("");
    const gen = generation.current;
    try {
      for (const [i, file] of files.entries()) {
        setUploadState(`${i + 1}/${files.length} · ${file.name} → ${target}`);
        const response = await fetch(
          `/api/hosts/${hostId}/files/upload?${new URLSearchParams({ path: target, name: file.name })}`,
          {
            method: "PUT",
            headers: {
              "X-Harbor-Token": getToken(),
              "Content-Type": "application/octet-stream",
            },
            body: file,
          },
        );
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error || "업로드에 실패했습니다.");
      }
      if (generation.current === gen) {
        const view = await api<DirectoryView>(
          `/hosts/${hostId}/files?${new URLSearchParams({ path: target })}`,
          undefined,
          "GET",
        );
        if (generation.current === gen) {
          if (target === root!.path) setRoot(view);
          else {
            setNodes((prev) => ({ ...prev, [target]: view }));
            setExpanded((prev) => [...new Set([...prev, target])]);
          }
          setUploadState(`${files.length}개 업로드 완료 · ${target}`);
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      uploadBusy.current = false;
      setUploading(false);
    }
  }
  function entries(view: DirectoryView, depth = 0) {
    return view.entries
      .filter((entry) => showHidden || !entry.name.startsWith("."))
      .map((entry) => {
        const directory = entry.kind === "directory";
        const isExpanded = expanded.includes(entry.path);
        return (
          <div
            key={entry.path}
            role="treeitem"
            aria-expanded={directory ? isExpanded : undefined}
          >
            <button
              className={`directory-row ${selected === entry.path ? "selected" : ""} ${drop.dragging && drop.targetPath === entry.path && directory ? "drop-target" : ""}`}
              {...drop.rowProps(
                directory ? entry.path : view.path,
                directory && !isExpanded ? () => void toggle(entry) : undefined,
              )}
              style={{ paddingLeft: 10 + depth * 14 }}
              title={entry.path}
              draggable={entry.kind === "file"}
              onDragStart={(event) => {
                if (entry.kind !== "file" || !hostId) {
                  event.preventDefault();
                  return;
                }
                event.dataTransfer.effectAllowed = "copy";
                event.dataTransfer.setData(
                  "application/x-harbor-file",
                  JSON.stringify({ hostId, path: entry.path, kind: "file" }),
                );
                event.dataTransfer.setData("text/plain", entry.path);
              }}
              onClick={() => {
                setSelected(entry.path);
                if (directory) void toggle(entry);
                else preview(entry.path, { hostId: hostId!, cwd: root!.path });
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setSelected(entry.path);
                setMenu({
                  entry,
                  x: Math.min(event.clientX, window.innerWidth - 230),
                  y: Math.min(event.clientY, window.innerHeight - 180),
                });
              }}
            >
              {directory ? (
                isExpanded ? (
                  <ChevronDown size={12} />
                ) : (
                  <ChevronRight size={12} />
                )
              ) : (
                <span className="directory-indent" />
              )}
              {directory ? (
                isExpanded ? (
                  <FolderOpen size={15} />
                ) : (
                  <Folder size={15} />
                )
              ) : (
                <FileIcon size={14} />
              )}
              <span>{entry.name}</span>
            </button>
            {directory && isExpanded && nodes[entry.path] && depth < 20 && (
              <div role="group">{entries(nodes[entry.path], depth + 1)}</div>
            )}
          </div>
        );
      });
  }
  return (
    <section
      className={`directory-explorer ${drop.dragging ? "dragging" : ""}`}
      aria-label="서버 파일 탐색기"
      {...drop.containerProps}
    >
      <header className="explorer-header">
        <b>파일 탐색기</b>
        <span title={host?.name}>{host?.name || "서버 선택"}</span>
        <button
          className="icon-button compact"
          title="파일 업로드"
          aria-label="탐색기 파일 업로드"
          disabled={!root || uploading}
          onClick={() => uploadInput.current?.click()}
        >
          <Upload size={14} />
        </button>
        <button
          className="icon-button compact"
          aria-label="탐색기 새로고침"
          disabled={busy || !host}
          onClick={() => void load(root?.path || address)}
        >
          <RefreshCw size={14} className={busy ? "spin" : ""} />
        </button>
      </header>
      <form
        className="explorer-path"
        onSubmit={(event) => {
          event.preventDefault();
          void load(address);
        }}
      >
        <button
          type="button"
          className="icon-button compact"
          title="상위 폴더"
          disabled={!root || root.parent === root.path}
          onClick={() => void load(root!.parent)}
        >
          <ArrowUp size={14} />
        </button>
        <input
          aria-label="탐색기 폴더 경로"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          spellCheck={false}
        />
        <button className="icon-button compact" aria-label="폴더로 이동">
          <ChevronRight size={14} />
        </button>
      </form>
      {error && (
        <div className="explorer-error" role="alert">
          <p>{error}</p>
          {host?.kind === "ssh" && (
            <button
              className="button secondary small"
              onClick={() => onConnect(host)}
            >
              서버 인증
            </button>
          )}
          <button
            className="icon-button compact"
            aria-label="탐색기 오류 닫기"
            onClick={() => setError("")}
          >
            <X size={13} />
          </button>
        </div>
      )}
      <div
        className="directory-tree"
        role="tree"
        aria-label={`${host?.name || "서버"} 디렉터리`}
      >
        {busy && !root ? (
          <div className="explorer-placeholder">
            <LoaderCircle size={18} className="spin" />
            폴더를 불러오는 중
          </div>
        ) : root ? (
          entries(root)
        ) : (
          <div className="explorer-placeholder">
            <Folder size={22} />
            <p>서버의 작업 폴더를 선택하세요.</p>
          </div>
        )}
        {root && !root.entries.length && (
          <p className="explorer-placeholder">빈 폴더입니다.</p>
        )}
        {root?.truncated && (
          <p className="explorer-placeholder">
            처음 5,000개 항목만 표시합니다.
          </p>
        )}
      </div>
      {drop.dragging && (
        <div className="explorer-drop-overlay">
          <Upload size={24} />
          <b>{host?.name}에 업로드</b>
          <span>{drop.targetPath || "먼저 폴더를 여세요."}</span>
        </div>
      )}
      <footer className="explorer-footer">
        <label>
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(event) => setShowHidden(event.target.checked)}
          />
          숨김 파일
        </label>
        <button
          title="넓은 파일 탐색 화면"
          onClick={() => hostId && onBrowse(hostId, root?.path || address)}
        >
          <FolderOpen size={13} />
          크게 보기
        </button>
      </footer>
      {uploadState && (
        <div className="explorer-upload" role="status">
          {uploading && <LoaderCircle size={12} className="spin" />}
          {uploadState}
        </div>
      )}
      <input
        ref={uploadInput}
        type="file"
        multiple
        hidden
        aria-label="탐색기 업로드 파일"
        onChange={(event) => {
          void upload([...(event.target.files || [])]);
          event.target.value = "";
        }}
      />
      {menu && (
        <>
          <button
            className="directory-menu-scrim"
            aria-label="파일 메뉴 닫기"
            onClick={() => setMenu(null)}
          />
          <div
            className="directory-context-menu"
            role="menu"
            style={{ left: menu.x, top: menu.y }}
          >
            {menu.entry.kind !== "directory" && (
              <a
                role="menuitem"
                href={fileUrl(hostId!, menu.entry.path)}
                download
                onClick={() => setMenu(null)}
              >
                <ArrowDownToLine size={14} />
                다운로드
              </a>
            )}
            <button
              role="menuitem"
              onClick={() => {
                const path = menu.entry.path;
                onTerminal(
                  hostId!,
                  menu.entry.kind === "directory"
                    ? path
                    : path.slice(
                        0,
                        Math.max(
                          path.lastIndexOf("/"),
                          path.lastIndexOf("\\"),
                        ) + 1,
                      ),
                );
                setMenu(null);
              }}
            >
              <Terminal size={14} />
              여기서 터미널 열기
            </button>
            <button
              role="menuitem"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(menu.entry.path);
                  setMenu(null);
                } catch {
                  setError("경로를 복사하지 못했습니다.");
                }
              }}
            >
              <FileIcon size={14} />
              경로 복사
            </button>
          </div>
        </>
      )}
    </section>
  );
}
