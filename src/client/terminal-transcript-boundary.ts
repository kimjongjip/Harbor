import type { ConversationTurn } from "./conversation-turns";
import type { RichTerminalBlock } from "../shared/rich-terminal";

export interface TranscriptFrame {
  lines: string[];
  cursorRow: number;
  baseY: number;
  end: number;
}

const comparable = (text: string) =>
  text.replace(/[*`#_]/g, "").replace(/\s+/g, "");

/** Normalize each inspected row at most once across candidate questions/answers. */
function frameLookup(lines: string[]) {
  const normalized: (string | undefined)[] = [];
  const prompts: number[] = [];
  for (let row = 0; row < lines.length; row++)
    if (/^\s*[›❯>]\s?/.test(lines[row])) prompts.push(row);
  return {
    lines,
    prompts,
    normalized: (row: number) => (normalized[row] ??= comparable(lines[row])),
  };
}
type FrameLookup = ReturnType<typeof frameLookup>;

function questionRow(lookup: FrameLookup, text: string): number {
  const { lines, prompts, normalized } = lookup;
  const wanted = comparable(text).slice(0, 180);
  if (!wanted) return -1;
  for (let index = prompts.length - 1; index >= 0; index--) {
    const row = prompts[index],
      nextPrompt = prompts[index + 1] ?? lines.length;
    let value = "";
    for (let at = row; at < Math.min(nextPrompt, row + 32); at++) {
      value +=
        at === row
          ? comparable(lines[at].replace(/^\s*[›❯>]\s?/, ""))
          : normalized(at);
      if (value.startsWith(wanted)) return row;
      if (value.length >= wanted.length) break;
    }
  }
  return -1;
}

function answerEnd(
  lookup: FrameLookup,
  text: string,
  blocks: RichTerminalBlock[],
): number {
  const { lines, normalized } = lookup;
  const block = [...blocks].reverse().find((item) => item.text === text);
  if (block) {
    for (let row = lines.length - 1; row >= 0; row--)
      if (
        lines[row].includes(`~HBR:${block.id}:`) ||
        (block.marker && lines[row].includes(block.marker))
      )
        return row + 1;
  }
  const wanted = comparable(text).slice(-180);
  if (wanted.length < 12) return -1;
  for (let end = lines.length; end > Math.max(0, lines.length - 1000); end--) {
    let value = "";
    for (let row = end - 1; row >= Math.max(0, end - 32); row--) {
      value = normalized(row) + value;
      if (value.endsWith(wanted)) return end;
      if (value.length > wanted.length * 2) break;
    }
  }
  return -1;
}

/** One document: persisted earlier turns followed by the unchanged live CLI tail.
 * Matching affects presentation only; it never decides native completion or sends input.
 * Completion comes from verified turns, never the possibly stale activity status.
 */
export function transcriptBoundary(
  turns: ConversationTurn[],
  frame: TranscriptFrame,
  blocks: RichTerminalBlock[],
  _working: boolean,
): { historyCount: number; nativeStart: number } {
  const last = turns.at(-1);
  if (!last) return { historyCount: 0, nativeStart: 0 };
  const lookup = frameLookup(frame.lines);
  const question = last.items.find((item) => item.kind === "user");
  const start = question ? questionRow(lookup, question.text) : -1;
  const completedEnd = (turn: ConversationTurn) => {
    if (!turn.complete) return -1;
    const assistant = [...turn.items]
      .reverse()
      .find((item) => item.kind === "assistant" && turn.finalIds.has(item.id));
    return assistant ? answerEnd(lookup, assistant.text, blocks) : -1;
  };
  const end = completedEnd(last);
  // Only a verified final answer can replace a whole turn. Idle/working status
  // and a visible composer are not evidence of completion: hooks and history
  // can lag each other, and an approval also leaves the CLI waiting for input.
  if (end >= 0 && (start < 0 || end > start))
    return { historyCount: turns.length, nativeStart: end };
  // A repeated prompt may belong to new, unsaved work while the saved latest
  // answer belongs to its previous occurrence. Do not crop either occurrence.
  if (end >= 0 && start >= end)
    return { historyCount: turns.length - 1, nativeStart: 0 };
  if (start >= 0) return { historyCount: turns.length - 1, nativeStart: start };
  // History may already contain a new prompt while its screen is still catching
  // up. Anchor only to a positively matched earlier completed answer; all work
  // after it remains native and the partial latest saved rows stay out of view.
  if (!last.complete) {
    let index = turns.length - 2;
    while (index >= 0 && !turns[index].complete) index--;
    // Only the nearest verified turn can anchor this transition. Searching all
    // loaded answers on every echoed key scales with the entire history and is
    // unnecessary: if this recent anchor is absent, preserve the native screen.
    const previousEnd = index >= 0 ? completedEnd(turns[index]) : -1;
    if (previousEnd >= 0)
      return { historyCount: index + 1, nativeStart: previousEnd };
  }
  // No reliable overlap: keep the native screen intact rather than guessing away
  // an approval prompt or unsaved output. A completed last saved turn may simply
  // precede entirely new work not recorded yet; it can stay above the native CLI.
  // Unknown/incomplete latest turns must never leak their partial tool rows here.
  return {
    historyCount: turns.length - (last.complete ? 0 : 1),
    nativeStart: 0,
  };
}
