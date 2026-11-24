import { useEffect, useState } from "react";
import type { WorkspaceUpdateStatus } from "../shared/types";

type StatusRequest = (path: string, init?: RequestInit) => Promise<Response>;

export function useWorkspaceUpdate(
  hostId: string, active: boolean, request: StatusRequest, path = "/workspace-update", revision = 0,
) {
  const [latest, setLatest] = useState<{hostId:string; status?:WorkspaceUpdateStatus}>();
  useEffect(() => {
    if (!active || !hostId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let fetching = false;
    async function read() {
      if (controller.signal.aborted || document.hidden || fetching) return;
      clearTimeout(timer);
      fetching = true;
      try {
        const response = await request(path, {signal:controller.signal});
        if (!response.ok) throw Error();
        const status:WorkspaceUpdateStatus = await response.json();
        if (!["checking","installing","pending","current","error"].includes(status?.phase)) throw Error();
        if (!controller.signal.aborted) setLatest({hostId, status});
      } catch {
        if (!controller.signal.aborted) setLatest({hostId});
      } finally {
        fetching = false;
        if (!controller.signal.aborted) timer = setTimeout(read, 15000);
      }
    }
    void read();
    document.addEventListener("visibilitychange", read);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, [hostId, active, request, path, revision]);
  return latest?.hostId === hostId ? latest.status : undefined;
}

export function WorkspaceUpdateState({status, inSettings = false}: {status:WorkspaceUpdateStatus; inSettings?:boolean}) {
  const {phase,runningVersion,targetVersion,stagedVersion} = status;
  const versions = [
    runningVersion && "서버 " + runningVersion,
    targetVersion && "PC " + targetVersion,
  ].filter(Boolean).join(" · ");
  const label = {
    checking:"서버 버전 확인 중",
    installing:"서버 업데이트 설치 중",
    pending:"서버 업데이트 적용 대기",
    current:"서버 업데이트 완료",
    error:"서버 업데이트 확인 필요",
  }[phase];
  return <div className="workspace-update-state" role="status">
    <strong>{label}</strong>{versions && <span>{versions}</span>}
    {phase === "pending" && <p>{stagedVersion ? stagedVersion + " 설치 완료. " : ""}열린 작업이 끝나면 적용됩니다.{inSettings && " 지금 적용하려면 호스트 PC 상단의 업데이트를 여세요."}</p>}
    {phase === "error" && <p>{status.detail || "서버 관리에서 SSH 연결을 확인하세요."}</p>}
  </div>;
}
