import { useState } from "react";
import { Modal } from "./Dialogs";
import { api } from "./api";
import type { TerminalInfo } from "../shared/types";

export function ReconnectTerminalDialog({
  terminal,
  onClose,
}: {
  terminal: TerminalInfo;
  onClose(): void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(terminal.disconnectReason || "");
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="서버 세션 다시 연결"
      subtitle={`${terminal.title}의 실행 중인 작업에 다시 연결합니다.`}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api(`/terminals/${terminal.id}/reconnect`, {
              ...(password ? { password } : {}),
            });
            setPassword("");
            onClose();
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          <label>
            SSH 비밀번호
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
            />
          </label>
          <p className="helper">
            저장된 인증이나 SSH 키를 사용하려면 비워두세요.
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="modal-footer">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            닫기
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? "연결 중…" : "다시 연결"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
