import { useEffect, useState } from "react";
import { Download, LoaderCircle, RefreshCw } from "lucide-react";
import { Modal } from "./Dialogs";
import { api } from "./api";
import type { WorkspaceUpdateOverview } from "../shared/types";
import { UpdateWorkspaces } from "./UpdateWorkspaces";
import "./desktop-update.css";

export interface DesktopUpdateState {
  phase:
    | "idle"
    | "checking"
    | "current"
    | "available"
    | "preparing"
    | "ready"
    | "restarting"
    | "error";
  currentVersion: string;
  version?: string;
  notes?: string;
  step?: string;
  error?: string;
}
export function UpdateButton({ ready = true, primary = true, sshHosts = [], selectedHostId, onSetup }: {
  ready?: boolean; primary?: boolean; sshHosts?: {id:string;name:string}[];
  selectedHostId?:string; onSetup?: (id?:string) => void;
} = {}) {
  const desktop = window.harborDesktop;
  const [open, setOpen] = useState(false);
  const [syncRequest, setSyncRequest] = useState(0);
  const [applyingServers, setApplyingServers] = useState(false);
  const [setupHost, setSetupHost] = useState("");
  const targetHost = sshHosts.find(host => host.id === setupHost) || sshHosts.find(host => host.id === selectedHostId) || sshHosts[0];
  const [state, setState] = useState<DesktopUpdateState>({
    phase: "idle",
    currentVersion: desktop?.version || "",
  });
  useEffect(() => {
    if (!desktop?.updateState || !desktop.onUpdateState) return;
    let disposed = false;
    const stop = desktop.onUpdateState((value) => {
      if (!disposed) setState(value);
    });
    void desktop
      .updateState()
      .then((value) => {
        if (!disposed) setState(value);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      stop();
    };
  }, [desktop]);
  useEffect(() => {
    if (!desktop || !ready || !primary) return;
    const controller = new AbortController();
    void api<WorkspaceUpdateOverview>("/update/workspaces", undefined, "GET", controller.signal).then(data => {
      if (controller.signal.aborted || !data.handoff) return;
      try {
        const key = "harbor.update.handoff";
        if (localStorage.getItem(key) === data.handoff) return;
        localStorage.setItem(key, data.handoff);
        setOpen(true);
      } catch { /* Storage may be unavailable in a private viewer. */ }
    }).catch(() => {});
    return () => controller.abort();
  }, [desktop, ready, primary]);
  const available = !!desktop?.checkUpdate;
  const busy = ["checking", "preparing", "restarting"].includes(state.phase);
  const run = async (
    action: "checkUpdate" | "installUpdate" | "restartUpdate",
  ) => {
    try {
      const value = await desktop?.[action]?.();
      if (value) setState(value);
      if (action === "checkUpdate" && (!value || value.phase === "current" || value.phase === "error"))
        setSyncRequest(n => n + 1);
    } catch {
      setState((value) => ({
        ...value,
        phase: "error",
        error: "업데이트 작업에 실패했습니다. 다시 확인해주세요.",
      }));
      if (action === "checkUpdate") setSyncRequest(n => n + 1);
    }
  };
  const steps: Record<string, string> = {
    downloading: "업데이트 다운로드 중",
    extracting: "다운로드 파일 준비 중",
    installing: "필요한 구성 요소 설치 중",
    building: "새 버전 준비 중",
  };
  const notes = (state.notes || "")
    .split("\n")
    .filter((line) => /^- /.test(line))
    .slice(0, 12);
  return (
    <>
      <button
        className="harbor-update-button"
        title="Harbor 업데이트"
        aria-label="Harbor 업데이트"
        type="button"
        disabled={!ready && !available}
        onClick={() => {
          setOpen(true);
          setSyncRequest(0);
          if (available && !busy && state.phase !== "ready")
            void run("checkUpdate");
          else if (!available) setSyncRequest(1);
        }}
      >
        {busy && <LoaderCircle size={16} className="update-spinner" />}
        <span>업데이트</span>
      </button>
      {open && (
        <Modal
          title="Harbor 업데이트"
          backdropClassName="desktop-update-dialog"
          isolateEvents
          onClose={() => {
            if (!busy && !applyingServers) setOpen(false);
          }}
        >
          <div className="desktop-update-body">
            <div className="desktop-update-heading"><h3>이 PC</h3><span>
              {state.currentVersion ? "v" + state.currentVersion : ""}
              {state.version && state.phase !== "current"
                ? ` → v${state.version}`
                : ""}
            </span></div>
            {!available ? (
              <p>
                PC 앱은 바탕화면의 Harbor를 열어 업데이트하세요.
              </p>
            ) : state.phase === "current" ? (
              <p role="status">최신 버전입니다.</p>
            ) : busy ? (
              <p role="status">
                <LoaderCircle size={18} className="update-spinner" />
                {state.phase === "checking"
                  ? "GitHub에서 새 버전 확인 중"
                  : state.phase === "restarting"
                    ? "Harbor 다시 시작 중"
                    : steps[state.step || ""] || "업데이트 준비 중"}
              </p>
            ) : state.phase === "ready" ? (
              <p role="status">
                설치가 완료되었습니다. 다시 시작하면 적용됩니다.
              </p>
            ) : null}
            {state.error && (
              <p className="form-error" role="alert">
                {state.error}
              </p>
            )}
            {notes.length > 0 && (
              <details className="desktop-update-changes"><summary>변경 내역</summary><ul className="desktop-update-notes">
                {notes.map((line, i) => (
                  <li key={i}>{line.slice(2)}</li>
                ))}
              </ul></details>
            )}
            {["available", "preparing", "ready"].includes(state.phase) && (
              <p className="desktop-update-restart">
                설치 후 PC 앱이 다시 시작되고 서버 업데이트가 이어집니다. IDE 파일을 먼저 저장하세요. 로컬·일반 SSH 터미널은 종료됩니다.
              </p>
            )}
            {ready ? <UpdateWorkspaces synchronize={syncRequest} pcInstalling={["preparing","ready","restarting"].includes(state.phase)} onApplying={setApplyingServers}
              setup={onSetup && <div className="desktop-update-setup">
                {sshHosts.length > 0 && <select aria-label="작업 공간을 설정할 SSH 서버" value={targetHost?.id} onChange={e=>setSetupHost(e.target.value)}>
                  {sshHosts.map(host=><option key={host.id} value={host.id}>{host.name}</option>)}
                </select>}
                <button type="button" className="button secondary small" disabled={busy || applyingServers} onClick={() => {
                  setOpen(false);
                  onSetup(targetHost?.id);
                }}>{targetHost ? "서버 작업 공간 설정" : "SSH 서버 추가"}</button>
              </div>}/>
              : <p role="status">연결된 서버를 확인하려면 PC 서비스 연결이 필요합니다.</p>}
          </div>
          <footer className="modal-footer">
            <button
              className="button secondary"
              disabled={busy || applyingServers}
              onClick={() => setOpen(false)}
            >
              닫기
            </button>
            {state.phase === "available" && (
              <button
                className="button primary"
                disabled={applyingServers}
                onClick={() => void run("installUpdate")}
              >
                <Download size={16} />
                PC·서버 업데이트
              </button>
            )}
            {state.phase === "ready" && (
              <button
                className="button primary"
                onClick={() => void run("restartUpdate")}
              >
                <RefreshCw size={16} />
                다시 시작
              </button>
            )}
            {(!available || ["idle", "error", "current"].includes(state.phase)) && (
              <button
                className="button primary"
                disabled={applyingServers}
                onClick={() => available ? void run("checkUpdate") : setSyncRequest(n => n + 1)}
              >
                다시 확인
              </button>
            )}
          </footer>
        </Modal>
      )}
    </>
  );
}
