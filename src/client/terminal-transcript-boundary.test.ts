import test from "node:test";
import assert from "node:assert/strict";
import {
  transcriptBoundary,
  type TranscriptFrame,
} from "./terminal-transcript-boundary";
import { conversationTurns } from "./conversation-turns";
import type { MessageItem } from "../shared/types";
import type { RichTerminalBlock } from "../shared/rich-terminal";

const records = (complete = true): MessageItem[] => [
  { id: "q1", kind: "user", turnId: "1", text: "earlier task" },
  {
    id: "a1",
    kind: "assistant",
    turnId: "1",
    text: "Earlier answer.",
    phase: "final_answer",
    turnStatus: "completed",
  },
  {
    id: "q2",
    kind: "user",
    turnId: "2",
    text: "Please inspect the compiler output",
  },
  {
    id: "w2",
    kind: "command",
    turnId: "2",
    text: "Ran compiler",
    detail: "exact output",
  },
  {
    id: "a2",
    kind: "assistant",
    turnId: "2",
    text: "This is the complete final answer.",
    phase: "final_answer",
    turnStatus: complete ? "completed" : "inProgress",
  },
];
const frame = (
  lines: string[],
  cursorRow = lines.length - 1,
): TranscriptFrame => ({ lines, cursorRow, baseY: 0, end: lines.length });
test("live work is shown once after earlier history, without cropping its output or native composer", () => {
  const lines = [
    "older text",
    "› Please inspect the compiler output",
    "• Ran compiler",
    "  └ exact output",
    "working…",
    "› draft",
  ];
  assert.deepEqual(
    transcriptBoundary(
      conversationTurns(records(false)),
      frame(lines),
      [],
      true,
    ),
    { historyCount: 1, nativeStart: 1 },
  );
});
test("completed turn replaces native output only up to the same final answer, retaining live draft/status", () => {
  const lines = [
    "› Please inspect the compiler output",
    "• Ran compiler",
    "This is the complete final answer.",
    "done",
    "› untouched draft",
  ];
  assert.deepEqual(
    transcriptBoundary(conversationTurns(records()), frame(lines), [], false),
    { historyCount: 2, nativeStart: 3 },
  );
});
test("rich reservations align by exact answer content and preserve subsequent output", () => {
  const blocks = [
    {
      id: "abcdef0123456789abcd",
      text: "This is the complete final answer.",
      marker: "~HBR:abcdef0123456789abcd~",
    },
  ] as RichTerminalBlock[];
  const lines = [
    "~HBR:abcdef0123456789abcd:0~",
    "~HBR:abcdef0123456789abcd:1~",
    "› next prompt",
    "• Running new work",
  ];
  assert.deepEqual(
    transcriptBoundary(
      conversationTurns(records()),
      frame(lines),
      blocks,
      true,
    ),
    { historyCount: 2, nativeStart: 2 },
  );
});
test("old unknown completion can display its saved work while original multiline draft remains intact", () => {
  const items = records(false).map((item) => ({
    ...item,
    turnStatus: undefined,
    phase: undefined,
  }));
  const lines = [
    "older screen",
    "❯ line one of draft",
    "  second line",
    "  third line",
  ];
  assert.deepEqual(
    transcriptBoundary(conversationTurns(items), frame(lines), [], false),
    { historyCount: 2, nativeStart: 1 },
  );
});
test("no overlap never guesses away native approval or unsaved work", () => {
  const lines = [
    "• New operation not yet saved",
    "Allow this command?",
    "1. Yes",
    "2. No",
  ];
  assert.deepEqual(
    transcriptBoundary(
      conversationTurns(records(false)),
      frame(lines),
      [],
      true,
    ),
    { historyCount: 2, nativeStart: 0 },
  );
});
test("empty marker cannot match an unrelated screen and wrapped prompts stay intact", () => {
  const blocks = [
    { id: "different", text: "This is the complete final answer.", marker: "" },
  ] as RichTerminalBlock[];
  const lines = [
    "› Please inspect the",
    "  compiler output",
    "• Ran tool",
    "waiting",
  ];
  assert.deepEqual(
    transcriptBoundary(
      conversationTurns(records(false)),
      frame(lines),
      blocks,
      true,
    ),
    { historyCount: 1, nativeStart: 0 },
  );
});
