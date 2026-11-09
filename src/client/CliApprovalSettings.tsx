import { useState } from "react";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import type { CliApprovalMode, HostView } from "../shared/types";
import { Modal } from "./Dialogs";
import { api } from "./api";

export function CliApprovalSettings({ host }: { host: HostView }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<CliApprovalMode>("native");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const full = host.cliApprovalMode === "full-access";
  return (
    <>
      <button
        type="button"
        className="icon-button"
        aria-label={`${host.name} AI 실행 승인 설정`}
        title={`서버 CLI 시작 권한 · ${full ? "새 터미널은 승인 생략 · 전체 권한" : "CLI 설정 사용"}`}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setMode(host.cliApprovalMode || "native");
          setError("");
          setOpen(true);
        }}
      >
        {full ? <ShieldAlert size={15} /> : <ShieldCheck size={15} />}
      </button>
      {open && (
        <Modal
          isolateEvents
          title="서버 CLI 시작 권한"
          subtitle={host.name}
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          <form
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError("");
              try {
                await api(`/hosts/${host.id}/cli-approval`, { mode }, "PATCH");
                setOpen(false);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="modal-body">
              <label className="field">
                새 터미널의 Codex·Claude 승인 방식
                <select
                  aria-label="AI 실행 승인 방식"
                  value={mode}
                  disabled={busy}
                  onChange={(event) =>
                    setMode(event.target.value as CliApprovalMode)
                  }
                >
                  <option value="native">CLI 설정 사용</option>
                  <option value="full-access">승인 생략 · 전체 권한</option>
                </select>
              </label>
              <p>
                {mode === "full-access"
                  ? "명령 실행·파일 수정의 승인 대기를 생략합니다. 파일 삭제, 프로젝트 밖 접근, 네트워크 명령도 확인 없이 실행될 수 있습니다. 신뢰하는 작업에만 사용하세요."
                  : "Codex·Claude에 설정된 승인 방식을 그대로 사용합니다."}
              </p>
              <p>
                저장 후 새로 여는 터미널에 적용됩니다. 대화 기록 이어가기와
                연구실에서 새로 띄우는 AI도 포함합니다. 실행 중인 AI와 기존 tmux
                세션은 바뀌지 않습니다.
              </p>
              <p>
                로그인·최초 신뢰 확인·작업 방향 질문은 직접 처리합니다. CLI의
                조직 정책이나 강제 확인을 우회하지 않습니다.
              </p>
              {error && (
                <div className="form-error" role="alert">
                  {error}
                </div>
              )}
            </div>
            <footer className="modal-footer">
              <button
                type="button"
                className="button ghost"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                취소
              </button>
              <button type="submit" className="button primary" disabled={busy}>
                {busy ? "저장 중…" : "설정 저장"}
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </>
  );
}
