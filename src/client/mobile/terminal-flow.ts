import type { IBuffer, IBufferCell, IBufferLine, ITheme } from "@xterm/xterm";
import { visibleMarkdownText } from "../terminal-transcript-boundary";
import type { CSSProperties } from "react";
import type { RichTerminalBlock } from "../../shared/rich-terminal";
import { richFragments } from "../terminal-rich-layout";

export type FlowPart =
  | { kind: "answer"; id: string; block?: RichTerminalBlock }
  | { kind: "row"; row: number; start: number };

/** Keep native rows, but replace all reservations of one answer with its full text. */
export function mobileFlowParts(
  lines: string[],
  blocks: RichTerminalBlock[],
): FlowPart[] | undefined {
  const known = new Map(blocks.map((b) => [b.id, b]));
  const candidates = new Map(known);
  for (const line of lines) {
    const match = /^\s*~HBR:([a-f0-9]{20}):\d{1,3}~/.exec(line);
    if (match && !candidates.has(match[1]))
      candidates.set(match[1], {
        id: match[1],
        marker: `~HBR:${match[1]}~`,
        renderer: "rows-v2",
        requestId: "",
        sessionId: "",
        text: "",
        columns: 100,
        viewportRows: 30,
        createdAt: 0,
        state: "pending",
      });
  }
  const fragments = richFragments(lines, [...candidates.values()]);
  if (!fragments.size) return;
  const reserved = new Map<number, { id: string; suffix?: number }>();
  for (const [id, spans] of fragments)
    for (const span of spans)
      for (let row = span.firstRow; row < span.firstRow + span.rows; row++)
        reserved.set(row, {
          id,
          suffix:
            span.columns === undefined ? undefined : span.column + span.columns,
        });
  const result: FlowPart[] = [],
    emitted = new Set<string>();
  for (let row = 0; row < lines.length; row++) {
    const reservation = reserved.get(row);
    if (!reservation) result.push({ kind: "row", row, start: 0 });
    else {
      if (!emitted.has(reservation.id)) {
        emitted.add(reservation.id);
        result.push({
          kind: "answer",
          id: reservation.id,
          block: known.get(reservation.id),
        });
      }
      // Output beside/interleaved with a reserved answer is still native output.
      if (reservation.suffix !== undefined)
        result.push({ kind: "row", row, start: reservation.suffix });
    }
  }
  return result;
}

export function terminalContentEnd(buffer: IBuffer) {
  let end = buffer.baseY + buffer.cursorY + 1;
  for (let row = buffer.length - 1; row >= buffer.baseY; row--)
    if (buffer.getLine(row)?.translateToString(true).trim())
      return Math.max(end, row + 1);
  return end;
}

type PhoneSignature = {text:string; table:boolean};
const answerSignatures = new WeakMap<RichTerminalBlock, PhoneSignature[]>();
function tableLine(line: string) {
  if (/^[\s|:\-─━┌┬┐├┼┤└┴┘│]+$/u.test(line)) return "";
  return line.replace(/[|│\s]/gu,"");
}
/** Some Codex answers have no reservation; Claude may redraw a reservation
 * as text. Replace only a complete match beginning at an assistant bullet.
 * Keep prompts, tool output and partial/ambiguous matches in their own rows. */
