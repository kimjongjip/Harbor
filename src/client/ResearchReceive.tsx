import { useEffect, useState } from "react";
import type { AppState } from "../shared/types";
import type { ResearchLabView } from "../shared/research";
import { insertTerminalDraft } from "./terminalDraft";
import { writeLocalClipboard } from "./terminalSelection";

export function ResearchReceive({
  lab,
  participant: p,
  state,
  onOpen,
}: {
  lab: ResearchLabView;
  participant: ResearchLabView["participants"][number];
  state: AppState;
  onOpen(id: string): void;
}) {
  const [notice, setNotice] = useState("");
  const [inserted, setInserted] = useState("");
  const pending = (state.mailbox || []).filter(
    (m) =>
      m.recipient.terminalId === p.terminalId &&
      m.recipient.sessionId === p.sessionId &&
      (m.research?.labId === lab.id || m.labId === lab.id) &&
      !m.consumedAt,
  );
  const key = pending
    .map((m) => m.id)
    .sort()
    .join(",");
  const prompt = `Harbor 연구실 ${JSON.stringify(lab.id)}의 harbor_lab_context와 harbor_inbox를 확인하고 현재 배정과 받은 질문을 처리해줘. 같은 대화에서 이어가고 네이티브 실행 승인은 유지해줘.`;
  useEffect(() => {
    setNotice("");
    setInserted("");
  }, [lab.id, p.sessionId]);
  const active = ["running", "connecting"].includes(lab.status);
  return (
    <div className="research-attention" role="status">
      <b>
        {p.name} ·{" "}
        {p.connection === "boundary"
          ? "기존 대화에서 수신"
          : "받은함 확인 필요"}
      </b>
      <p>
        {p.connection === "boundary"
          ? "Claude를 종료할 필요가 없습니다. 다음 입력·도구 완료·응답 완료 때 과제와 질문을 전달합니다. 이미 입력 대기 중이면 아래 확인 요청을 한 번 보내세요."
          : "이 대화는 즉시 자동 수신이 연결되지 않았습니다. 원래 입력칸에서 받은함 확인을 요청할 수 있습니다."}
      </p>
      {!!pending.length && active && (
        <div className="research-controls">
          <button
            type="button"
            disabled={
              p.activity === "working" || !p.sessionId || inserted === key
            }
            onClick={async () => {
              try {
                onOpen(p.terminalId);
                await new Promise<void>((done) =>
                  requestAnimationFrame(() => done()),
                );
                insertTerminalDraft({
                  terminalId: p.terminalId,
                  sessionId: p.sessionId || "",
                  text: prompt,
                });
                setInserted(key);
                setNotice(
                  "원래 입력칸에 확인 요청을 추가했습니다. 기존 입력을 확인하고 Enter로 보내세요. 자동 전송하지 않습니다.",
                );
              } catch (e) {
                setNotice(
                  `${(e as Error).message} ‘확인 요청 복사’로 직접 붙여넣을 수 있습니다.`,
                );
              }
            }}
          >
            {inserted === key
              ? "입력에 추가됨 · Enter로 전송"
              : "받은 과제 확인 요청"}
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                await writeLocalClipboard(prompt);
                setNotice(
                  "확인 요청을 복사했습니다. 원래 대화에 붙여넣고 Enter로 보내세요.",
                );
              } catch (e) {
                setNotice((e as Error).message);
              }
            }}
          >
            확인 요청 복사
          </button>
        </div>
      )}
      {notice && <p>{notice}</p>}
      <button type="button" onClick={() => onOpen(p.terminalId)}>
        해당 {p.kind === "claude" ? "Claude" : "Codex"} 터미널 열기
      </button>
      {p.kind === "claude" && (
        <details>
          <summary>입력 대기 중에도 즉시 받으려면</summary>
          <p>
            다음에 Claude를 실행할 때 채널을 요청할 수 있습니다. 이미 켜진
            대화에 이 시작 옵션을 추가할 수는 없습니다. 기존 대화의 훅 수신은
            재실행 없이 사용할 수 있습니다.
          </p>
          <code>
            {p.sessionId && /^[a-zA-Z0-9_-]{8,128}$/.test(p.sessionId)
              ? `claude --harbor-peers --resume ${p.sessionId}`
              : "claude --harbor-peers --resume"}
          </code>
          <p>
            Claude CLI의 계정·조직 정책과 채널 허용 안내가 적용됩니다. 전달은
            실제 AI 확인·결과 제출과 별도로 표시합니다.
          </p>
        </details>
      )}
    </div>
  );
}
