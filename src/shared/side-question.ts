import type { TerminalInfo } from "./types.js";
import type { AgentProvider } from "./agent-provider.js";
import { providerName } from "./agent-provider.js";

export interface SideMessage {
  role: "user" | "assistant";
  text: string;
}
export interface SideBinding {
  hostId: string;
  provider: AgentProvider;
  sessionId: string;
  cwd: string;
}
export interface SideReply {
  text: string;
  model?: string;
  effort?: string;
  context: boolean;
}
export function sideBinding(t: TerminalInfo): SideBinding | undefined {
  if (t.exited || t.connectionState !== "connected") return;
  const provider =
    t.agentKind ||
    (t.program === "antigravity-cli" ? "antigravity" : undefined);
  if (!provider) return;
  return {
    hostId: t.hostId,
    provider,
    sessionId: t.agentSessionId || t.resumeThreadId || "",
    cwd: t.cwd,
  };
}
export function sideTranscript(
  messages: SideMessage[],
  provider: AgentProvider,
) {
  return messages
    .map(
      (m) =>
        (m.role === "user" ? "나" : providerName(provider)) + "\n" + m.text,
    )
    .join("\n\n");
}
export function validateSidePaste(text: string) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text))
    throw Error("터미널 제어 문자가 포함되어 입력하지 않았습니다.");
  if (text.length > 63000)
    throw Error("터미널의 한 번 붙여넣기 한도를 초과했습니다.");
}
