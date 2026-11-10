import { useEffect, useState } from "react";
import { Modal } from "./Dialogs";
import {
  CrewCharacter,
  crewCharacters,
  crewCharacterNames,
  type CrewCharacterKind,
} from "./CrewCharacter";
import { CrewAgentFacts, crewStatus } from "./CrewAgentFacts";
import type {
  TerminalAgent,
  TerminalAgentState,
} from "../shared/terminal-agents";

const jobs = [
  "전체 작업을 나누고 결과를 모아요",
  "프롬프트 입력 지연을 분석해요",
  "테스트를 실행하고 결과를 확인해요",
  "에이전트 상태 연결을 검토해요",
  "캐릭터의 움직임을 다듬어요",
  "작업 설명과 토큰 표시를 정리해요",
  "좁은 IDE 화면을 확인해요",
  "변경 내용을 문서에 정리해요",
];
export function crewDemoFrame(
  frame: number,
): (TerminalAgent & { character: CrewCharacterKind; leader: boolean })[] {
  return (["human", ...crewCharacters] as CrewCharacterKind[]).map(
    (character, index) => {
      const tick = frame + index * 2,
        phase = tick % 12;
      const state: TerminalAgentState =
        phase < 6
          ? "working"
          : phase < 8
            ? "waiting"
            : phase < 10
              ? "completed"
              : "idle";
      const total =
        1200 +
        index * 1450 +
        (Math.floor(tick / 12) * 6 + Math.min(phase, 6)) * 210;
      const output = Math.floor(total / 5);
      return {
        id: `demo-${index}`,
        character,
        leader: index === 0,
        name:
          index === 0
            ? "메인 · 작업 조율"
            : `${crewCharacterNames[character]} 에이전트`,
        state,
        task: jobs[index],
        activity: ["코드 검토", "명령 실행", "파일 읽기"][index % 3],
        tokens: {
          total,
          input: total - output,
          output,
          cached: Math.floor(total / 4),
          scope: "session",
        },
      };
    },
  );
}

/** Pure local demo: no API calls, agents, conversations or usage writes. */
export function CrewDemo({
  onClose,
  motion,
}: {
  onClose: () => void;
  motion: boolean;
}) {
  const [frame, setFrame] = useState(0),
    [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(document.visibilityState !== "hidden");
  const [reduced, setReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const visibility = () => setVisible(document.visibilityState !== "hidden"),
      preference = () => setReduced(media.matches);
    document.addEventListener("visibilitychange", visibility);
    media.addEventListener("change", preference);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      media.removeEventListener("change", preference);
    };
  }, []);
  const playing = motion && visible && !paused && !reduced;
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setFrame((value) => value + 1), 2500);
    return () => clearInterval(timer);
  }, [playing]);
  const agents = crewDemoFrame(frame);
  return (
    <Modal
      title="Harbor Crew 미리보기"
      subtitle="캐릭터들이 함께 일하는 모습을 둘러보세요."
      onClose={onClose}
      wide
      isolateEvents
      backdropClassName="crew-demo-backdrop"
    >
      <div
        className="crew-demo"
        data-motion={playing ? "on" : "off"}
        data-frame={frame}
      >
        <div className="crew-demo-notice">
          <strong>DEMO</strong>
          <span>
            샘플 작업 · 가상 토큰
            <br />
            실제 에이전트 실행이나 토큰 사용 없이 재생됩니다.
          </span>
        </div>
        <div className="crew-demo-toolbar">
          <span>메인 + 7명 · 작업 / 대기 / 완료</span>
          <div>
            <button
              type="button"
              disabled={!motion || reduced}
              onClick={() => setPaused((value) => !value)}
            >
              {paused ? "재생" : "일시정지"}
            </button>
            <button
              type="button"
              onClick={() => setFrame((value) => value + 1)}
            >
              다음 장면
            </button>
            <button type="button" onClick={() => setFrame(0)}>
              처음부터
            </button>
          </div>
        </div>
        <div className="crew-demo-grid">
          {agents.map((agent) => (
            <article
              key={agent.id}
              className={`crew-demo-card${agent.leader ? " leader" : ""}`}
              data-state={agent.state}
            >
              <div className="crew-demo-card-heading">
                <strong>{agent.name}</strong>
                <span className="crew-state">{crewStatus[agent.state]}</span>
              </div>
              <CrewCharacter
                character={agent.character}
                state={agent.state}
                leader={agent.leader}
              />
              <CrewAgentFacts agent={agent} />
            </article>
          ))}
        </div>
        <p className="crew-demo-footnote">
          실제 화면에서도 같은 캐릭터가 CLI가 알려준 상태에 맞춰 움직입니다.
          커피를 마시는 동작은 대기 상태를 표현합니다.
        </p>
      </div>
    </Modal>
  );
}
