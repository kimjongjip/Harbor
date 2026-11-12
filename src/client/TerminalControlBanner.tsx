import { createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { Eye, Keyboard, LoaderCircle } from "lucide-react";
import "./terminal-control.css";

export const TerminalControlToolbar = createContext<{
  target: HTMLDivElement | null;
  terminalId: string;
} | null>(null);

export function TerminalControlBanner({
  id,
  readOnly,
  checking = false,
  busy = false,
  owner,
  error,
  onClaim,
}: {
  id: string;
  readOnly: boolean;
  checking?: boolean;
  busy?: boolean;
  owner?: string;
  error?: string;
  onClaim(): void;
}) {
  const toolbar = useContext(TerminalControlToolbar);
  if (toolbar && (!toolbar.target || toolbar.terminalId !== id)) return null;
  const Icon = checking || busy ? LoaderCircle : readOnly ? Eye : Keyboard;
  const description =
    error ||
    (readOnly
      ? owner
        ? `${owner}에서 입력 중`
        : "제어권을 가져오면 입력할 수 있습니다"
      : "키보드 입력을 이 세션으로 보냅니다");
  const status = (
    <div
      className={`terminal-control-bar ${readOnly ? "viewing" : "controlling"}${toolbar ? " in-toolbar" : ""}`}
      role="status"
      aria-label="터미널 제어 상태"
      data-control-mode={checking ? "checking" : readOnly ? "view" : "control"}
      data-control-terminal={id}
      title={description}
    >
      <strong className="terminal-control-mode">
        <Icon size={16} aria-hidden="true" />
        {checking
          ? "제어 상태 확인 중"
          : readOnly
            ? "보기 전용"
            : "이 창에서 제어"}
      </strong>
      {(!toolbar || error || (readOnly && owner)) && (
        <span className="terminal-control-description">{description}</span>
      )}
      {readOnly && (
        <button type="button" disabled={busy} onClick={onClaim}>
          {busy ? "가져오는 중…" : "여기서 제어"}
        </button>
      )}
    </div>
  );
  return toolbar?.target ? createPortal(status, toolbar.target) : status;
}
