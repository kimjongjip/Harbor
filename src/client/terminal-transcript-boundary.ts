import type { ConversationTurn } from "./conversation-turns";
import type { RichTerminalBlock } from "../shared/rich-terminal";
import { typedPrompt } from "./user-origin";
import {
  lastNativeBlock,
  nativeChrome,
  type NativeChromeFrame,
} from "./terminal-native-chrome";

export interface TranscriptFrame extends NativeChromeFrame {
  lines: string[];
  cursorRow: number;
  baseY: number;
  end: number;
}

const comparable = (text: string) =>
  text.replace(/[*`#_]/g, "").replace(/\s+/g, "");
const promptPrefix = /^\s*[›❯»>]\s?/;
const markdownListPrefix = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/;
const nativeListPrefix = /^\s*(?:[-+*•·]|\d{1,9}[.)])[ \t]+/;

/** Comparison only: terminal Markdown renders link labels, not their targets.
 * Keep code spans/fences literal and leave ambiguous syntax unchanged. The
 * original text remains another candidate; this never changes the saved data.
 */
function visibleMarkdownText(text: string): string {
  let result = "",
    at = 0;
  while (at < text.length) {
    if (at === 0 || text[at - 1] === "\n") {
      // Indented code also prints Markdown punctuation literally. Some list
      // continuations share this indentation; keeping those literal is the
      // conservative choice when the native rendering is ambiguous.
      if (/^(?: {4}|\t)/.test(text.slice(at))) {
        const end = text.indexOf("\n", at);
        const next = end < 0 ? text.length : end + 1;
        result += text.slice(at, next);
        at = next;
        continue;
      }
      const fence = /^( {0,3})(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(text.slice(at));
      if (fence) {
        const marker = fence[2],
          start = at + fence[0].length;
        const close = new RegExp(
          `^ {0,3}${marker[0]}{${marker.length},}[ \\t]*\\r?$`,
          "gm",
        );
        close.lastIndex = start;
        const end = close.exec(text);
        const next = end ? end.index + end[0].length : text.length;
        result += text.slice(at, next);
        at = next;
        continue;
      }
      // Terminal Markdown can use •/· instead of -/*, or a different numbered
      // list marker. Only the syntactic line prefix is normalized, never body
      // hyphens/numbers or the protected code above.
      const list = markdownListPrefix.exec(text.slice(at));
      if (list) at += list[0].length;
    }
    if (text[at] === "\\") {
      result += text.slice(at, at + 2);
      at += 2;
      continue;
    }
    if (text[at] === "`") {
      const marker = /^`+/.exec(text.slice(at))![0];
      const close = /`+/g;
      close.lastIndex = at + marker.length;
      let end: RegExpExecArray | null;
      do {
        end = close.exec(text);
      } while (end && end[0].length !== marker.length);
      const next = end ? end.index + marker.length : at + marker.length;
      result += text.slice(at, next);
      at = next;
      continue;
    }
    const labelStart = text[at] === "!" && text[at + 1] === "[" ? at + 1 : at;
    if (text[labelStart] === "[") {
      let cursor = labelStart + 1,
        depth = 1;
      for (; cursor < text.length && depth; cursor++) {
        if (text[cursor] === "\\") cursor++;
        else if (text[cursor] === "[") depth++;
        else if (text[cursor] === "]") depth--;
      }
      const labelEnd = cursor - 1;
      if (!depth && text[cursor] === "(") {
        const destinationStart = ++cursor;
        depth = 1;
        for (; cursor < text.length && depth; cursor++) {
          if (text[cursor] === "\\") cursor++;
          else if (text[cursor] === "(") depth++;
          else if (text[cursor] === ")") depth--;
        }
        const destination = text.slice(destinationStart, cursor - 1).trim();
        // Destinations with whitespace are accepted only with an optional title
        // or angle brackets. A malformed/unclosed link must remain literal.
        if (
          !depth &&
          labelEnd > labelStart + 1 &&
          /^(?:<[^<>\r\n]*>|[^\s]+)?(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'))?$/.test(
            destination,
          )
        ) {
          result += text.slice(labelStart + 1, labelEnd);
          at = cursor;
          continue;
        }
      }
      // Do not repeatedly rescan long unmatched/nested brackets. Keeping the
      // whole ambiguous region literal is safer than finding a guessed anchor.
      result += text.slice(at, cursor);
      at = cursor;
      continue;
    }
    result += text[at++];
  }
  return result;
}

