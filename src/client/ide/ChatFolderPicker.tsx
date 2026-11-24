import { useEffect, useRef, useState } from "react";
import { ArrowUp, Folder } from "lucide-react";
import type { IdeChatFolders } from "../../shared/ide-chat";
import type { IdeChatRequest } from "./IdeChatPanel";
import { Modal } from "../Dialogs";

export async function loadChatFolders(
  request: IdeChatRequest,
  hostId: string,
  path: string,
  list: boolean,
  signal?: AbortSignal,
): Promise<IdeChatFolders> {
  const query = new URLSearchParams({ list: list ? "1" : "0" });
  if (path) query.set("path", path);
  const res = await request(
    "/hosts/" + encodeURIComponent(hostId) + "/folders?" + query,
    { signal },
  );
  let value;
  try {
    value = await res.json();
  } catch {
    throw Error("폴더를 확인할 수 없습니다. 서버 연결을 확인하세요.");
  }
  if (
    !res.ok ||
    typeof value.path !== "string" ||
    !value.path ||
    !Array.isArray(value.folders)
  )
    throw Error(value?.error || "폴더를 확인할 수 없습니다.");
  return value;
}

export function ChatFolderPicker({
  hostId,
  hostName,
  initialPath,
  request,
  onSelect,
  onClose,
}: {
  hostId: string;
  hostName: string;
  initialPath: string;
  request: IdeChatRequest;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [directory, setDirectory] = useState<IdeChatFolders>(),
    [path, setPath] = useState(initialPath),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(true);
  const current = useRef<AbortController | undefined>(undefined);
  const start = useRef(initialPath);
  async function browse(next: string) {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setBusy(true);
    setError("");
    setPath(next);
    try {
      const folder = await loadChatFolders(
        request,
        hostId,
        next,
        true,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setDirectory(folder);
        setPath(folder.path);
      }
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    void browse(start.current);
    return () => current.current?.abort();
  }, [hostId, request]);
  return (
    <Modal
      title="작업 폴더 선택"
      subtitle={hostName}
      onClose={onClose}
      isolateEvents
    >
      <form
        className="chat-folder-path"
        onSubmit={(e) => {
          e.preventDefault();
          void browse(path);
        }}
      >
        <label>
          폴더 경로
          <input
            aria-label="폴더 경로"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            autoComplete="off"
          />
        </label>
        <button className="button secondary" type="submit">
          이동
        </button>
      </form>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="chat-folder-list" aria-busy={busy}>
        {directory && directory.path !== directory.parent && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void browse(directory.parent)}
          >
            <ArrowUp size={15} />
            상위 폴더
          </button>
        )}
        {busy ? (
          <p role="status">폴더 확인 중…</p>
        ) : (
          directory &&
          directory.folders.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => void browse(f.path)}
            >
              <Folder size={15} />
              {f.name}
            </button>
          ))
        )}
        {!busy && !error && !directory?.folders.length && (
          <p>하위 폴더가 없습니다.</p>
        )}
        {directory?.truncated && <p>다른 폴더는 경로로 이동하세요.</p>}
      </div>
      <footer className="chat-folder-confirm">
        <button type="button" className="button secondary" onClick={onClose}>
          취소
        </button>
        <button
          type="button"
          className="button primary"
          disabled={busy || !!error || !directory || directory.path !== path}
          onClick={() => {
            if (directory) onSelect(directory.path);
          }}
        >
          이 폴더 선택
        </button>
      </footer>
    </Modal>
  );
}
