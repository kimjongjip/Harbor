import type { CSSProperties, ReactNode } from "react";

const basic = [
  "#000000",
  "#cd3131",
  "#0dbc79",
  "#e5e510",
  "#2472c8",
  "#bc3fbc",
  "#11a8cd",
  "#e5e5e5",
];
const bright = [
  "#666666",
  "#f14c4c",
  "#23d18b",
  "#f5f543",
  "#3b8eea",
  "#d670d6",
  "#29b8db",
  "#e5e5e5",
];
const cube = (n: number) => {
  if (n < 16) return n < 8 ? basic[n] : bright[n - 8];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const c = n - 16,
    levels = [0, 95, 135, 175, 215, 255];
  return `rgb(${levels[Math.floor(c / 36)]},${levels[Math.floor(c / 6) % 6]},${levels[c % 6]})`;
};

/** Saved tool output keeps SGR colors as spans; other control sequences are dropped. */
export function AnsiText({ text }: { text: string }) {
  if (!text.includes("\x1b")) return <>{text}</>;
  const nodes: ReactNode[] = [];
  let style: CSSProperties = {};
  let at = 0;
  const pattern = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g;
  let match: RegExpExecArray | null;
  const flush = (end: number) => {
    if (end > at)
      nodes.push(
        Object.keys(style).length ? (
          <span key={nodes.length} style={style}>
            {text.slice(at, end)}
          </span>
        ) : (
          text.slice(at, end)
        ),
      );
  };
  while ((match = pattern.exec(text))) {
    flush(match.index);
    at = match.index + match[0].length;
    if (match[1] === undefined) continue;
    const codes = match[1] ? match[1].split(";").map(Number) : [0];
    const next: CSSProperties = { ...style };
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) Object.keys(next).forEach((key) => delete next[key as keyof CSSProperties]);
      else if (code === 1) next.fontWeight = 700;
      else if (code === 2) next.opacity = 0.7;
      else if (code === 3) next.fontStyle = "italic";
      else if (code === 4) next.textDecoration = "underline";
      else if (code === 22) {
        delete next.fontWeight;
        delete next.opacity;
      } else if (code === 23) delete next.fontStyle;
      else if (code === 24) delete next.textDecoration;
      else if (code >= 30 && code <= 37) next.color = basic[code - 30];
      else if (code >= 90 && code <= 97) next.color = bright[code - 90];
      else if (code === 39) delete next.color;
      else if (code >= 40 && code <= 47) next.backgroundColor = basic[code - 40];
      else if (code >= 100 && code <= 107)
        next.backgroundColor = bright[code - 100];
      else if (code === 49) delete next.backgroundColor;
      else if ((code === 38 || code === 48) && codes[i + 1] === 5) {
        next[code === 38 ? "color" : "backgroundColor"] = cube(codes[i + 2] || 0);
        i += 2;
      } else if ((code === 38 || code === 48) && codes[i + 1] === 2) {
        next[code === 38 ? "color" : "backgroundColor"] =
          `rgb(${codes[i + 2] || 0},${codes[i + 3] || 0},${codes[i + 4] || 0})`;
        i += 4;
      }
    }
    style = next;
  }
  flush(text.length);
  return <>{nodes}</>;
}

/** Plain text of saved output, for counting and copy fallbacks. */
export const stripAnsi = (text: string) =>
  text.replace(
    /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g,
    "",
  );
