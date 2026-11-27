import test from "node:test";
import assert from "node:assert/strict";
import {
  lastNativeBlock,
  nativeChrome,
  nativeTranscriptRepaint,
  nativeInteractiveReplacement,
  nativeChoiceDialog,
  nativeMenuVisible,
  promptHistoryStart,
} from "./terminal-native-chrome";

// Bottom rows recorded from real fullscreen CLIs (Claude Code 2.1.319, Codex
// 0.167.0) in an isolated workspace with synthetic prompts; rules shortened.
const rule = "─".repeat(40);
test("a framed recalled prompt starts at the History rule even with the cursor on the spinner", () => {
  const lines = [
    "❯ saved question",
    "✻ Working…",
    "─── History 2/3 ─────────",
    "❯ /model",
    "  second line",
    rule,
    "  manual mode on",
  ];
  assert.equal(
    promptHistoryStart(lines, lines.length, { baseY: 0, cursorRow: 1 }, false),
    2,
  );
  const idle = [...lines, rule, "❯ new draft", rule, "  manual mode on"];
  const command = ["› /model", "  ? for shortcuts"];
  assert.equal(
    promptHistoryStart(command, 2, { baseY: 0, cursorRow: 0 }, true),
    0,
  );
  assert.equal(
    promptHistoryStart(command, 2, { baseY: 0, cursorRow: 0 }, false),
    undefined,
  );
  assert.equal(
    promptHistoryStart(idle, idle.length, { baseY: 0, cursorRow: 8 }, true),
    undefined,
  );
});
test("an already open Claude effort slider and a hidden-cursor command composer work after tab switching", () => {
  const frame = { baseY: 0, cursorRow: 0, cursorColumn: 0 };
  const slider = [
    "   Effort",
    " Faster     Smarter",
    " ──▲─────",
    " low   medium    high",
    " ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel",
  ];
  assert.equal(nativeMenuVisible(slider, slider.length, frame, false), true);
  assert.equal(nativeMenuVisible(["", ""], 2, frame, true), true);
  const suggestion = [
    "  ❯ /model   Set the model",
    rule,
    "❯ /model ",
    rule,
    "  auto mode on",
  ];
  assert.equal(
    nativeMenuVisible(suggestion, suggestion.length, frame, false),
    true,
  );
  const repaint = ["> /some/printed/path", rule, "> ", rule, "auto · Gemini 4 Carbon"];
  assert.equal(nativeMenuVisible(repaint, repaint.length, frame, false), false);
  const returned = [
    "❯ /model",
    "  Kept model",
    rule,
    "❯  ",
    rule,
    "  auto mode on",
  ];
  assert.equal(
    nativeMenuVisible(
      returned,
      returned.length,
      { ...frame, cursorRow: 4 },
      true,
    ),
    false,
  );
});
test("numbered prompts and quoted control instructions are not native dialogs", () => {
  assert.equal(
    nativeInteractiveReplacement(["Press Enter to continue"], 1, false),
    false,
    "tool instructions during confirmed work are not terminal controls",
  );
  assert.equal(
    nativeInteractiveReplacement(["PS C:\\fixture>"], 1, false),
    false,
    "shell examples printed during work cannot end the CLI",
  );
  assert.equal(
    nativeChoiceDialog(["› 1. Yes", "  2. No"]),
    false,
    "literal answers need a real question or controls",
  );
  for (const lines of [
    [
      "❯ 1. Inspect the simulator",
      "  2. Compare the output",
      "  3. Explain the result",
    ],
    [
      "› Describe the message",
      "  The log says press Enter to continue, but do not run it.",
    ],
    [
      "› Describe the message",
      "  Press Enter to continue, but this is only a quoted example.",
    ],
    ["› Explain the result", "  Process exited."],
  ]) {
    assert.equal(nativeChoiceDialog(lines), false);
    assert.equal(nativeInteractiveReplacement(lines), false);
  }
  assert.equal(
    nativeChoiceDialog([
      "Choose a database",
      "› 1. PostgreSQL",
      "  2. SQLite",
      "Enter to select · Esc to cancel",
    ]),
    true,
  );
  const draft = [
    "› 1. Yes",
    "  2. No",
    "",
    "  GPT-6-Astra high",
    "  ? for shortcuts",
  ];
  assert.equal(
    nativeChoiceDialog([
      "Choose a database",
      "› 1. PostgreSQL",
      "  2. SQLite",
      "Tab/arrow keys to navigate · Enter to select · Esc to cancel",
    ]),
    true,
  );
  assert.equal(
    nativeChoiceDialog(draft, draft.length, 0, {
      cursorRow: 1,
      cursorColumn: 7,
      baseY: 0,
      bracketedPasteMode: true,
    }),
    false,
    "the live composer may contain literal approval examples",
  );
});
test("Claude history recall keeps a tall framed draft while work continues", () => {
  for (const length of [23, 60]) {
    const lines = [
      "• saved output",
      "✻ Working… (esc to interrupt)",
      rule,
      "❯ Previous prompt FIRST",
      ...Array.from({ length }, (_, i) => `  recalled prompt line ${i}`),
      "  Previous prompt LAST",
      rule,
      "  esc to interrupt",
    ];
    for (const cursorRow of [3, length + 4])
      assert.deepEqual(
        nativeChrome(lines, lines.length, {
          cursorRow,
          cursorColumn: 12,
          baseY: 0,
          bracketedPasteMode: true,
        }),
        { start: 1, framed: true },
      );
  }
});
test("foreground command progress is live chrome even without a composer", () => {
  const lines = [
    "• previous explanation",
    "",
    "  Run synthetic simulation · 13s",
    "    └ $ python simulator.py",
    "      --case fixture (4 lines)",
    "    (ctrl+b ctrl+b (twice) to run in background)",
  ];
  assert.deepEqual(nativeChrome(lines), { start: 2, framed: false });
  assert.equal(nativeInteractiveReplacement(lines), false);
  assert.equal(
    nativeInteractiveReplacement([
      "  python simulator.py",
      "output chunk without a tool heading",
    ]),
    false,
  );
  assert.equal(
    nativeInteractiveReplacement([
      "Allow running this command?",
      "❯ 1. Yes",
      "  2. No",
    ]),
    true,
  );
  assert.equal(nativeInteractiveReplacement(["Process exited.", "$ "]), true);
});
test("only transcript redraws are retained; interactive replacements remain visible", () => {
  assert.equal(
    nativeTranscriptRepaint(["› update", "184 - old line", "184 + new line"]),
    true,
  );
  assert.equal(
    nativeTranscriptRepaint(["184 -- old bullet", "184 +- new bullet"]),
    true,
  );
  assert.equal(
    nativeTranscriptRepaint(["• Called example.tool", "  completed"]),
    true,
  );
  assert.equal(
    nativeTranscriptRepaint(["Bash(python3 sample.py)", "  output"]),
    true,
  );
  assert.equal(nativeTranscriptRepaint(["", ""]), true);
  for (const screen of [
    ["Allow this command?", "› 1. Yes", "  2. No"],
    ["• Ran example", "PS C:\\fixture> "],
    ["• Ran example", "$ "],
    ["• Called example.tool", "Press Enter to continue"],
    ["vim", "~", ":wq"],
  ])
    assert.equal(nativeTranscriptRepaint(screen), false);
});
const claudeIdle = [
  "",
  "  턴 1060의 설명입니다. Harbor 터미널 출력과 대화 기록이 같은 화면에서 이어지는지 확인하기 위한 합성 문장입니다.",
  "  stable while the prompt changes (item 1060).",
  "",
  rule,
  "❯",
  rule,
  "  ⏸ manual mode on · ? for shortcuts · ← for agents",
];
const claudeWorking = [
  "",
  "● 작업 1단계를 실행합니다. 출력이 길어도 화면이 잘리지 않아야 합니다.",
  "",
  "  Capturing round 1",
  '  ⎿  $ for i in $(seq 1 45); do echo "capture round 1 line $i"; sleep 0.02; done',
  "",
  "✢ Marinating… (3s · ↓ 47 tokens)",
  "",
  rule,
  "❯ que",
  rule,
  "  ⏸ manual mode on",
];
const claudeApproval = [
  "● 작업 1단계를 실행합니다. 출력이 길어도 화면이 잘리지 않아야 합니다.",
  "",
  "  Capturing round 1",
  '  ⎿  $ for i in $(seq 1 45); do echo "capture round 1 line $i"; sleep 0.02; done',
  "",
  rule,
  " Bash command",
  " Capture round 1",
  "╌".repeat(20),
  ' │ for i in $(seq 1 45); do echo "capture round 1 line $i"; sleep 0.02; done',
  "╌".repeat(20),
  " A variable in this command can't be checked before it runs",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. No",
  "",
  " Esc to cancel · Tab to amend",
];
const codexStreaming = [
  "• Streaming line 1: Codex keeps writing a long answer.",
  "  Streaming line 2: Codex keeps writing a long answer.",
  "",
  "",
  "",
  "› Ask Codex to do anything",
  "",
  "  gpt-5.4 default · ~\\workspace",
  "  ← for agents · ? for shortcuts",
];
const codexDone = [
  "  CODEX FINAL ANSWER END.",
  "",
  "  Worked for 7s • 6:26 PM",
  "",
  "",
  "› queued",
  "",
  "  gpt-5.4 default · ~\\workspace",
  "  tab to queue message",
];

