import test from "node:test";
import assert from "node:assert/strict";
import {
  lastNativeBlock,
  nativeChrome,
  nativeTranscriptRepaint,
} from "./terminal-native-chrome";

// Bottom rows recorded from real fullscreen CLIs (Claude Code 2.1.319, Codex
// 0.167.0) in an isolated workspace with synthetic prompts; rules shortened.
const rule = "─".repeat(40);
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