const answerSuffixCache = new WeakMap<
  ConversationTurn["items"][number],
  { text: string; suffixes: { text: string; prose: boolean }[] }
>();
function answerSuffixes(message: ConversationTurn["items"][number]) {
  const cached = answerSuffixCache.get(message);
  if (cached?.text === message.text) return cached.suffixes;
  const raw = comparable(message.text).slice(-180);
  const suffixes = [{ text: raw, prose: false }];
  // Avoid rescanning saved Markdown per echoed key. Extremely large or odd
  // records keep the conservative original-text matching path.
  if (
    message.text.length <= 512 * 1024 &&
    (message.text.includes("](") ||
      /(?:^|\n) {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/.test(message.text))
  ) {
    const visible = comparable(visibleMarkdownText(message.text)).slice(-180);
    if (visible !== raw) suffixes.push({ text: visible, prose: true });
  }
  const result = suffixes.filter((value) => value.text.length >= 12);
  answerSuffixCache.set(message, { text: message.text, suffixes: result });
  return result;
}

/** Normalize each inspected row at most once across candidate questions/answers. */
function frameLookup(lines: string[]) {
  const normalized: ({ raw: string; prose: string } | undefined)[] = [];
  const values = (row: number) => {
    if (normalized[row]) return normalized[row]!;
    const text = lines[row];
    return (normalized[row] = {
      raw: comparable(text),
      prose: comparable(text.replace(nativeListPrefix, "")),
    });
  };
  const prompts: number[] = [];
  for (let row = 0; row < lines.length; row++)
    if (promptPrefix.test(lines[row])) prompts.push(row);
  return {
    lines,
    prompts,
    normalized: (row: number) => values(row).raw,
    normalizedProse: (row: number) => values(row).prose,
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
          ? comparable(lines[at].replace(promptPrefix, ""))
          : normalized(at);
      if (value.startsWith(wanted)) return row;
      if (value.length >= wanted.length) break;
    }
  }
  return -1;
}

