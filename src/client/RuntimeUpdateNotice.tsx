import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Modal } from "./Dialogs";
import "./runtime-update.css";

export default function RuntimeUpdateNotice({
  ready,
  optimized,
}: {
  ready: boolean;
  optimized: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!ready || optimized) return null;
  return (
    <>
      <button
        className="runtime-update-badge"
        aria-label="터미널 업데이트 적용 안내"
        title="화면 복원과 입력 개선을 적용하려면 작업 후 Harbor를 다시 실행하세요."
        onClick={() => setOpen(true)}
      >
        <RefreshCw size={13} />
        <span>재실행 필요</span>
      </button>
      {open && (
        <Modal title="터미널 업데이트 적용" onClose={() => setOpen(false)}>
          <div className="modal-body runtime-update-body">
            <p>
              화면 복원과 긴 세션의 입력 지연 개선이 준비되어 있습니다. 화면
              새로고침만으로는 실행 중인 서버에 이 수정이 적용되지 않습니다.
            </p>
            <p>
              진행 중인 작업을 마친 뒤{" "}
              <strong>
                Harbor 창을 모두 닫고 바탕화면의 Harbor를 다시 열어주세요.
              </strong>
            </p>
            <p>
              앱을 종료하면 열린 터미널도 종료됩니다. 이 안내를 확인하는
              동안에는 현재 작업을 그대로 유지합니다.
            </p>
            <p>
              별도로 웹 서버를 실행했다면 해당 Harbor 서버를 종료하고 다시
              실행하세요.
            </p>
          </div>
          <footer className="modal-footer">
            <button className="button primary" onClick={() => setOpen(false)}>
              확인
            </button>
          </footer>
        </Modal>
      )}
    </>
  );
}