export function phoneFlowParts(
  lines: string[],
  blocks: RichTerminalBlock[],
): FlowPart[] {
  const parts =
    mobileFlowParts(lines, blocks) ??
    lines.map((_, row) => ({ kind: "row" as const, row, start: 0 }));
  if (!blocks.length) return parts;
  const present = new Set(
    parts.flatMap((p) => (p.kind === "answer" ? [p.id] : [])),
  );
  const candidates = blocks
    .filter((b) => !present.has(b.id))
    .flatMap(block => {
      let variants = answerSignatures.get(block);
      if (!variants) {
        const raw = block.text.replace(/\s+/gu, "");
        variants = [{text:raw,table:false}];
        if (block.text.length < 128000) {
          const prose = visibleMarkdownText(block.text)
            .replace(/(\*\*|__)(.+?)\1/gs, "$2")
            .replace(/`([^`\n]+)`/g, "$1")
            .replace(/^ {0,3}#{1,6}\s+/gm, "");
          const rendered = prose.replace(/\s+/gu, "");
          if (rendered !== raw) variants.push({text:rendered,table:false});
          if (/^\s*\|?\s*:?-{3,}:?\s*\|/m.test(block.text) && !block.text.includes("\u0060\u0060\u0060")) {
            variants.push({text:prose.split("\n").map(tableLine).join(""),table:true});
          }
        }
        answerSignatures.set(block, variants);
      }
      return variants.map(signature => ({block,...signature}));
    })
    .filter((c) => c.text.length >= 12);
  if (!candidates.length) return parts;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.kind !== "row" || part.start) continue;
    const marker = /^\s{0,2}[●•⏺]\s+(.+)$/u.exec(lines[part.row]);
    const prefix = (marker ? marker[1] : lines[part.row]).replace(/\s+/gu, "");
    if (!marker && (prefix.length < 16 || /^\s*[›❯»>]/u.test(lines[part.row]))) continue;
    const possible = candidates.flatMap(c => {
      if ((!marker && !c.block.id.startsWith("history:antigravity:")) || present.has(c.block.id)) return [];
      const start = c.table ? tableLine(prefix) : prefix;
      return start && c.text.startsWith(start) ? [{...c,length:start.length}] : [];
    });
    let found: { block: RichTerminalBlock; end: number } | undefined;
    for (let j = i; possible.length; j++) {
      const exact = possible.filter(c => c.text.length === c.length);
      if (exact.length) found = exact.every(c => c.block.id === exact[0].block.id)
        ? {block:exact[0].block,end:j} : undefined;
      const next = parts[j + 1];
      if (!next || next.kind !== "row" || next.start) break;
      const line = lines[next.row];
      if (/^\s{0,2}[›❯»●•⏺]\s/u.test(line)) break;
      const chunk = line.replace(/\s+/gu, "");
      if (!chunk) continue;
      for (let n=possible.length-1;n>=0;n--) {
        const c=possible[n], value=c.table ? tableLine(line) : chunk;
        if (c.text.startsWith(value,c.length)) c.length+=value.length;
        else possible.splice(n,1);
      }
    }
    if (found) {
      // Keep trailing empty rows after the last text line.
      while (found.end > i) {
        const p = parts[found.end];
        if (p.kind !== "row" || lines[p.row].trim()) break;
        found.end--;
      }
      present.add(found.block.id);
      parts.splice(i, found.end - i + 1, {
        kind: "answer",
        id: found.block.id,
        block: found.block,
      });
    }
  }
  return parts;
}

const palette = [
  "#000000",
  "#cd0000",
  "#00cd00",
  "#cdcd00",
  "#0000ee",
  "#cd00cd",
  "#00cdcd",
  "#e5e5e5",
  "#7f7f7f",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#5c5cff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
];
const colorKeys = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;
function ansiColor(value: number, rgb: boolean, theme: ITheme) {
  if (rgb) return `#${value.toString(16).padStart(6, "0")}`;
  if (value < 16) return theme[colorKeys[value]] || palette[value];
  if (value >= 232) {
    const n = 8 + (value - 232) * 10;
    return `rgb(${n},${n},${n})`;
  }
  const n = value - 16,
    levels = [0, 95, 135, 175, 215, 255];
  return `rgb(${levels[Math.floor(n / 36)]},${levels[Math.floor(n / 6) % 6]},${levels[n % 6]})`;
}
export interface NativeRun {
  text: string;
  style: CSSProperties;
}
/** Empty cells to the right must not create offscreen phone content. */
export function trimNativeRow(runs: NativeRun[]): NativeRun[] {
  const result = runs.map((run) => ({ ...run }));
  while (result.length) {
    const last = result[result.length - 1];
    last.text = last.text.trimEnd();
    if (last.text) break;
    result.pop();
  }
  return result;
}
/** Full-width terminal borders are decoration, not paragraphs to wrap. */
export function nativeSeparator(text: string): boolean {
  return (
    /^\s*[─━═╌╍┄┅┈┉_—-]{12,}\s*$/.test(text) ||
    /^\s*[─━]+\s*History\s+\d+\s*\/\s*\d+\s*[─━]+\s*$/i.test(text)
  );
}
/** Reservation prefixes are ASCII; retain the styled suffix of a frozen row. */
export function clipNativeRuns(runs: NativeRun[], start: number): NativeRun[] {
  if (!start) return runs;
  let remaining = start;
  const suffix = runs.flatMap((run) => {
    const text = run.text.slice(remaining);
    remaining = Math.max(0, remaining - run.text.length);
    return text ? [{ ...run, text }] : [];
  });
  return [{ text: " ".repeat(start), style: {} }, ...suffix];
}
/** Read documented cells, not scraped ANSI/HTML. Preserve color, wide chars and spacing. */
export function nativeRow(
  line: IBufferLine | undefined,
  columns: number,
  start: number,
  theme: ITheme,
): NativeRun[] {
  const result: NativeRun[] = [];
  if (start) result.push({ text: " ".repeat(start), style: {} });
  let previous = "";
  // One reusable cell and a plain string key: this runs for every live cell
  // on each parsed write, so avoid per-cell allocation and JSON encoding.
  let cell: IBufferCell | undefined;
  const foreground = theme.foreground || "#182235",
    backdrop = theme.background || "#ffffff";
  for (let col = start; col < columns; col++) {
    cell = line?.getCell(col, cell);
    if (cell?.getWidth() === 0) continue;
    const text = cell?.isInvisible()
      ? " ".repeat(cell.getWidth() || 1)
      : cell?.getChars() || " ";
    let color =
      !cell || cell.isFgDefault()
        ? foreground
        : ansiColor(cell.getFgColor(), cell.isFgRGB(), theme);
    let background =
      !cell || cell.isBgDefault()
        ? backdrop
        : ansiColor(cell.getBgColor(), cell.isBgRGB(), theme);
    if (cell?.isInverse()) [color, background] = [background, color];
    const bold = !!cell?.isBold(),
      italic = !!cell?.isItalic(),
      dim = !!cell?.isDim(),
      underline = !!cell?.isUnderline(),
      strike = !!cell?.isStrikethrough();
    const key = `${color}\0${background}\0${+bold}${+italic}${+dim}${+underline}${+strike}`;
    if (result.length && key === previous) {
      result[result.length - 1].text += text;
      continue;
    }
    const style: CSSProperties = {
      color,
      backgroundColor: background,
      ...(bold ? { fontWeight: 700 } : {}),
      ...(italic ? { fontStyle: "italic" } : {}),
      ...(dim ? { opacity: 0.65 } : {}),
      textDecoration:
        [underline && "underline", strike && "line-through"]
          .filter(Boolean)
          .join(" ") || undefined,
    };
    result.push({ text, style });
    previous = key;
  }
  return result;
}
