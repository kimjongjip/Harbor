import { useEffect, useState } from "react";

type Status = {
  phase: "ready" | "recovering" | "failed";
  attempt: number;
  revision: number;
};
export function BackendStatus() {
  const [status, setStatus] = useState<Status | null>(null);
  const [dismissed, setDismissed] = useState(-1);
  useEffect(() => {
    const desktop = window.harborDesktop;
    if (!desktop?.backendState || !desktop.onBackendState) return;
    let active = true;
    const accept = (next: Status) => {
      if (active)
        setStatus((previous) =>
          previous && previous.revision > next.revision ? previous : next,
        );
    };
    const unsubscribe = desktop.onBackendState(accept);
    void desktop
      .backendState()
      .then(accept)
      .catch(() => {});
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  if (
    !status ||
    status.revision === dismissed ||
    (status.phase === "ready" && !status.attempt)
  )
    return null;
  return (
    <div
      className={`harbor-error backend-status backend-${status.phase}`}
      role={status.phase === "failed" ? "alert" : "status"}
    >
      <span>
        {status.phase === "recovering"
          ? `Harbor 연결 프로세스가 종료되어 다시 시작하고 있습니다… (${status.attempt}/3)`
          : status.phase === "failed"
            ? "Harbor 연결 프로세스를 복구하지 못했습니다. 연속 재시도는 중단했습니다."
            : "Harbor 연결 프로세스를 복구했습니다. 서버에서 유지 중인 세션은 다시 연결하며, 종료된 로컬·일반 SSH 세션은 대화 기록에서 이어가세요."}
      </span>
      {status.phase === "failed" && (
        <button
          className="button secondary small"
          onClick={() => void window.harborDesktop?.retryBackend?.()}
        >
          연결 복구
        </button>
      )}
      {status.phase === "ready" && (
        <button
          className="button ghost small"
          onClick={() => setDismissed(status.revision)}
        >
          닫기
        </button>
      )}
    </div>
  );
}
