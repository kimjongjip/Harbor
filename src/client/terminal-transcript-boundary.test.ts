import test from "node:test";
import assert from "node:assert/strict";
import {
  transcriptBoundary,
  type TranscriptFrame,
} from "./terminal-transcript-boundary";
import { conversationTurns, type ConversationTurn } from "./conversation-turns";
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
test("unknown latest remains fully native even when idle status and a multiline composer suggest rest", () => {
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
    { historyCount: 1, nativeStart: 0 },
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
    { historyCount: 1, nativeStart: 0 },
  );
});

test("an entirely incomplete history with no native overlap never leaks saved work rows", () => {
  const turns = conversationTurns(records(false).slice(2));
  for (const working of [false, true])
    assert.deepEqual(
      transcriptBoundary(
        turns,
        frame(["Running unsaved operation", "Allow command?", "›"]),
        [],
        working,
      ),
      { historyCount: 0, nativeStart: 0 },
    );
});

test("stale idle cannot render an unfinished turn even when its partial final text matches the screen", () => {
  const lines = [
    "older screen",
    "› Please inspect the compiler output",
    "• Ran compiler",
    "This is the complete final answer.",
    "› draft",
  ];
  for (const working of [false, true])
    assert.deepEqual(
      transcriptBoundary(
        conversationTurns(records(false)),
        frame(lines),
        [],
        working,
      ),
      { historyCount: 1, nativeStart: 1 },
    );
});

test("history ahead of native output uses only a matched completed prefix", () => {
  const lines = [
    "› earlier task",
    "Earlier answer.",
    "• New native operation not yet saved",
    "Approval required",
  ];
  for (const working of [false, true])
    assert.deepEqual(
      transcriptBoundary(
        conversationTurns(records(false)),
        frame(lines),
        [],
        working,
      ),
      { historyCount: 1, nativeStart: 2 },
    );
});

test("a completed saved turn while new work runs preserves all unrecorded native output", () => {
  const lines = [
    "This is the complete final answer.",
    "› Entirely new question not in history",
    "• Running another tool",
    "unsaved result",
  ];
  assert.deepEqual(
    transcriptBoundary(conversationTurns(records()), frame(lines), [], true),
    { historyCount: 2, nativeStart: 1 },
  );
  assert.deepEqual(
    transcriptBoundary(
      conversationTurns(records()),
      frame(lines.slice(1)),
      [],
      true,
    ),
    { historyCount: 2, nativeStart: 0 },
  );
});

test("verified history cannot crop an in-flight native turn before its final answer appears", () => {
  const lines = [
    "older screen",
    "› Please inspect the compiler output",
    "• Ran compiler",
    "output still arriving",
    "›",
  ];
  for (const working of [false, true])
    assert.deepEqual(
      transcriptBoundary(
        conversationTurns(records()),
        frame(lines),
        [],
        working,
      ),
      { historyCount: 1, nativeStart: 1 },
    );
});

test("an earlier identical answer cannot remove a later matching prompt and unsaved output", () => {
  const lines = [
    "This is the complete final answer.",
    "› Please inspect the compiler output",
    "• Running again",
  ];
  assert.deepEqual(
    transcriptBoundary(conversationTurns(records()), frame(lines), [], true),
    { historyCount: 1, nativeStart: 0 },
  );
});

