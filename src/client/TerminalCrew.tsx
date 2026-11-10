import { memo, useEffect, useId, useState, type CSSProperties } from "react";
import { Settings2 } from "lucide-react";
import { CrewCharacter, type CrewCharacterKind } from "./CrewCharacter";
import type {
  TerminalAgentState,
  TerminalCrewSnapshot,
} from "../shared/terminal-agents";
import "./terminal-crew.css";

type Preferences = {
  character: "auto" | CrewCharacterKind;
  scale: number;
  motion: boolean;
};
const initial: Preferences = { character: "auto", scale: 100, motion: true };
const key = "harbor.crewAppearance";
function saved(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return {
      character: ["auto", "cat", "robot", "fox"].includes(value?.character)
        ? value.character
        : "auto",
      scale: Number.isFinite(value?.scale)
        ? Math.max(70, Math.min(150, value.scale))
        : 100,
      motion: value?.motion !== false,
    };
  } catch {
    return initial;
  }
}
const status: Record<TerminalAgentState, string> = {
  working: "작업 중",
  waiting: "입력 대기",
  idle: "대기",
  completed: "완료",
  failed: "실패",
  stopped: "중단",
  unknown: "상태 미확인",
};
const caption: Record<TerminalAgentState, string> = {
  working: "열심히 작업하고 있어요",
  waiting: "확인이나 입력을 기다려요",
  idle: "다음 요청을 기다리고 있어요",
  completed: "작업을 마쳤어요",
  failed: "작업 내용을 확인해 주세요",
  stopped: "작업이 멈췄어요",
  unknown: "연결 상태를 확인하고 있어요",
};

export const TerminalCrew = memo(function TerminalCrew({
  provider,
  state,
  active,
  crew,
  unavailable = false,
}: {
  provider: "claude" | "codex";
  state: TerminalAgentState;
  active: boolean;
  crew?: TerminalCrewSnapshot;
  unavailable?: boolean;
}) {
  const [preferences, setPreferences] = useState(saved);
  const [settings, setSettings] = useState(false);
  const [visible, setVisible] = useState(
    () => document.visibilityState !== "hidden",
  );
  const settingsId = useId();
  useEffect(() => {
    const visibility = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  const change = (next: Partial<Preferences>) => {
    setPreferences((previous) => {
      const value = { ...previous, ...next };
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* Appearance still works. */
      }
      return value;
    });
  };
  const character =
    preferences.character === "auto"
      ? provider === "claude"
        ? "cat"
        : "robot"
      : preferences.character;
  const agents = crew?.agents || [];
  const running = agents.filter(
    (agent) => agent.state === "working" || agent.state === "waiting",
  );
  const finished = agents.filter(
    (agent) => agent.state !== "working" && agent.state !== "waiting",
  );
  // Codex delivers state transitions; Claude sends a periodic native snapshot.
  const live =
    !unavailable &&
    crew?.source === "native" &&
    (provider === "codex" || Date.now() - crew.updatedAt < 30000);
  const row = (agent: (typeof agents)[number]) => (
    <div
      className="crew-agent"
      key={agent.id}
      data-state={agent.state}
      data-motion={live ? "on" : "off"}
    >
      <CrewCharacter character={character} state={agent.state} miniature />
      <div className="crew-agent-name">
        <strong title={agent.name}>{agent.name}</strong>
        {agent.model && <span title={agent.model}>{agent.model}</span>}
      </div>
      <span className="crew-state">{status[agent.state]}</span>
    </div>
  );
  return (
    <section
      className="terminal-crew"
      aria-label="에이전트 활동"
      data-motion={active && visible && preferences.motion ? "on" : "off"}
      style={{ "--crew-scale": preferences.scale / 100 } as CSSProperties}
    >
      <div className="crew-heading">
        <span>
          에이전트{" "}
          <small>{agents.length ? `메인 + ${agents.length}` : "메인"}</small>
        </span>
        <button
          type="button"
          aria-label="캐릭터 설정"
          aria-expanded={settings}
          aria-controls={settingsId}
          title="캐릭터 · 크기 · 애니메이션"
          onClick={() => setSettings((value) => !value)}
        >
          <Settings2 size={15} />
        </button>
      </div>
      {settings && (
        <div id={settingsId} className="crew-settings">
          <div
            role="group"
            aria-label="캐릭터 선택"
            className="crew-character-options"
          >
            {(
              [
                ["auto", "자동"],
                ["cat", "고양이"],
                ["robot", "로봇"],
                ["fox", "여우"],
              ] as const
            ).map(([value, title]) => (
              <button
                type="button"
                key={value}
                aria-pressed={preferences.character === value}
                onClick={() => change({ character: value })}
              >
                {title}
              </button>
            ))}
          </div>
          <label className="crew-scale-label">
            캐릭터 크기 <output>{preferences.scale}%</output>
            <input
              aria-label="캐릭터 크기"
              type="range"
              min={70}
              max={150}
              step={5}
              value={preferences.scale}
              onChange={(event) =>
                change({ scale: Number(event.target.value) })
              }
            />
          </label>
          <label className="crew-motion-label">
            <input
              type="checkbox"
              checked={preferences.motion}
              onChange={(event) => change({ motion: event.target.checked })}
            />
            애니메이션
          </label>
        </div>
      )}
      <div className="crew-main" data-state={state}>
        <div className="crew-stage">
          <CrewCharacter character={character} state={state} />
        </div>
        <div className="crew-main-caption">
          <span className="crew-state">
            <i />
            {status[state]}
          </span>
          <span>{caption[state]}</span>
        </div>
      </div>
      {running.length > 0 && (
        <div className="crew-agent-list">{running.map(row)}</div>
      )}
      {finished.length > 0 && (
        <details className="crew-finished">
          <summary>
            이전 에이전트 {finished.length}개{!live ? " · 최근 기록" : ""}
          </summary>
          <div className="crew-agent-list">{finished.map(row)}</div>
        </details>
      )}
      {agents.length > 0 && !live && (
        <p className="crew-history-note">
          마지막으로 확인한 에이전트 상태입니다.
        </p>
      )}
    </section>
  );
});
