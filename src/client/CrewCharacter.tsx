import { memo } from "react";
import type { TerminalAgentState } from "../shared/terminal-agents";

export const crewCharacters = [
  "cat",
  "robot",
  "fox",
  "human",
  "penguin",
  "dog",
  "frog",
] as const;
export type CrewCharacterKind = (typeof crewCharacters)[number];
export const crewCharacterNames: Record<CrewCharacterKind, string> = {
  cat: "고양이",
  robot: "로봇",
  fox: "여우",
  human: "남자",
  penguin: "펭귄",
  dog: "강아지",
  frog: "개구리",
};

/** Original SVG artwork; motion stays in CSS, independently of React and xterm. */
export const CrewCharacter = memo(function CrewCharacter({
  character,
  state,
  miniature = false,
  leader = false,
}: {
  character: CrewCharacterKind;
  state: TerminalAgentState;
  miniature?: boolean;
  leader?: boolean;
}) {
  return (
    <svg
      className={`crew-art crew-${character}${miniature ? " miniature" : ""}`}
      data-state={state}
      viewBox={miniature ? "20 6 130 110" : "0 0 200 126"}
      data-leader={leader || undefined}
      aria-hidden="true"
      focusable="false"
    >
      {!miniature && (
        <g className="crew-room">
          <rect
            className="crew-wall"
            x="1"
            y="1"
            width="198"
            height="124"
            rx="12"
          />
          <rect
            className="crew-window-frame"
            x="132"
            y="12"
            width="49"
            height="41"
            rx="5"
          />
          <rect
            className="crew-window"
            x="136"
            y="16"
            width="41"
            height="33"
            rx="2"
          />
          <circle className="crew-sun" cx="165" cy="26" r="6" />
          <path
            className="crew-cloud"
            d="M139 38h16v-3h-4v-3h-7v3h-5zM156 45h18v-3h-5v-3h-7v3h-6z"
          />
          <path d="M156 16v33M136 36h41" className="crew-window-grid" />
          <path className="crew-shelf" d="M18 25h28v4H18z" />
          <path fill="#9b8bce" d="M22 15h5v10h-5z" />
          <path fill="#dfb36d" d="M29 12h5v13h-5z" />
          <path fill="#8bb6ae" d="M36 17h5v8h-5z" />
          <ellipse className="crew-shadow" cx="100" cy="111" rx="77" ry="7" />
        </g>
      )}
      <g className="crew-body">
        {["cat", "fox", "dog"].includes(character) && (
          <path
            className="crew-tail"
            d={
              character === "fox"
                ? "M48 94C15 98 21 72 26 64L34 76 49 82Z"
                : "M45 91C24 94 24 79 31 75L35 80C30 83 33 88 45 85Z"
            }
          />
        )}
        <path
          className="crew-chair"
          d="M47 69h40v32H47zM51 101h6v10h-6zM79 101h6v10h-6z"
        />
        <path className="crew-shirt" d="M49 71h38v25H49z" />
        <path className="crew-shirt-light" d="M54 73h28v6H54z" />
        <rect
          className="crew-collar"
          x="63"
          y="73"
          width="10"
          height="4"
          rx="2"
        />
        {character === "robot" ? (
          <g>
            <path
              className="crew-metal-dark"
              d="M65 29h5v10h-5zM39 48h6v17h-6zM91 48h6v17h-6z"
            />
            <circle className="crew-antenna" cx="67.5" cy="28" r="4" />
            <rect
              className="crew-metal"
              x="44"
              y="38"
              width="48"
              height="36"
              rx="7"
            />
            <rect fill="#243e51" x="50" y="44" width="36" height="24" rx="5" />
            <path className="crew-metal-light" d="M49 40h33v3H49z" />
          </g>
        ) : character === "human" ? (
          <g>
            <path className="crew-hair" d="M45 49V39q0-13 23-13t23 13v10z" />
            <path className="crew-fur" d="M42 51h7v12h-7zM87 51h7v12h-7z" />
            <path
              className="crew-fur"
              d="M47 39h42v24l-6 10-7 4H60l-7-4-6-10z"
            />
            <path
              className="crew-hair"
              d="M46 49V35l9-7 14 2 8-5 13 10v17h-5V41l-7-4-12 7-14-3v8z"
            />
            <path className="crew-hair-shine" d="m54 34 11 2 11-5" />
            <path className="crew-human-brows" d="m54 49 9-1m10 0 9 1" />
            <path className="crew-human-jaw" d="m53 66 4 6 7 3h8l7-3 4-6" />
          </g>
        ) : character === "penguin" ? (
          <g>
            <path
              className="crew-fur"
              d="M44 55c0-36 48-36 48 0v11l-9 11H53l-9-11z"
            />
            <path
              className="crew-muzzle"
              d="M49 54c0-16 14-17 19-7 5-10 19-9 19 7v12l-8 9H57l-8-9z"
            />
            <path className="crew-penguin-belly" d="M57 78h22v17H57z" />
          </g>
        ) : character === "dog" ? (
          <g>
            <rect
              className="crew-fur"
              x="44"
              y="39"
              width="48"
              height="37"
              rx="14"
            />
            <path
              className="crew-dog-ear"
              d="M49 40Q34 36 35 61q0 13 10 8l7-21zM86 40q16-4 15 21 0 13-10 8l-8-21z"
            />
            <path
              className="crew-muzzle"
              d="M54 60q14-9 28 0v10l-8 6H62l-8-6z"
            />
          </g>
        ) : character === "frog" ? (
          <g>
            <rect
              className="crew-fur"
              x="43"
              y="46"
              width="50"
              height="29"
              rx="12"
            />
            <circle className="crew-fur" cx="58.5" cy="46" r="12" />
            <circle className="crew-fur" cx="77.5" cy="46" r="12" />
            <circle className="crew-frog-eye" cx="58.5" cy="48" r="8" />
            <circle className="crew-frog-eye" cx="77.5" cy="48" r="8" />
            <path className="crew-muzzle" d="M47 63q21-7 42 0v4q-21 17-42 0z" />
          </g>
        ) : (
          <g>
            <path
              className="crew-fur"
              d={
                character === "fox"
                  ? "M43 51 40 23 58 38H77L96 23 91 54v14L81 76H53L43 68Z"
                  : "M43 50V29l16 10h17l16-10v37l-8 9H52l-9-9Z"
              }
            />
            <path
              className="crew-ear"
              d={
                character === "fox"
                  ? "M46 32l2 14 8-5zM90 32l-3 14-8-5z"
                  : "M48 37v12l9-6zM87 37v12l-9-6z"
              }
            />
            <path
              className="crew-muzzle"
              d={
                character === "fox"
                  ? "M45 53l21 10 24-10-4 16-9 7H57l-9-7Z"
                  : "M51 61h12v-5h10v5h12v8l-6 6H57l-6-6Z"
              }
            />
            {character === "cat" && (
              <path
                className="crew-stripes"
                d="M61 40h4v9h-4zM69 40h4v9h-4zM44 54h7v3h-7zM85 54h7v3h-7z"
              />
            )}
          </g>
        )}
        <g className="crew-eyes">
          <rect
            x="56"
            y={character === "frog" ? 46 : 52}
            width="5"
            height="7"
            rx="2"
          />
          <rect
            x="75"
            y={character === "frog" ? 46 : 52}
            width="5"
            height="7"
            rx="2"
          />
          <path
            className="crew-eye-glint"
            transform={character === "frog" ? "translate(0 -6)" : undefined}
            d="M57 53h2v2h-2zM76 53h2v2h-2z"
          />
        </g>
        <path
          className="crew-happy-eyes"
          transform={character === "frog" ? "translate(0 -6)" : undefined}
          d="M55 56q4-7 8 0M74 56q4-7 8 0"
        />
        {character === "robot" ? (
          <path className="crew-robot-smile" d="M64 63h8" />
        ) : character === "penguin" ? (
          <path className="crew-beak" d="m61 63 7-4 8 4-8 6z" />
        ) : (
          <g>
            {character !== "frog" && (
              <path className="crew-nose" d="M65 62h6l-3 3z" />
            )}
            <path
              className="crew-smile"
              d={
                character === "frog"
                  ? "M55 64q13 11 26 0"
                  : character === "human"
                    ? "M62 66q6 6 12 0"
                    : "M62 66q3 4 6 0 3 4 6 0"
              }
            />
            <path className="crew-cheeks" d="M50 61h7v3h-7zM79 61h7v3h-7z" />
          </g>
        )}
        {leader && (
          <g className="crew-crown">
            <path d="m53 32-3-14 11 7 7-12 7 12 11-7-3 14z" />
            <path className="crew-crown-rim" d="M53 31h30v5H53z" />
            <path className="crew-crown-jewel" d="m68 24 3 4-3 4-3-4z" />
            <circle cx="50" cy="17" r="2" />
            <circle cx="68" cy="12" r="2" />
            <circle cx="86" cy="17" r="2" />
          </g>
        )}
      </g>
      <g className="crew-celebration">
        <g className="crew-cheer-arm crew-cheer-left">
          <path d="M48 84 34 69l-5-11" />
          <circle cx="28" cy="56" r="5" />
        </g>
        <g className="crew-cheer-arm crew-cheer-right">
          <path d="m87 84 14-15 6-11" />
          <circle cx="108" cy="56" r="5" />
        </g>
        <g className="crew-confetti">
          <path d="m29 24 2-6 2 6 6 2-6 2-2 6-2-6-6-2zM111 26l2-5 2 5 5 2-5 2-2 5-2-5-5-2z" />
          <path
            className="crew-confetti-blue"
            d="m44 13 3 5-3 5-3-5zM127 43l4 3-4 3-4-3z"
          />
        </g>
      </g>
      {miniature && (
        <g className="crew-mini-workstation">
          <rect
            className="crew-desk"
            x="34"
            y="98"
            width="105"
            height="6"
            rx="2"
          />
          <g className="crew-paw crew-paw-left">
            <rect x="70" y="87" width="14" height="8" rx="4" />
          </g>
          <g className="crew-paw crew-paw-right">
            <rect x="86" y="88" width="14" height="8" rx="4" />
          </g>
          <path fill="#c0cbd6" d="M77 95h55l6 3H74z" />
          <rect fill="#4d657a" x="96" y="67" width="42" height="29" rx="4" />
          <rect
            className="crew-screen"
            x="100"
            y="71"
            width="34"
            height="21"
            rx="2"
          />
          <g className="crew-code" fill="#9fd4bb">
            <path d="m104 75 4 3-4 3h3l4-3-4-3z" />
            <path
              className="crew-code-lines"
              d="M113 79h13v2h-13zM104 85h16v2h-16zM123 85h6v2h-6z"
            />
          </g>
        </g>
      )}
      {!miniature && (
        <g>
          <rect
            className="crew-desk"
            x="32"
            y="94"
            width="141"
            height="7"
            rx="2"
          />
          <path
            className="crew-desk-leg"
            d="M39 101h6v15h-6zM160 101h6v15h-6z"
          />
          <g className="crew-paw crew-paw-left">
            <rect x="72" y="85" width="14" height="8" rx="4" />
            <path d="M78 89v3M81 89v3" />
          </g>
          <g className="crew-paw crew-paw-right">
            <rect x="89" y="86" width="14" height="8" rx="4" />
            <path d="M95 90v3M98 90v3" />
          </g>
          <path fill="#c0cbd6" d="M78 91h47l7 3H76z" />
          <rect fill="#4d657a" x="98" y="61" width="42" height="32" rx="4" />
          <rect
            className="crew-screen"
            x="102"
            y="65"
            width="34"
            height="24"
            rx="2"
          />
          <g className="crew-code" fill="#9fd4bb">
            <path d="m106 70 3 3-3 3h2l3-3-3-3zM114 75h7v2h-7z" />
            <path
              className="crew-code-lines"
              d="M106 81h18v2h-18zM127 81h5v2h-5z"
            />
          </g>
          <g className="crew-desk-cup">
            <path
              className="crew-mug"
              d="M148 80h12v14h-12zM160 82h5v8h-5v-3h2v-2h-2z"
            />
            <path className="crew-steam" d="M151 75q-3-3 0-6M156 77q3-3 0-6" />
          </g>
          <g className="crew-status-bubble">
            <rect x="91" y="24" width="21" height="21" rx="7" />
            <path d="m96 43-2 6 9-6" />
            {state === "completed" ? (
              <path className="crew-bubble-mark" d="m97 34 4 4 6-8" />
            ) : state === "failed" ? (
              <path className="crew-bubble-mark" d="m98 30 8 8m0-8-8 8" />
            ) : (
              <>
                <path
                  className="crew-bubble-mark"
                  d="M98 31c0-4 8-4 8 0 0 3-4 3-4 6"
                />
                <circle className="crew-question-dot" cx="102" cy="40" r="1" />
              </>
            )}
          </g>
        </g>
      )}
      <g className="crew-coffee">
        <path className="crew-coffee-arm" d="m82 79 10 6-4 6-13-6z" />
        <path
          className="crew-coffee-cup"
          d="M84 77h14v13q-7 5-14 0zM98 80h5v8h-5v-3h2v-2h-2z"
        />
        <ellipse className="crew-coffee-top" cx="91" cy="77" rx="7" ry="2" />
        <rect
          className="crew-coffee-hand"
          x="80"
          y="83"
          width="8"
          height="7"
          rx="3"
        />
        <path className="crew-steam" d="M88 72q-3-3 0-6M94 72q3-3 0-6" />
      </g>
    </svg>
  );
});
