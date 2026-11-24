import { useEffect, useState } from "react";
import { api, apiHeaders } from "./api";
import { remoteDesktop } from "./desktop-session";
import {useWorkspaceUpdate,WorkspaceUpdateState} from "./WorkspaceUpdateState";

const statusRequest = (path:string, init?:RequestInit) =>
  fetch("/api" + path, {...init,headers:apiHeaders()});

export function ServerWorkspace({
  hostId,
  password,
  disabled,
  enabled,
}: {
  hostId: string;
  password: string;
  disabled: boolean;
  enabled?: boolean;
}) {
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [workspace, setWorkspace] = useState<{
    url: string;
    updatePending: boolean;
  }>();
  const path = "/hosts/" + encodeURIComponent(hostId) + "/server-workspace";
  const [revision, refresh] = useState(0);
  const localManager = !remoteDesktop && !location.hostname.startsWith("harbor-");
  const update = useWorkspaceUpdate(hostId, !!enabled && localManager, statusRequest, path, revision);
  const [confirm, setConfirm] = useState<{runningVersion:string; stagedVersion:string}>();
  const [applied, setApplied] = useState("");
  useEffect(() => {
    setConfirm(undefined);
    if (update?.phase !== "pending") setApplied("");
  }, [update?.phase, update?.runningVersion, update?.stagedVersion]);
  async function applyUpdate() {
    if (!confirm || disabled || pending || !localManager || update?.phase !== "pending" ||
        update.runningVersion !== confirm.runningVersion || update.stagedVersion !== confirm.stagedVersion) return;
    setPending("서버 업데이트 적용 중…");
    setError("");
    try {
      const result = await api<{ok:boolean}>(path + "/apply", {...confirm, confirmStop:true, password:password || undefined});
      if (!result.ok) throw Error("서버에 적용된 버전을 확인하지 못했습니다.");
      setApplied(confirm.stagedVersion);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setConfirm(undefined);
      setPending("");
      refresh(v => v + 1);
    }
  }
  async function open(install: boolean) {
    setPending(install ? "설치 확인 중…" : "연결 중…");
    setError("");
    setWorkspace(undefined);
    try {
      const result = await api<{ url: string; updatePending: boolean }>(
        path,
        { install, password: password || undefined },
      );
      const url = new URL(result.url);
      if (
        url.protocol !== "http:" ||
        !/^harbor-[0-9a-f]{24}\.localhost$/.test(url.hostname) ||
        !url.port ||
        url.pathname !== "/_workspace/open" ||
        url.username ||
        url.password
      )
        throw Error("서버 작업 공간 주소를 확인할 수 없습니다.");
      setWorkspace(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending("");
      refresh(v => v + 1);
    }
  }
  return (
    <section data-workspace-settings tabIndex={-1} aria-label="서버에서 세션 유지">
      <strong>서버에서 세션 유지</strong>
      <p>서버 작업 공간에서 시작한 AI와 실험은 PC 연결을 끊어도 계속됩니다.</p>
      <div className="host-auth-row">
        <button
          type="button"
          className="button secondary"
          disabled={disabled || !!pending}
          onClick={() => void open(true)}
        >
          설치·업데이트
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={disabled || !!pending}
          onClick={() => void open(false)}
        >
          연결
        </button>
        {enabled && (
          <button
            type="button"
            className="button secondary"
            disabled={disabled || !!pending}
            onClick={async () => {
              setPending("연결 해제 중…");
              setError("");
              try {
                await api(
                  "/hosts/" + encodeURIComponent(hostId) + "/server-workspace",
                  undefined,
                  "DELETE",
                );
                setWorkspace(undefined);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setPending("");
              }
            }}
          >
            이 PC 연결 해제
          </button>
        )}
      </div>
      {pending && <p role="status">{pending}</p>}
      {enabled && update && <WorkspaceUpdateState status={update} />}
      {localManager && enabled && update?.phase === "pending" && applied !== update.stagedVersion && (
        confirm ? <div role="group" aria-label="서버 재시작 확인">
          <p>서버 Harbor를 재시작하면 이 서비스의 열린 터미널, AI 작업, 백그라운드 프로세스가 중단됩니다. 저장된 대화는 기록에서 다시 열 수 있습니다.</p>
          <div className="host-auth-row">
            <button type="button" className="button secondary" disabled={!!pending} onClick={()=>setConfirm(undefined)}>취소</button>
            <button type="button" className="button primary" disabled={disabled || !!pending} onClick={()=>void applyUpdate()}>작업 중단 후 서버 재시작</button>
          </div>
        </div> : <button type="button" className="button secondary" disabled={disabled || !!pending || !update.runningVersion || !update.stagedVersion}
          onClick={()=>{if (update.runningVersion && update.stagedVersion) setConfirm({runningVersion:update.runningVersion,stagedVersion:update.stagedVersion});}}>
          서버 업데이트 지금 적용
        </button>
      )}
      {workspace && (
        <>
          <a
            href={workspace.url}
            target="_blank"
            rel="noreferrer"
            className="button primary"
          >
            서버 작업 공간 열기
          </a>
          {!update && workspace.updatePending && (
            <p>
              새 버전을 준비했습니다. 터미널과 작업이 끝나고 서버가 유휴 상태가
              되면 적용됩니다.
            </p>
          )}
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
