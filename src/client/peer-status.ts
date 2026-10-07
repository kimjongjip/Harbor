import type { MailboxMessage, MailboxParticipant } from "../shared/mailbox";
import type { TerminalInfo } from "../shared/types";

export function peerName(peer: MailboxParticipant) {
  return peer.agentKind === "claude"
    ? "Claude"
    : peer.agentKind === "codex"
      ? "Codex"
      : "AI";
}

export function messageDelivery(
  message: MailboxMessage,
  terminals: TerminalInfo[],
) {
  if (message.repliedAt) return "답장 도착";
  if (message.status === "consumed") return "AI 확인";
  if (message.recipient.kind === "user") return "받음";
  const recipient = terminals.find(
    (t) => t.id === message.recipient.terminalId,
  );
  if (!recipient || recipient.exited) return "세션 종료 · 확인 대기";
  if (
    message.recipient.sessionId &&
    recipient.agentSessionId !== message.recipient.sessionId
  )
    return "원래 대화 연결 대기";
  if (message.offeredAt) return "CLI 알림 전달 · AI 확인 대기";
  if (!recipient.agentConnected) return "CLI 연결 대기";
  return recipient.peerDelivery === "automatic"
    ? "자동 수신 대기"
    : "받은함 대기";
}

export function peerConnection(terminal: TerminalInfo) {
  if (terminal.exited) return "종료";
  if (!terminal.agentConnected) return "CLI 실행 대기";
  if (terminal.peerDelivery === "automatic")
    return terminal.agentKind === "claude" ? "채널 수신 요청" : "자동 수신";
  if (terminal.peerDelivery === "unavailable") return "자동 수신 불가 · 받은함";
  return "받은함 확인 필요";
}
