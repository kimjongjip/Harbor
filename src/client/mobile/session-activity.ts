import type { TerminalInfo } from "../../shared/types";

export function mobileActivity(
  t: TerminalInfo,
  pending: boolean,
  nativeWorking: boolean,
) {
  if (t.exited) return "closed";
  if (t.connectionState !== "connected") return "disconnected";
  if (pending || t.agentState === "waiting") return "waiting";
  if (t.agentState === "working" || (t.agentKind === "codex" && nativeWorking))
    return "working";
  if (t.agentKind && !t.agentState) return "unknown";
  return "ready";
}
export const activityLabel = {
  closed: "종료됨",
  disconnected: "연결 확인 필요",
  waiting: "확인 필요",
  working: "작업 중",
  unknown: "상태 확인 중",
  ready: "입력 대기",
} as const;