test("missing native overlap searches only the nearest verified answer with hundreds of loaded turns", (context) => {
  let inspectedHistoryItems = 0,
    inspectedLineText = 0;
  const turns: ConversationTurn[] = Array.from({ length: 600 }, (_, index) => ({
    id: String(index),
    complete: true,
    finalIds: new Set([`answer-${index}`]),
    get items(): MessageItem[] {
      inspectedHistoryItems++;
      return [
        {
          id: `answer-${index}`,
          kind: "assistant",
          text: `Distinct completed saved answer number ${index}`,
        },
      ];
    },
  }));
  turns.push({
    id: "pending",
    complete: false,
    finalIds: new Set(),
    items: [
      {
        id: "question",
        kind: "user",
        text: "New prompt missing from the native screen",
      },
      { id: "tool", kind: "tool", text: "Partial saved tool output" },
    ],
  });
  const lines = new Proxy(
    Array.from(
      { length: 4000 },
      (_, index) => `native unsaved output ${index}`,
    ),
    {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) inspectedLineText++;
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const started = performance.now();
  assert.deepEqual(transcriptBoundary(turns, frame(lines), [], true), {
    historyCount: 600,
    nativeStart: 0,
  });
  context.diagnostic(
    `600 saved turns / 4,000 native rows: ${(performance.now() - started).toFixed(2)} ms, ${inspectedHistoryItems} answer inspected, ${inspectedLineText} row reads`,
  );
  assert.equal(
    inspectedHistoryItems,
    1,
    "must not rescan every saved answer per key",
  );
  assert.ok(
    inspectedLineText <= lines.length + 1032,
    `${inspectedLineText} reads: normalize each candidate row once`,
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

const completedAnswer = (text: string) =>
  conversationTurns(
    records().map((item) => (item.id === "a2" ? { ...item, text } : item)),
  );

test("Codex double-angle prompt identifies the current native turn and repeated questions", () => {
  const lines = [
    "earlier screen",
    "» Please inspect the compiler output",
    "Ran compiler",
    "» draft",
  ];
  assert.deepEqual(
    transcriptBoundary(
      conversationTurns(records(false)),
      frame(lines),
      [],
      true,
    ),
    {
      historyCount: 1,
      nativeStart: 1,
    },
  );
  assert.deepEqual(
    transcriptBoundary(
      conversationTurns(records()),
      frame([
        "This is the complete final answer.",
        "» Please inspect the compiler output",
        "New unsaved work",
      ]),
      [],
      true,
    ),
    { historyCount: 1, nativeStart: 0 },
  );
});

test("completed Markdown link labels match native Codex output without losing the approval tail", () => {
  const text =
    "Input and copy checks passed. Updated **[Git](https://example.test/repository/commit/0123456789012345678901234567890123456789)**.";
  const lines = [
    "» Please inspect the compiler output",
    "Ran compiler",
    "Input and copy checks passed. Updated Git.",
    "Allow a new command?",
    "1. Yes",
    "2. No",
    "» draft",
  ];
  assert.deepEqual(
    transcriptBoundary(completedAnswer(text), frame(lines), [], true),
    {
      historyCount: 2,
      nativeStart: 3,
    },
  );
  assert.deepEqual(
    transcriptBoundary(
      completedAnswer(text),
      frame([lines[0], text, "» draft"]),
      [],
      false,
    ),
    {
      historyCount: 2,
      nativeStart: 2,
    },
    "raw Markdown remains a supported native representation",
  );
});

test("link label projection handles balanced destinations, image labels and wrapped visible text", () => {
  for (const [saved, visible] of [
    [
      "The final report is [read the **updated** report](docs/report_(final).md).",
      "The final report is read the updated report.",
    ],
    [
      "View the result: ![allocation diagram](images/allocation.png).",
      "View the result: allocation diagram.",
    ],
    [
      'Read [the [updated] report](<docs/final report.md> "Report").',
      "Read the [updated] report.",
    ],
  ]) {
    const split = Math.floor(visible.length / 2);
    assert.deepEqual(
      transcriptBoundary(
        completedAnswer(saved),
        frame([
          "» Please inspect the compiler output",
          visible.slice(0, split),
          visible.slice(split),
          "» draft",
        ]),
        [],
        false,
      ),
      { historyCount: 2, nativeStart: 3 },
    );
  }
});

test("Markdown-looking links in inline and fenced code stay literal", () => {
  const literal = "[literal link](https://example.test/code)";
  for (const saved of [
    `Use this exact syntax: \`${literal}\`.`,
    `Use this exact syntax: \`\`${literal}\`\`.`,
    `Code example:\n\`\`\`text\n${literal}\n\`\`\``,
    `Code example:\n~~~text\n${literal}\n~~~`,
    `Code example:\n\n    ${literal}`,
    `Code example:\n\n\t${literal}`,
  ]) {
    assert.deepEqual(
      transcriptBoundary(
        completedAnswer(saved),
        frame([
          "» Please inspect the compiler output",
          "Use this exact syntax: literal link.",
          "» draft",
        ]),
        [],
        false,
      ),
      { historyCount: 1, nativeStart: 0 },
      "code must not become a label-only completion anchor",
    );
  }
  assert.deepEqual(
    transcriptBoundary(
      completedAnswer(`Use this exact syntax: \`${literal}\`.`),
      frame([
        "» Please inspect the compiler output",
        `Use this exact syntax: ${literal}.`,
        "» draft",
      ]),
      [],
      false,
    ),
    { historyCount: 2, nativeStart: 2 },
  );
});

test("malformed and escaped links cannot guess away native work", () => {
  for (const saved of [
    "Result available in [the final report](https://example.test/unclosed",
    "Result available in [the final report](invalid destination with spaces)",
    "Result available in \\[the final report](https://example.test/final)",
  ]) {
    assert.deepEqual(
      transcriptBoundary(
        completedAnswer(saved),
        frame([
          "» Please inspect the compiler output",
          "Result available in the final report",
          "Unsaved work",
          "» draft",
        ]),
        [],
        true,
      ),
      { historyCount: 1, nativeStart: 0 },
    );
  }
});

test("rendered links cannot bypass completion proof or a repeated newer prompt", () => {
  const text =
    "Final checks passed. See [the detailed report](docs/report.md).";
  const visible = "Final checks passed. See the detailed report.";
  const partial = completedAnswer(text).map((turn) => ({
    ...turn,
    complete: false,
    finalIds: new Set<string>(),
  }));
  assert.deepEqual(
    transcriptBoundary(
      partial,
      frame(["» Please inspect the compiler output", visible, "» draft"]),
      [],
      false,
    ),
    {
      historyCount: 1,
      nativeStart: 0,
    },
  );
  assert.deepEqual(
    transcriptBoundary(
      completedAnswer(text),
      frame([
        visible,
        "» Please inspect the compiler output",
        "Ran another tool",
      ]),
      [],
      true,
    ),
    {
      historyCount: 1,
      nativeStart: 0,
    },
  );
});

test("a final paragraph with a Git link matches after native bullet lists without stripping body punctuation", () => {
  const saved =
    "Changes are ready.\n\n- Native input stays in the same process.\n- Gray prompt backgrounds are preserved.\n- Copy and selection still work.\n\nInput and display checks passed. The tested update is available in [Git](https://example.test/repository/commit/0123456789012345678901234567890123456789).";
  for (const bullet of ["•", "·"]) {
    const lines = [
      "» Please inspect the compiler output",
      "Changes are ready.",
      "",
      `  ${bullet} Native input stays in the same process.`,
      `  ${bullet} Gray prompt backgrounds are preserved.`,
      `  ${bullet} Copy and selection still work.`,
      "",
      "Input and display checks passed. The tested update is available in Git.",
      "Allow an unrelated operation?",
      "1. Yes",
      "2. No",
      "» draft",
    ];
    assert.deepEqual(
      transcriptBoundary(completedAnswer(saved), frame(lines), [], true),
      {
        historyCount: 2,
        nativeStart: 8,
      },
    );
  }
  const numbered =
    "1. Keep alpha-beta unchanged.\n2. Inspect version-2 and x-y values.\n\nRead [the complete report](docs/final.md).";
  assert.deepEqual(
    transcriptBoundary(
      completedAnswer(numbered),
      frame([
        "» Please inspect the compiler output",
        "1) Keep alpha-beta unchanged.",
        "2) Inspect version-2 and x-y values.",
        "Read the complete report.",
        "» draft",
      ]),
      [],
      false,
    ),
    { historyCount: 2, nativeStart: 4 },
  );
  assert.deepEqual(
    transcriptBoundary(
      completedAnswer(numbered),
      frame([
        "» Please inspect the compiler output",
        "1) Keep alphabeta unchanged.",
        "2) Inspect version2 and xy values.",
        "Read the complete report.",
        "» draft",
      ]),
      [],
      false,
    ),
    { historyCount: 1, nativeStart: 0 },
    "body hyphens are not discarded",
  );
});

test("list-looking code remains literal when matching rendered answers", () => {
  const code = "- Keep this literal code line exactly as written.";
  for (const saved of [
    `Example:\n\n    ${code}\n\nRead [the detailed report](docs/final.md).`,
    `Example:\n\n\`${code}\`\n\nRead [the detailed report](docs/final.md).`,
  ]) {
    const lines = [
      "» Please inspect the compiler output",
      "Example:",
      "Keep this literal code line exactly as written.",
      "Read the detailed report.",
      "» draft",
    ];
    assert.deepEqual(
      transcriptBoundary(completedAnswer(saved), frame(lines), [], false),
      {
        historyCount: 1,
        nativeStart: 0,
      },
    );
  }
});