function answerEnd(
  lookup: FrameLookup,
  message: ConversationTurn["items"][number],
  blocks: RichTerminalBlock[],
): number {
  const { lines, normalized, normalizedProse } = lookup;
  const text = message.text;
  const block = [...blocks].reverse().find((item) => item.text === text);
  if (block) {
    for (let row = lines.length - 1; row >= 0; row--)
      if (
        lines[row].includes(`~HBR:${block.id}:`) ||
        (block.marker && lines[row].includes(block.marker))
      )
        return row + 1;
  }
  const wanted = answerSuffixes(message);
  if (!wanted.length) return -1;
  const maxLength = Math.max(...wanted.map((value) => value.text.length));
  for (let end = lines.length; end > Math.max(0, lines.length - 1000); end--) {
    let value = "",
      prose = "";
    for (let row = end - 1; row >= Math.max(0, end - 32); row--) {
      value = normalized(row) + value;
      prose = normalizedProse(row) + prose;
      if (
        wanted.some((suffix) =>
          (suffix.prose ? prose : value).endsWith(suffix.text),
        )
      )
        return end;
      if (value.length > maxLength * 2) break;
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
  // Slash commands, notices and channel deliveries never appear as a typed prompt row.
  const question = last.items.find(typedPrompt);
  const start = question ? questionRow(lookup, question.text) : -1;
  const completedEnd = (turn: ConversationTurn) => {
    if (!turn.complete) return -1;
    const assistant = [...turn.items]
      .reverse()
      .find((item) => item.kind === "assistant" && turn.finalIds.has(item.id));
    return assistant ? answerEnd(lookup, assistant, blocks) : -1;
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

/** Rows after a typed prompt's own rows (it may wrap or continue indented). */
function questionEnd(lookup: FrameLookup, text: string, limit: number): number {
  const row = questionRow(lookup, text);
  if (row < 0 || row >= limit) return -1;
  const wanted = comparable(text);
  let value = comparable(lookup.lines[row].replace(promptPrefix, ""));
  let end = row + 1;
  while (end < limit && value.length < wanted.length && end - row < 64) {
    value += lookup.normalized(end);
    end++;
  }
  return end;
}

export interface LiveTranscriptLayout {
  historyCount: number;
  /** First native row shown. */
  nativeStart: number;
  /** First row of the CLI's composer/spinner/dialog. Rows in between are
   * newer than the saved transcript (streaming text, a running step). */
  chromeStart: number;
  /** False when the live area is unknown: the legacy whole-screen tail. */
  live: boolean;
}

/**
 * Fullscreen CLIs keep only one repainted screen in the emulator. Every saved
 * turn — including the one still running — renders from history; the native
 * flow keeps just what history cannot show yet plus the interactive area.
 */
export function liveTranscriptLayout(
  turns: ConversationTurn[],
  frame: TranscriptFrame,
  blocks: RichTerminalBlock[],
  state: { waiting: boolean },
): LiveTranscriptLayout {
  const chrome = nativeChrome(frame.lines, frame.end, frame);
  // An unframed (Codex-style) prompt row can be a dialog choice whose question
  // sits above it; approvals keep the whole native tail.
  if (!chrome || (state.waiting && !chrome.framed)) {
    const legacy = transcriptBoundary(turns, frame, blocks, false);
    return { ...legacy, chromeStart: frame.end, live: false };
  }
  const limit = chrome.start;
  const last = turns.at(-1);
  if (!last)
    return { historyCount: 0, nativeStart: 0, chromeStart: limit, live: true };
  const lookup = frameLookup(frame.lines.slice(0, limit));
  const ending = (turn: ConversationTurn) => {
    if (!turn.complete) return -1;
    const answer = [...turn.items]
      .reverse()
      .find((item) => item.kind === "assistant" && turn.finalIds.has(item.id));
    return answer ? answerEnd(lookup, answer, blocks) : -1;
  };
  if (last.complete) {
    // Anything after the saved final answer is newer than history (a prompt
    // just submitted); an unmatched screen only repeats saved turns.
    const end = ending(last);
    return {
      historyCount: turns.length,
      nativeStart:
        end >= 0 ? skipBlankRows(frame.lines, Math.min(end, limit), limit) : limit,
      chromeStart: limit,
      live: true,
    };
  }
  let anchor = -1;
  const latest = [...last.items]
    .reverse()
    .find((item) => item.kind === "assistant" && item.text.trim());
  if (latest) anchor = answerEnd(lookup, latest, blocks);
  if (anchor < 0) {
    const question = last.items.find(typedPrompt);
    if (question) anchor = questionEnd(lookup, question.text, limit);
  }
  if (anchor < 0) {
    let index = turns.length - 2;
    while (index >= 0 && !turns[index].complete) index--;
    if (index >= 0) anchor = ending(turns[index]);
  }
  // Nothing on screen is saved yet: keep the newest block being written.
  if (anchor < 0) anchor = lastNativeBlock(frame.lines, limit);
  return {
    historyCount: turns.length,
    nativeStart: skipBlankRows(frame.lines, Math.min(anchor, limit), limit),
    chromeStart: limit,
    live: true,
  };
}

/** Separator rows before newer native output carry nothing to show. */
function skipBlankRows(lines: string[], start: number, limit: number) {
  while (start < limit && !lines[start]?.trim()) start++;
  return start;
}
