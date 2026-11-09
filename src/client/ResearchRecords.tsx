import { useState } from "react";
import type { AppState } from "../shared/types";
import { researchStatusLabel } from "../shared/research";
import { api } from "./api";
import { Modal } from "./Dialogs";

export function DeleteResearchDialog({
  state,
  ids,
  onClose,
  onRemoved,
}: {
  state: AppState;
  ids: string[];
  onClose(): void;
  onRemoved(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const labs = (state.researchLabs || []).filter((lab) => ids.includes(lab.id));
  const liveWork = labs.flatMap((lab) =>
    lab.works
      .filter((work) => {
        const owner = lab.participants[work.participant];
        return (
          work.status === "running" &&
          state.terminals.some(
            (terminal) => terminal.id === owner?.terminalId && !terminal.exited,
          )
        );
      })
      .map((work) => `${lab.title} · ${work.title}`),
  );
  return (
    <Modal
      title="연구실 기록 삭제"
      subtitle={`${ids.length}개 연구실의 기록을 정리합니다.`}
      onClose={() => !busy && onClose()}
    >
      <div className="research-records-dialog">
        <ul className="research-records-targets">
          {labs.map((lab) => (
            <li key={lab.id}>
              <b>{lab.title}</b>
              <small>{researchStatusLabel[lab.status]}</small>
            </li>
          ))}
        </ul>
        <p>
          선택한 연구실의 계획·토론·실험 기록과 관련 Harbor 메시지를 삭제합니다.
          삭제한 기록은 복구할 수 없습니다.
        </p>
        <p>
          열려 있는 터미널, Codex·Claude 자체 대화 기록, 프로젝트 파일과 내보낸
          결과 문서는 보존합니다. 같은 대화를 새 연구실에 참여시킬 수 있습니다.
        </p>
        {labs.some(
          (lab) => lab.status !== "completed" && lab.status !== "preparing",
        ) && (
          <p className="research-attention">
            새 과제 전달은 멈춥니다. 이미 AI에게 전달된 과제와 실행 중인 명령은
            자동으로 종료되지 않으므로 필요한 경우 터미널에서 중단하세요.
          </p>
        )}
        {!!liveWork.length && (
          <div className="research-attention" role="alert">
            <b>실행 중으로 등록된 작업이 있습니다.</b>
            <ul>
              {liveWork.map((title, index) => (
                <li key={index}>{title}</li>
              ))}
            </ul>
            작업 결과를 등록하거나 해당 터미널에서 작업을 중단하고 터미널을 닫은
            뒤 삭제하세요. 등록된 자원 예약을 먼저 해제하지 않도록 삭제를
            보류합니다.
          </div>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="research-records-actions">
          <button disabled={busy} onClick={onClose}>
            취소
          </button>
          <button
            className="danger"
            disabled={busy || !!liveWork.length}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await api("/research", { ids }, "DELETE");
                onRemoved();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy
              ? "삭제 중…"
              : ids.length > 1
                ? "전체 기록 삭제"
                : "기록 삭제"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
