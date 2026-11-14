import { useEffect, useState } from "react";
import { Download, LoaderCircle, RefreshCw } from "lucide-react";
import { Modal } from "./Dialogs";
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
export function UpdateButton() {
  const desktop = window.harborDesktop;
  const [open, setOpen] = useState(false);
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
  if (!desktop) return null;
  const available = !!desktop.checkUpdate;
  const busy = ["checking", "preparing", "restarting"].includes(state.phase);
  const run = async (
    action: "checkUpdate" | "installUpdate" | "restartUpdate",
  ) => {
    try {
      const value = await desktop[action]?.();
      if (value) setState(value);
    } catch {
      setState((value) => ({
        ...value,
        phase: "error",
        error: "업데이트 작업에 실패했습니다. 다시 확인해주세요.",
      }));
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
        onClick={() => {
          setOpen(true);
          if (available && !busy && state.phase !== "ready")
            void run("checkUpdate");
        }}
      >
        {busy ? (
          <LoaderCircle size={16} className="update-spinner" />
        ) : (
          <Download size={16} />
        )}
        <span>업데이트</span>
      </button>
      {open && (
        <Modal
          title="Harbor 업데이트"
          isolateEvents
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          <div className="desktop-update-body">
            <p className="desktop-update-version">
              현재 {state.currentVersion}
              {state.version && state.phase !== "current"
                ? ` → ${state.version}`
                : ""}
            </p>
            {!available ? (
              <p>
                Harbor를 다음에 다시 실행하면 업데이트 버튼을 사용할 수
                있습니다.
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
              <ul className="desktop-update-notes">
                {notes.map((line, i) => (
                  <li key={i}>{line.slice(2)}</li>
                ))}
              </ul>
            )}
            {["available", "preparing", "ready"].includes(state.phase) && (
              <p className="desktop-update-restart">
                설치 후 자동으로 다시 시작합니다. IDE 파일을 먼저 저장하세요.
                tmux 작업은 유지되며 로컬·일반 SSH 터미널은 종료됩니다.
              </p>
            )}
          </div>
          <footer className="modal-footer">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              닫기
            </button>
            {state.phase === "available" && (
              <button
                className="button primary"
                onClick={() => void run("installUpdate")}
              >
                <Download size={16} />
                설치 후 다시 시작
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
            {available && ["error", "current"].includes(state.phase) && (
              <button
                className="button primary"
                onClick={() => void run("checkUpdate")}
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
