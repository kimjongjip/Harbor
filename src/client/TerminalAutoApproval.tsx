import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { TerminalInfo } from "../shared/types";
import { api } from "./api";
import { Modal } from "./Dialogs";

export default function TerminalAutoApproval({
  terminal,
}: {
  terminal: TerminalInfo;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const status = terminal.autoApproval;
  const enabled = status?.enabled || false;
  async function change(value: boolean) {
    setBusy(true);
    setError("");
    try {
      await api(
        `/terminals/${terminal.id}/auto-approval`,
        { enabled: value },
        "PATCH",
      );
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="icon-button compact"
        aria-label={`자동 수락 설정: ${terminal.title}`}
        title={`이 세션 자동 수락 ${enabled ? "켜짐" : "꺼짐"}${status?.accepted ? ` · ${status.accepted}건 수락` : ""}`}
        aria-pressed={enabled}
        disabled={terminal.exited}
        onClick={() => {
          setError("");
          setOpen(true);
        }}
      >
        <ShieldCheck size={14} />
        {enabled && <span>자동 수락</span>}
      </button>
      {open && (
        <Modal
          title="이 세션 자동 수락"
          subtitle={terminal.title}
          isolateEvents
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          <div className="modal-body">
            <p>
              <b>{enabled ? "켜짐" : "꺼짐"}</b> · 자동 수락{" "}
              {status?.accepted || 0}건
            </p>
            <p>
              이 세션에서 Codex·Claude가 실행 승인을 요청하면 Harbor가 ‘이번만
              허용’을 자동으로 선택합니다. 지금 받은함에서 대기 중인 실행 승인도
              포함합니다.
            </p>
            <p>
              명령 실행·파일 삭제 등도 자동 수락됩니다. 다른 세션에는 적용하지
              않으며, 일반 질문과 계획 확인에는 답하지 않습니다.
            </p>
            <p>
              CLI의 승인 설정을 바꾸지 않습니다. 앱을 완전히 종료하거나 다른
              대화로 전환하면 다시 켜야 합니다. 최초 신뢰·로그인 등 Harbor로
              전달되지 않는 확인은 직접 처리합니다.
            </p>
            {terminal.cliApprovalMode === "full-access" && (
              <p>
                이 터미널은 CLI 승인 생략 설정으로 시작했습니다. CLI가 승인
                요청을 보내지 않으면 자동 수락할 항목도 없습니다.
              </p>
            )}
            {terminal.integration !== "ready" && (
              <p role="status">
                이 터미널은 승인 요청 연결을 사용할 수 없습니다.
              </p>
            )}
            {status?.detail && <p role="status">{status.detail}</p>}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <footer className="modal-footer">
            <button
              className="button ghost"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              닫기
            </button>
            <button
              className="button primary"
              disabled={busy || (!enabled && terminal.integration !== "ready")}
              onClick={() => void change(!enabled)}
            >
              {busy
                ? "적용 중…"
                : enabled
                  ? "이 세션 자동 수락 끄기"
                  : "이 세션 자동 수락 켜기"}
            </button>
          </footer>
        </Modal>
      )}
    </>
  );
}
