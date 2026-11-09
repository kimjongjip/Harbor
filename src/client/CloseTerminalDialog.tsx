import { useState } from "react";
import type { TerminalInfo } from "../shared/types";
import { api } from "./api";
import { Modal } from "./Dialogs";

export default function CloseTerminalDialog({
  terminal,
  onClose,
  onError,
}: {
  terminal: TerminalInfo;
  onClose(): void;
  onError(message: string): void;
}) {
  const [closing, setClosing] = useState(false);
  return (
    <Modal
      title="터미널 종료"
      subtitle={`${terminal.title}의 셸과 실행 중인 프로그램을 종료합니다.`}
      onClose={() => !closing && onClose()}
    >
      <div className="modal-body">
        {terminal.persistent && (
          <p>
            서버의 tmux 세션과 그 안의 작업을 종료합니다. 작업을 유지하려면
            취소한 뒤 Harbor 앱만 종료하세요.
          </p>
        )}
        <p>Codex·Claude가 저장한 대화 기록과 프로젝트 파일은 유지됩니다.</p>
      </div>
      <footer className="modal-footer">
        <button
          className="button secondary"
          disabled={closing}
          onClick={onClose}
        >
          취소
        </button>
        <button
          className="button primary"
          disabled={closing}
          onClick={async () => {
            setClosing(true);
            try {
              await api(
                `/terminals/${encodeURIComponent(terminal.id)}/close`,
                {},
              );
              onClose();
            } catch (err) {
              onError((err as Error).message);
            } finally {
              setClosing(false);
            }
          }}
        >
          {closing ? "종료 중…" : "터미널 종료"}
        </button>
      </footer>
    </Modal>
  );
}