test("Claude composer rules, prompt and status form the idle live area", () => {
  assert.deepEqual(nativeChrome(claudeIdle), { start: 4, framed: true });
});

test("Claude spinner stays with the composer while running work remains output", () => {
  assert.deepEqual(nativeChrome(claudeWorking), { start: 6, framed: true });
  assert.equal(lastNativeBlock(claudeWorking, 6), 1);
});

test("finished Claude status line belongs to the live area", () => {
  const done = [
    "  마지막 문장입니다: CAPTURE FINAL ANSWER END.",
    "",
    "✻ Churned for 8s · done 오후 5:15",
    "",
    rule,
    "❯ queued",
    rule,
    "  ⏸ manual mode on",
  ];
  assert.deepEqual(nativeChrome(done), { start: 2, framed: true });
});

test("a Claude permission dialog is enclosed from its top rule", () => {
  assert.deepEqual(nativeChrome(claudeApproval), { start: 5, framed: true });
});

test("todo lines under the spinner stay in the live area, tool output does not", () => {
  const lines = [
    "  ⎿  $ npm test",
    "",
    "✶ Running tests… (12s · ↑ 1.2k tokens)",
    "  ⎿  ☐ Write tests",
    "     ☒ Run build",
    "",
    rule,
    "❯",
    rule,
    "  ? for shortcuts",
  ];
  assert.deepEqual(nativeChrome(lines), { start: 2, framed: true });
});

