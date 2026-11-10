import { useEffect, useState } from "react";
import { Download, LoaderCircle, Puzzle, RefreshCw } from "lucide-react";
import type { HostView } from "../shared/types";
import {
  crewMod,
  type ClaudeModsJob,
  type ClaudeModsStatus,
} from "../shared/claude-mods";
import { getToken, ApiError } from "./api";
import { Modal } from "./Dialogs";
import "./claude-mods.css";

async function api<T>(
  path: string,
  body?: unknown,
  method = "POST",
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
      : AbortSignal.timeout(45000),
    headers: {
      "Content-Type": "application/json",
      "X-Harbor-Token": getToken(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // Older servers may serve the SPA fallback for an unknown GET route.
  if (!response.headers.get("Content-Type")?.includes("application/json"))
    throw new ApiError("Mods unavailable", 404);
  const value = await response.json();
  if (!response.ok)
    throw new ApiError(
      value.error || "Mods 요청에 실패했습니다.",
      response.status,
    );
  return value as T;
}

function failure(error: unknown) {
  if (error instanceof ApiError && error.status === 404)
    return "실행 중인 Harbor 서버에는 Mods 설치 기능이 아직 없습니다. 작업을 마치고 업데이트된 Harbor를 다시 열면 사용할 수 있습니다.";
  return error instanceof Error
    ? error.message
    : "Mods 상태를 확인하지 못했습니다.";
}
function ModsDialog({
  host,
  onClose,
}: {
  host: HostView;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<ClaudeModsStatus>();
  const [job, setJob] = useState<ClaudeModsJob>();
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const base = `/hosts/${encodeURIComponent(host.id)}/claude-mods`;
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    Promise.all([
      api<ClaudeModsStatus>(base, undefined, "GET", abort.signal),
      api<{ job: ClaudeModsJob | null }>(
        `${base}/job`,
        undefined,
        "GET",
        abort.signal,
      ),
    ])
      .then(([value, task]) => {
        if (abort.signal.aborted) return;
        setStatus(value);
        setJob(task.job || undefined);
      })
      .catch((reason) => {
        if (!abort.signal.aborted) setError(failure(reason));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [base, revision]);
  useEffect(() => {
    if (job?.status !== "running") return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await api<{ job: ClaudeModsJob | null }>(
          `${base}/job`,
          undefined,
          "GET",
          abort.signal,
        );
        if (abort.signal.aborted) return;
        if (!value.job) {
          setError(
            "설치 작업 상태가 초기화되었습니다. 설치 상태를 다시 확인해 주세요.",
          );
          setJob(undefined);
          return;
        }
        setJob(value.job);
        if (value.job.result) setStatus(value.job.result);
        if (value.job.status !== "running") return;
      } catch (reason) {
        if (!abort.signal.aborted) setError(failure(reason));
      }
      if (!abort.signal.aborted) timer = setTimeout(poll, 1500);
    }
    timer = setTimeout(poll, 700);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [base, job?.id, job?.status]);
  const busy = sending || job?.status === "running";
  return (
    <Modal
      title="Claude Mods"
      subtitle={host.name}
      onClose={onClose}
      isolateEvents
    >
      <div className="modal-body claude-mods-body">
        <div className="claude-mod-card">
          <div className="claude-mod-heading">
            <Puzzle size={22} />
            <h3>{crewMod.name}</h3>
            <button
              className="icon-button"
              aria-label="Mods 설치 상태 새로고침"
              disabled={loading || busy}
              onClick={() => setRevision((value) => value + 1)}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          <p>
            캐릭터 애니메이션으로 에이전트 작업 상태와 컨텍스트 사용량을
            보여줍니다.
          </p>
          <a href={crewMod.url} target="_blank" rel="noreferrer">
            플러그인 소스 · MIT
          </a>
          <p className="claude-mod-state" role="status">
            {loading
              ? "서버의 Claude Code를 확인하고 있습니다…"
              : status
                ? `Claude ${status.version} · ${status.installed ? (status.enabled ? "설치됨" : "설치됨 · 비활성화") : "미설치"}`
                : "상태 확인 필요"}
          </p>
          {status && !status.compatible && (
            <p>
              이 Mods는 Claude Code {crewMod.minimumVersion} 이상이 필요합니다.
            </p>
          )}
          {status?.installed && !status.enabled && (
            <p>
              해당 서버의 Claude에서 <code>/plugin</code>을 열어 Agent Crew를
              활성화하세요.
            </p>
          )}
          <button
            className="button primary"
            disabled={
              loading || busy || !status?.compatible || status.installed
            }
            onClick={async () => {
              setSending(true);
              setError("");
              try {
                setJob(
                  await api<ClaudeModsJob>(`${base}/install`, {
                    mod: crewMod.id,
                  }),
                );
              } catch (reason) {
                setError(failure(reason));
              } finally {
                setSending(false);
              }
            }}
          >
            {busy ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Download size={15} />
            )}{" "}
            {busy
              ? "설치 중…"
              : status?.installed
                ? "설치 확인됨"
                : `${host.name}에 설치`}
          </button>
        </div>
        {job && (
          <p role={job.status === "failed" ? "alert" : "status"}>
            {job.message}
          </p>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <p>
          설치 후 이 서버에서 새로 여는 Claude 세션에 적용됩니다.{" "}
          <code>/crew on</code>, <code>/crew off</code>, <code>/crew cat</code>
          으로 패널을 조절할 수 있습니다.
        </p>
      </div>
      <footer className="modal-footer">
        <button className="button secondary" onClick={onClose}>
          닫기
        </button>
      </footer>
    </Modal>
  );
}

export function ClaudeModsButton({ host }: { host: HostView }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="icon-button"
        type="button"
        title="Claude Mods 설치"
        aria-label={`${host.name} Claude Mods`}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <Puzzle size={15} />
      </button>
      {open && (
        <ModsDialog key={host.id} host={host} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
