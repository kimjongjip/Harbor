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

function questionRow(lines: string[], text: string): number {
  const wanted = comparable(text).slice(0, 180);
  if (!wanted) return -1;
  for (let row = lines.length - 1; row >= 0; row--) {
    if (!/^\s*[›❯>]\s?/.test(lines[row])) continue;
    let value = "";
    for (let at = row; at < Math.min(lines.length, row + 32); at++) {
      if (at > row && /^\s*[›❯>]\s?/.test(lines[at])) break;
      value += comparable(
        at === row ? lines[at].replace(/^\s*[›❯>]\s?/, "") : lines[at],
      );
      if (value.startsWith(wanted)) return row;
      if (value.length >= wanted.length) break;
    }
  }
  return -1;
}

function answerEnd(
  lines: string[],
  text: string,
  blocks: RichTerminalBlock[],
): number {
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
      value = comparable(lines[row]) + value;
      if (value.endsWith(wanted)) return end;
      if (value.length > wanted.length * 2) break;
    }
  }
  return -1;
}

/** One document: persisted earlier turns followed by the unchanged live CLI tail.
 * Matching affects presentation only; it never decides native completion or sends input.
 */
export function transcriptBoundary(
  turns: ConversationTurn[],
  frame: TranscriptFrame,
  blocks: RichTerminalBlock[],
  working: boolean,
): { historyCount: number; nativeStart: number } {
  const last = turns.at(-1);
  if (!last) return { historyCount: 0, nativeStart: 0 };
  const question = last.items.find((item) => item.kind === "user");
  const assistant = [...last.items]
    .reverse()
    .find((item) => item.kind === "assistant");
  const start = question ? questionRow(frame.lines, question.text) : -1;
  const end = assistant ? answerEnd(frame.lines, assistant.text, blocks) : -1;
  // A currently running turn remains native until its final answer is recorded.
  if (working && !last.complete && start >= 0)
    return { historyCount: turns.length - 1, nativeStart: start };
  if (end >= 0 && (!working || last.complete))
    return { historyCount: turns.length, nativeStart: end };
  // At rest the original CLI composer remains inline, including multiline drafts.
  if (!working) {
    for (
      let row = Math.min(frame.cursorRow, frame.lines.length - 1);
      row >= Math.max(0, frame.cursorRow - 32);
      row--
    ) {
      if (/^\s*[›❯>]\s?/.test(frame.lines[row]))
        return { historyCount: turns.length, nativeStart: row };
    }
  }
  if (start >= 0) return { historyCount: turns.length - 1, nativeStart: start };
  // No reliable overlap: keep the native screen intact rather than guessing away
  // an approval prompt or unsaved output. Earlier history remains available above.
  return { historyCount: turns.length, nativeStart: 0 };
}
