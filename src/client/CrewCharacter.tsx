import { memo } from "react";
import type { TerminalAgentState } from "../shared/terminal-agents";

export type CrewCharacterKind = "cat" | "robot" | "fox";

/** Original SVG artwork; motion stays in CSS, independently of React and xterm. */
export const CrewCharacter = memo(function CrewCharacter({
  character,
  state,
  miniature = false,
}: {
  character: CrewCharacterKind;
  state: TerminalAgentState;
  miniature?: boolean;
}) {
  return (
    <svg
      className={`crew-art crew-${character}${miniature ? " miniature" : ""}`}
      data-state={state}
      viewBox={miniature ? "25 23 90 88" : "0 0 200 126"}
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
        {character !== "robot" && (
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
          <rect x="56" y="52" width="5" height="7" rx="2" />
          <rect x="75" y="52" width="5" height="7" rx="2" />
          <path className="crew-eye-glint" d="M57 53h2v2h-2zM76 53h2v2h-2z" />
        </g>
        {character === "robot" ? (
          <path className="crew-robot-smile" d="M64 63h8" />
        ) : (
          <g>
            <path fill="#bd7279" d="M65 62h6l-3 3z" />
            <path className="crew-smile" d="M62 66q3 4 6 0 3 4 6 0" />
            <path className="crew-cheeks" d="M50 61h7v3h-7zM79 61h7v3h-7z" />
          </g>
        )}
      </g>
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
          <path
            className="crew-mug"
            d="M148 80h12v14h-12zM160 82h5v8h-5v-3h2v-2h-2z"
          />
          <path className="crew-steam" d="M151 75q-3-3 0-6M156 77q3-3 0-6" />
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
    </svg>
  );
});
