import { ArrowRight, Network, Terminal } from "lucide-react";
import type { AppState, TerminalInfo } from "../shared/types";
import { peerConnection } from "./peer-status";

export function connectionLabel(terminal: TerminalInfo) {
  return terminal.exited
    ? "종료"
    : terminal.agentConnected
      ? `${terminal.agentKind === "claude" ? "Claude" : "Codex"} · ${peerConnection(terminal)}`
      : terminal.integration === "ready"
        ? "셸 · AI 실행 대기"
        : "셸만 연결";
}
export default function ConnectionOverview({
  state,
  terminal,
  onMessages,
}: {
  state: AppState;
  terminal?: TerminalInfo;
  onMessages: () => void;
}) {
  const host = state.hosts.find((h) => h.id === terminal?.hostId);
  const peers = state.terminals.filter((t) => t.agentConnected && !t.exited);
  const status = state.connections?.find((c) => c.terminalId === terminal?.id);
  return (
    <section className="connection-overview" aria-label="세션 연결 상태">
      <div className="connection-overview-title">
        <Network size={13} />
        <b>세션 연결</b>
        <span>{peers.length}개 AI</span>
      </div>
      {terminal && host ? (
        <>
          <div className="connection-route">
            <span className="live">Harbor</span>
            <ArrowRight size={12} />
            <span className={!terminal.exited ? "live" : ""}>
              {host.kind === "ssh" ? "SSH" : "로컬"}
            </span>
            <ArrowRight size={12} />
            <span
              className={
                terminal.agentConnected && !terminal.exited ? "live" : ""
              }
            >
              {terminal.agentConnected
                ? terminal.agentKind === "claude"
                  ? "Claude"
                  : "Codex"
                : "셸"}
            </span>
          </div>
          <p>
            {terminal.exited
              ? "종료된 세션입니다."
              : terminal.agentConnected
                ? `${host.name}의 ${terminal.title} 연결됨`
                : terminal.integration === "ready"
                  ? "AI 연결 대기 · CLI를 실행하면 작업 상태가 표시됩니다."
                  : "일반 셸 연결입니다. 세션 메시지 연결은 사용할 수 없습니다."}
          </p>
          {terminal.agentConnected && !terminal.exited && (
            <button className="connection-message-link" onClick={onMessages}>
              세션 간 메시지
              {status?.pendingMessages
                ? ` · 받은함 ${status.pendingMessages}`
                : ""}
              <ArrowRight size={12} />
            </button>
          )}
        </>
      ) : (
        <p>
          <Terminal size={13} />
          서버에 연결하고 터미널에서 codex 또는 claude를 실행하세요.
        </p>
      )}
      <details>
        <summary>세션끼리는 어떻게 연결되나요?</summary>
        <p>
          각 서버의 Codex·Claude가 이 PC의 Harbor에 연결됩니다. 같은 서버와 다른
          서버 모두 세션 이름으로 메시지를 주고받습니다.
        </p>
        <p>
          “리뷰 세션에 왜 이렇게 구현했는지 물어보고 답을 반영해줘”처럼
          요청하세요. 상대의 이름은 터미널 이름 변경 버튼으로 정할 수 있습니다.
        </p>
        <small>
          {terminal?.peerDetail ||
            (terminal?.peerDelivery === "automatic"
              ? "자동 수신 연결을 사용합니다. 알림 전달과 AI의 실제 확인·답변은 받은함에서 구분됩니다."
              : "받은함 연결입니다. 상대 세션에서 ‘받은 메시지 확인해줘’라고 요청하면 메시지를 읽습니다.")}
        </small>
      </details>
    </section>
  );
}
