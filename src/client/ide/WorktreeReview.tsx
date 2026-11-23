import { useEffect, useRef, useState } from "react";
import type { IdeChatRequest } from "./IdeChatPanel";
type Review = {
  root: string;
  files: { path: string; status: string }[];
  staged?: string;
  working?: string;
  notice?: string;
  writesAvailable: boolean;
};
type Operation = "commit" | "push" | "restore";
type Preview = {
  root: string;
  branch: string;
  target: string;
  detail: string;
  truncated: boolean;
  confirmation: string;
};
const labels = {
  commit: "스테이징한 변경 커밋",
  push: "현재 브랜치 푸시",
  restore: "작업 파일을 스테이징 상태로 복원",
};
export function WorktreeReview({
  id,
  runtimeId,
  terminalId,
  request,
}: {
  id: string;
  runtimeId: string;
  terminalId?: string;
  request: IdeChatRequest;
}) {
  const [open, show] = useState(false),
    [file, select] = useState(""),
    [revision, refresh] = useState(0),
    [data, setData] = useState<Review>();
  const [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview & { operation: Operation }>();
  const transport = useRef(request);
  transport.current = request;
  const endpoint = "/conversations/" + encodeURIComponent(id) + "/worktree";
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setData(undefined);
    setError("");
    setPreview(undefined);
    transport
      .current(endpoint + (file ? "?" + new URLSearchParams({ file }) : ""), {
        signal: controller.signal,
      })
      .then(async (res) => {
        const value = await res.json();
        if (!res.ok) throw Error(value.error || "변경 내역 조회 실패");
        if (!controller.signal.aborted) setData(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [endpoint, file, revision, open]);
  async function act(operation: Operation, confirm?: string) {
    setError("");
    setNotice("");
    setBusy(true);
    setPreview(undefined);
    try {
      const response = await transport.current(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(terminalId ? { "X-Harbor-Terminal": terminalId } : {}),
        },
        body: JSON.stringify({
          runtimeId,
          operation,
          ...(operation === "commit" ? { message } : {}),
          ...(operation === "restore" ? { file } : {}),
          confirm,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || "Git 요청 실패");
      if (confirm) {
        setNotice(labels[operation] + " 완료");
        if (operation === "commit") setMessage("");
        select("");
        refresh((i) => i + 1);
      } else setPreview({ ...result, operation });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className="worktree-review"
      open={open}
      onToggle={(e) => show(e.currentTarget.open)}
    >
      <summary>작업 폴더 변경 내역</summary>
      {open && (
        <div>
          <button
            disabled={busy}
            onClick={() => {
              select("");
              refresh((i) => i + 1);
            }}
          >
            새로고침
          </button>
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          {data && (
            <>
              <small>{data.root}</small>
              {data.files.length ? (
                <select
                  aria-label="변경 파일"
                  disabled={busy}
                  value={file}
                  onChange={(e) => {
                    setPreview(undefined);
                    select(e.target.value);
                  }}
                >
                  <option value="">파일 선택 · {data.files.length}개</option>
                  {data.files.map((f) => (
                    <option value={f.path} key={f.path}>
                      {f.status} {f.path}
                    </option>
                  ))}
                </select>
              ) : (
                <p>변경된 파일이 없습니다.</p>
              )}
              {data.notice && <p>{data.notice}</p>}
              {data.staged && (
                <>
                  <b>스테이징한 변경</b>
                  <pre>{data.staged}</pre>
                </>
              )}
              {data.working && (
                <>
                  <b>작업 폴더 변경</b>
                  <pre>{data.working}</pre>
                </>
              )}
              {data.writesAvailable && (
                <div className="git-review-actions">
                  {data.files.some(
                    (f) => f.status[0] !== " " && f.status !== "??",
                  ) && (
                    <>
                      <input
                        aria-label="커밋 메시지"
                        placeholder="커밋 메시지"
                        maxLength={300}
                        disabled={busy}
                        value={message}
                        onChange={(e) => {
                          setMessage(e.target.value);
                          setPreview(undefined);
                        }}
                      />
                      <button
                        disabled={busy || !message.trim()}
                        onClick={() => void act("commit")}
                      >
                        커밋 미리보기
                      </button>
                    </>
                  )}
                  <button disabled={busy} onClick={() => void act("push")}>
                    푸시 미리보기
                  </button>
                  {data.working && (
                    <button disabled={busy} onClick={() => void act("restore")}>
                      파일 복원 미리보기
                    </button>
                  )}
                  {preview && (
                    <section>
                      <strong>{labels[preview.operation]}</strong>
                      <p>
                        {preview.branch} · {preview.target}
                      </p>
                      {preview.operation === "commit" && <p>{message}</p>}
                      {preview.operation === "restore" && (
                        <p>아래 작업 폴더 변경을 버립니다.</p>
                      )}
                      <pre>{preview.detail}</pre>
                      {preview.truncated && <p>미리보기 100,000자까지 표시</p>}
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(preview.operation, preview.confirmation)
                        }
                      >
                        {labels[preview.operation]} 실행
                      </button>
                      <button onClick={() => setPreview(undefined)}>
                        취소
                      </button>
                    </section>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </details>
  );
}
