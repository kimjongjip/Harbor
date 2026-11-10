import { memo } from "react";
import type {
  TerminalAgent,
  TerminalAgentState,
} from "../shared/terminal-agents";
import { compactTokens } from "../shared/terminal-usage";

export const crewStatus: Record<TerminalAgentState, string> = {
  working: "작업 중",
  waiting: "입력 대기",
  idle: "대기",
  completed: "완료",
  failed: "실패",
  stopped: "중단",
  unknown: "상태 미확인",
};
const tools: Record<string, string> = {
  Read: "파일 읽기",
  Edit: "파일 수정",
  Write: "파일 쓰기",
  Bash: "명령 실행",
  Grep: "코드 검색",
  Glob: "파일 검색",
  WebSearch: "자료 검색",
  WebFetch: "웹 문서 읽기",
};

export const CrewAgentFacts = memo(function CrewAgentFacts({
  agent,
  showTask = true,
}: {
  agent: TerminalAgent;
  showTask?: boolean;
}) {
  const tokens = agent.tokens;
  const detail = tokens
    ? [
        tokens.scope === "observed"
          ? "연결 이후 관측한 응답의 누적 토큰입니다."
          : "이 에이전트가 보고한 누적 토큰입니다.",
        "현재 컨텍스트 크기와는 별도입니다.",
        `전체 ${tokens.total.toLocaleString()}`,
        tokens.input !== undefined
          ? `입력 ${tokens.input.toLocaleString()} (캐시 포함)`
          : "",
        tokens.output !== undefined
          ? `출력 ${tokens.output.toLocaleString()}`
          : "",
        tokens.cached !== undefined
          ? `캐시 읽기 ${tokens.cached.toLocaleString()} (입력에 포함)`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "CLI가 이 에이전트의 사용량을 아직 제공하지 않았습니다.";
  return (
    <div className="crew-agent-facts">
      {showTask && (
        <p className="crew-agent-task" title={agent.task}>
          {agent.task || "작업 설명 수신 대기"}
        </p>
      )}
      {agent.activity && agent.state === "working" && (
        <span className="crew-agent-activity" title={agent.activity}>
          {tools[agent.activity] || agent.activity}
        </span>
      )}
      <span
        className={`crew-agent-tokens${tokens ? "" : " pending"}`}
        title={detail}
      >
        {tokens ? (
          <>
            {tokens.scope === "observed" ? "관측 누적" : "누적"}{" "}
            <strong>{compactTokens(tokens.total)}</strong> 토큰
          </>
        ) : (
          "토큰 수신 대기"
        )}
      </span>
    </div>
  );
});
