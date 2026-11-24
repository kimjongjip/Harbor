import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  WorkspaceUpdateOverview,
  WorkspaceUpdateStatus,
} from "../shared/types";
import { api } from "./api";

const workspacePhase: Record<WorkspaceUpdateStatus["phase"], string> = {
  checking: "확인 중",
  installing: "설치 중",
  pending: "적용 대기",
  current: "최신",
  error: "확인 필요",
};

type Restart = {
  id: string;
  name: string;
  runningVersion: string;
  stagedVersion: string;
};

export function UpdateWorkspaces({
  synchronize,
  pcInstalling,
  onApplying,
  setup,
}: {
  synchronize: number;
  pcInstalling: boolean;
  onApplying: (value: boolean) => void;
  setup?: ReactNode;
}) {
  const [overview, setOverview] = useState<WorkspaceUpdateOverview>();
  const [readError, setReadError] = useState("");
  const [failure, setFailure] = useState("");
  const [revision, refresh] = useState(0);
  const synced = useRef(0);
  const previous = useRef<WorkspaceUpdateOverview | undefined>(undefined);
  const [confirmation, setConfirmation] = useState<Restart[]>();
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let reading = false;
    async function read(force = false) {
      if (reading || controller.signal.aborted) return;
      reading = true;
      clearTimeout(timer);
      try {
        const value = await api<WorkspaceUpdateOverview>(
          "/update/workspaces",
          force ? {} : undefined,
          force ? "POST" : "GET",
          AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        );
        if (!Array.isArray(value.hosts)) throw Error();
        if (!controller.signal.aborted) {
          if (
            value.hosts.some(
              (host) =>
                host.phase === "current" &&
                previous.current?.hosts.some(
                  (old) =>
                    old.id === host.id &&
                    (old.phase === "pending" ||
                      (!!old.runningVersion &&
                        old.runningVersion !== host.runningVersion)),
                ),
            )
          )
            window.dispatchEvent(new Event("harbor-workspace-updated"));
          previous.current = value;
          setOverview(value);
          setReadError("");
        }
      } catch {
        if (!controller.signal.aborted)
          setReadError("연결된 서버의 업데이트 상태를 확인할 수 없습니다.");
      } finally {
        reading = false;
        if (!controller.signal.aborted)
          timer = setTimeout(() => {
            if (!document.hidden) void read();
          }, 3000);
      }
    }
    const visible = () => {
      if (!document.hidden) void read();
    };
    const force = synchronize > synced.current;
    synced.current = synchronize;
    void read(force);
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [synchronize, revision]);

  const pending: Restart[] = [];
  for (const host of overview?.hosts || []) {
    if (host.phase === "pending" && host.runningVersion && host.stagedVersion)
      pending.push({
        id: host.id,
        name: host.name,
        runningVersion: host.runningVersion,
        stagedVersion: host.stagedVersion,
      });
  }
  const pendingSignature = JSON.stringify(pending);
  const canConfirm =
    !!confirmation &&
    pendingSignature === JSON.stringify(confirmation) &&
    !readError &&
    !pcInstalling;
  useEffect(() => {
    setConfirmation(undefined);
  }, [pendingSignature, pcInstalling]);
  async function restart() {
    if (!canConfirm || !confirmation || applying) return;
    setApplying(true);
    onApplying(true);
    setFailure("");
    try {
      const failed: string[] = [];
      for (const { id, name, runningVersion, stagedVersion } of confirmation) {
        try {
          const result = await api<{ ok: boolean }>(
            "/hosts/" + encodeURIComponent(id) + "/server-workspace/apply",
            { runningVersion, stagedVersion, confirmStop: true },
            "POST",
            AbortSignal.timeout(165000),
          );
          if (!result.ok) throw Error("서버 버전을 다시 확인하세요.");
        } catch (error) {
          failed.push(name + " · " + (error as Error).message);
        }
      }
      if (failed.length < confirmation.length)
        window.dispatchEvent(new Event("harbor-workspace-updated"));
      setFailure(failed.join(" / "));
    } finally {
      setApplying(false);
      onApplying(false);
      setConfirmation(undefined);
      refresh((n) => n + 1);
    }
  }

  return (
    <section
      className="desktop-update-workspaces"
      aria-label="연결된 Harbor 서버"
    >
      <h3>연결된 Harbor 서버</h3>
      {readError && (
        <p role="alert" className="form-error">
          {readError}
        </p>
      )}
      {!overview && !readError && <p role="status">서버 확인 중…</p>}
      {overview?.hosts.length === 0 && (
        <><p>Harbor 작업 공간이 설치된 서버가 없습니다.</p>{setup}</>
      )}
      {!!overview?.hosts.length && (
        <ul className="desktop-update-servers">
          {overview.hosts.map((host) => (
            <li key={host.id}>
              <div>
                <strong>{host.name}</strong>
                <span>
                  {host.runningVersion
                    ? "v" + host.runningVersion
                    : "실행 버전 확인 중"}
                  {host.stagedVersion &&
                  host.stagedVersion !== host.runningVersion
                    ? " → v" + host.stagedVersion
                    : ""}
                </span>
              </div>
              <span className="desktop-update-phase" data-phase={host.phase}>
                {workspacePhase[host.phase]}
              </span>
              {host.phase === "error" && host.detail && (
                <small>{host.detail}</small>
              )}
            </li>
          ))}
        </ul>
      )}
      {!!pending.length && !pcInstalling && (
        <div className="desktop-update-pending">
          {canConfirm || applying ? (
            <>
              <p>
                <strong>
                  {(confirmation || pending).map((h) => h.name).join(", ")}
                </strong>{" "}
                서버의 Harbor를 재시작하면 해당 서비스의 열린 터미널, AI 작업과
                백그라운드 프로세스가 중단됩니다. 저장된 AI 대화는 같은 탭에서
                다시 연결됩니다.
              </p>
              <div>
                <button
                  type="button"
                  className="button secondary small"
                  disabled={applying}
                  onClick={() => setConfirmation(undefined)}
                >
                  취소
                </button>
                <button
                  type="button"
                  className="button primary small"
                  disabled={applying || !canConfirm}
                  onClick={() => void restart()}
                >
                  {applying ? "서버에 적용 중…" : "작업 중단 후 서버 재시작"}
                </button>
              </div>
            </>
          ) : (
            <>
              <p>서버 작업 종료 후 자동 적용됩니다.</p>
              <button
                type="button"
                className="button secondary small"
                disabled={!!readError}
                onClick={() => setConfirmation(pending)}
              >
                대기 중인 서버 지금 적용
              </button>
            </>
          )}
        </div>
      )}
      {failure && (
        <p className="form-error" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}