test("Codex composer, footer and work status form the live area", () => {
  assert.deepEqual(nativeChrome(codexStreaming), { start: 5, framed: false });
  assert.deepEqual(nativeChrome(codexDone), { start: 2, framed: false });
});

test("a Codex prompt in its transcript far above the footer is not the composer", () => {
  const lines = [
    "› RUN CODEX CAPTURE",
    "",
    "• answer line",
    ...Array.from({ length: 10 }, (_, i) => `  continued ${i}`),
  ];
  assert.equal(nativeChrome(lines), undefined);
});

test("unknown screens keep the native fallback", () => {
  assert.equal(nativeChrome(["vim buffer", "~", "~", ":wq"]), undefined);
  assert.equal(nativeChrome(["", "", ""]), undefined);
});

test("a Codex transcript prompt above unindented output is not the composer", () => {
  assert.equal(
    nativeChrome([
      "› SYNTHETIC QUESTION",
      "LIVE NATIVE WORK",
      "PARTIAL NATIVE ANSWER",
      "• Working (2s • esc to interrupt)",
    ]),
    undefined,
  );
  assert.deepEqual(
    nativeChrome([
      "› SYNTHETIC QUESTION",
      "VERIFIED COMPLETE FINAL ANSWER",
      "• Worked for 2s",
      "› DRAFT",
    ]),
    { start: 2, framed: false },
  );
});

