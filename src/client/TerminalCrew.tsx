import { providerName as agentLabel } from "../shared/agent-provider";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Settings2 } from "lucide-react";
import {
  CrewCharacter,
  crewCharacters,
  crewCharacterNames,
  type CrewCharacterKind,
} from "./CrewCharacter";
import { CrewAgentFacts, crewStatus as status } from "./CrewAgentFacts";
import { nativeAgentModels, type NativeCrewFooter } from "./native-crew-footer";
import { CrewDemo } from "./CrewDemo";
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
      character: ["auto", ...crewCharacters].includes(value?.character)
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
const caption: Record<TerminalAgentState, string> = {
  working: "열심히 작업하고 있어요",
  waiting: "확인이나 입력을 기다려요",
  idle: "커피 한 잔 하며 기다리고 있어요",
  completed: "작업을 마쳤어요",
  failed: "작업 내용을 확인해 주세요",
  stopped: "작업이 멈췄어요",
  unknown: "연결 상태를 확인하고 있어요",
};

export const TerminalCrew = memo(function TerminalCrew({
  provider,
  mainModel,
  state,
  active,
  crew,
  nativeCrew,
  unavailable = false,
}: {
  provider: import("../shared/agent-provider").AgentProvider;
  mainModel?: string;
  state: TerminalAgentState;
  active: boolean;
  crew?: TerminalCrewSnapshot;
  nativeCrew?: NativeCrewFooter;
  unavailable?: boolean;
}) {
  const [preferences, setPreferences] = useState(saved);
  const [settings, setSettings] = useState(false);
  const [demo, setDemo] = useState(false);
  const closeDemo = useCallback(() => setDemo(false), []);
  useEffect(() => {
    if (!active) setDemo(false);
  }, [active]);
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
  const nativeModels = nativeAgentModels(nativeCrew?.agents || [], crew?.source === "native" && !unavailable ? agents : []);
  // Codex delivers state transitions; Claude sends a periodic native snapshot.
  const live =
    !unavailable &&
    crew?.source === "native" &&
    (provider === "codex" || Date.now() - crew.updatedAt < 30000);
  const previous = useRef({
    live: false,
    states: new Map<string, TerminalAgentState>(),
  });
  const [celebrations, setCelebrations] = useState<Record<string, number>>({});
  useEffect(() => {
    const now = Date.now(),
      current = crew?.agents || [];
    const completed = previous.current.live
      ? current.filter(
          (agent) =>
            agent.state === "completed" &&
            ["working", "waiting", "idle"].includes(
              previous.current.states.get(agent.id) || "",
            ),
        )
      : [];
    previous.current = {
      live: active && !!live,
      states: new Map(current.map((agent) => [agent.id, agent.state])),
    };
    setCelebrations((existing) => {
      const next: Record<string, number> = {};
      if (active && live) {
        for (const agent of current)
          if (agent.state === "completed" && existing[agent.id] > now)
            next[agent.id] = existing[agent.id];
        for (const agent of completed) next[agent.id] = now + 12000;
      }
      return JSON.stringify(existing) === JSON.stringify(next)
        ? existing
        : next;
    });
  }, [crew, active, live]);
  useEffect(() => {
    const deadlines = Object.values(celebrations);
    if (!active || !deadlines.length) return;
    const timer = setTimeout(
      () =>
        setCelebrations((current) =>
          Object.fromEntries(
            Object.entries(current).filter(([, until]) => until > Date.now()),
          ),
        ),
      Math.max(1, Math.min(...deadlines) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [celebrations, active]);
  const onStage = (agent: (typeof agents)[number]) =>
    ["working", "waiting", "idle"].includes(agent.state) ||
    (live && !!celebrations[agent.id]);
  const running = agents.filter(onStage),
    finished = agents.filter((agent) => !onStage(agent));
  const colleague = (index: number) => preferences.character === "auto" ? crewCharacters[index % crewCharacters.length] : character;
  const row = (agent: (typeof agents)[number], index: number) => {
    const title =
      agent.task ||
      (/^(?:general[\s_-]*purpose|agent|에이전트)$/i.test(agent.name.trim())
        ? "작업 설명 수신 대기"
        : agent.name);
    const metadata = [
      agent.name !== title ? agent.name : undefined,
      agent.model || "모델 미확인",
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <div
        className="crew-agent"
        key={agent.id}
        data-state={agent.state}
        data-agent-id={agent.id}
        data-recent-completion={!!celebrations[agent.id] || undefined}
        data-motion={
          live && (agent.state !== "completed" || !!celebrations[agent.id])
            ? "on"
            : "off"
        }
      >
        <CrewCharacter character={colleague(index)} state={agent.state} activity={agent.activity || agent.task} miniature />
        <div className="crew-agent-name">
          <strong className="crew-agent-title" title={title}>
            {title}
          </strong>
          {metadata && <span title={metadata}>{metadata}</span>}
          <CrewAgentFacts agent={agent} showTask={false} sampledAt={crew?.source === "native" && live ? Date.now() : crew?.updatedAt} />
        </div>
        <span className="crew-state">{status[agent.state]}</span>
      </div>
    );
  };
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
          <small>{(nativeCrew?.agents.length || agents.length) ? `메인 + ${nativeCrew?.agents.length || agents.length}` : "메인"}</small>
        </span>
        <div className="crew-heading-actions">
          <button
            type="button"
            className="crew-demo-button"
            onClick={() => setDemo(true)}
          >
            데모
          </button>
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
      </div>
      {settings && (
        <div id={settingsId} className="crew-settings">
          <p className="crew-setting-hint">
            자동은 다양한 동료를 보여줘요. 직접 고르면 모두 같은 캐릭터를 써요.
          </p>
          <div
            role="group"
            aria-label="캐릭터 선택"
            className="crew-character-options"
          >
            {(
              [
                ["auto", "자동"],
                ...crewCharacters.map(
                  (value) => [value, crewCharacterNames[value]] as const,
                ),
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
        <div className="crew-leader-label">메인 · {agentLabel(provider)}{mainModel ? " · " + mainModel : ""}</div>
        <div className="crew-stage">
          <CrewCharacter character={character} state={state} leader />
        </div>
        <div className="crew-main-caption">
          <span className="crew-state">
            <i />
            {status[state]}
          </span>
          <span>{caption[state]}</span>
        </div>
      </div>
      {nativeCrew?.taskCount !== undefined && <div className="crew-native-count crew-task-station">
        {nativeCrew.taskCount > 0 && <CrewCharacter character={character} state="working" activity="run" miniature />}
        <span>작업 {nativeCrew.taskCount}개 · /tasks</span>
      </div>}
      {!!nativeCrew?.agents.length && <div className="crew-agent-list">
        {nativeCrew.agents.map((agent, index) => <div className="crew-native-row" key={agent.name + index}>
          <CrewCharacter character={colleague(index)} state="working" activity={agent.task} miniature />
          <strong title={agent.name + " · " + agent.task}>{agent.task}</strong>
          <span className="crew-native-model" title={nativeModels[index]}>{nativeModels[index] || "모델 미확인"}</span>
          <div className="crew-native-metrics"><span title="CLI에 표시된 작업 경과 시간">{agent.elapsed}</span>
            <span title="Claude가 해당 작업 행에 표시한 토큰 수">↓ {agent.tokens} 토큰</span></div>
        </div>)}
      </div>}
      {!!nativeCrew?.agents.length && nativeModels.some(m => !m) && agents.some(a=>a.state==="working" && a.model) &&
        <details className="crew-finished"><summary>에이전트별 모델</summary>
          {agents.filter(a=>a.state==="working" && a.model).map(a=><div key={a.id}>{a.task || a.name} · {a.model}</div>)}
        </details>}
      {!nativeCrew?.agents.length && running.length > 0 && (
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
      {demo && active && (
        <CrewDemo
          onClose={closeDemo}
          motion={preferences.motion}
          character={character}
        />
      )}
    </section>
  );
});