test("the live cursor identifies a long genuinely wrapped Korean composer", () => {
  const prefix = Array.from({ length: 5000 }, (_, i) => `saved output ${i}`);
  const draft = [
    "› 긴 한국어 프롬프트를 입력하면",
    ...Array.from(
      { length: 12 },
      (_, i) => `다음 줄 ${i}도 같은 입력에 속합니다.`,
    ),
  ];
  const lines = [...prefix, ...draft, "", "  ? for shortcuts"];
  const wrapped = lines.map(
    (_, row) => row > prefix.length && row < prefix.length + draft.length,
  );
  for (const cursorRow of [prefix.length + 2, prefix.length + draft.length - 1])
    assert.deepEqual(
      nativeChrome(lines, lines.length, {
        cursorRow,
        cursorColumn: 12,
        baseY: 4990,
        wrapped,
        bracketedPasteMode: true,
      }),
      { start: prefix.length, framed: false },
      "editing in the middle or at the end keeps the same composer boundary",
    );
});

test("cursor-positioned multiline drafts require input mode and a real footer", () => {
  const draft = [
    "› 여러 줄 입력",
    ...Array.from({ length: 10 }, (_, i) => `  한국어 줄 ${i}`),
  ];
  const lines = [
    "• Previous output",
    "",
    ...draft,
    "",
    "  gpt-5.4 default · ~/workspace",
    "  ← for agents · ? for shortcuts",
  ];
  const frame = {
    cursorRow: 5,
    cursorColumn: 8,
    baseY: 0,
    wrapped: lines.map(() => false),
    bracketedPasteMode: true,
  };
  assert.deepEqual(nativeChrome(lines, lines.length, frame), {
    start: 2,
    framed: false,
  });
  assert.equal(
    nativeChrome(lines, lines.length, { ...frame, bracketedPasteMode: false }),
    undefined,
  );
  assert.equal(
    nativeChrome(lines.slice(0, -3), lines.length - 3, frame),
    undefined,
  );
  assert.equal(
    nativeChrome(lines, lines.length, {
      ...frame,
      cursorRow: lines.length - 1,
    }),
    undefined,
  );
  assert.equal(
    nativeChrome(lines, lines.length, { ...frame, baseY: 3 }),
    undefined,
    "a prompt in scrollback cannot own the live cursor",
  );
  const blank = [...lines];
  const withGoal = [...lines.slice(0, -1),
    "  ← for agents · ? for shortcuts     Goal achieved (6h 40m) · ⚠ 1 warning · f2 to view"];
  assert.equal(nativeChrome(withGoal, withGoal.length, frame)?.start, 2);
  blank[frame.cursorRow] = "";
  assert.deepEqual(
    nativeChrome(blank, blank.length, frame),
    { start: 2, framed: false },
    "an explicit empty draft line does not switch to the full-output fallback",
  );
});

test("cursor evidence never crosses ordinary output to an old transcript prompt", () => {
  const lines = [
    "› Earlier question",
    "• Unsaved answer must remain visible",
    ...Array.from({ length: 10 }, (_, i) => `  unsaved continuation ${i}`),
    "",
    "  ? for shortcuts",
  ];
  assert.equal(
    nativeChrome(lines, lines.length, {
      cursorRow: 10,
      cursorColumn: 8,
      baseY: 0,
      wrapped: lines.map(() => false),
      bracketedPasteMode: true,
    }),
    undefined,
  );
});

test("long positioned drafts recognize the native warning suffix without accepting arbitrary output", () => {
  for (const [suffix, recognized] of [
    ["   ⚠ 1 warning · f2 to view", true],
    [" · ⚠ 2 warnings", true],
    [" · Unsaved answer text", false],
  ] as const) {
    const lines = [
      "› 여러 줄 입력",
      ...Array.from({ length: 10 }, (_, i) => `  한국어 줄 ${i}`),
      "",
      `  ← for agents · ? for shortcuts${suffix}`,
    ];
    assert.deepEqual(
      nativeChrome(lines, lines.length, {
        cursorRow: 10,
        cursorColumn: 8,
        baseY: 0,
        wrapped: lines.map(() => false),
        bracketedPasteMode: true,
      }),
      recognized ? { start: 0, framed: false } : undefined,
      suffix,
    );
  }
});
