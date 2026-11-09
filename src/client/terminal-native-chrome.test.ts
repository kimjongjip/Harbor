import test from "node:test";
import assert from "node:assert/strict";
import { lastNativeBlock, nativeChrome } from "./terminal-native-chrome";

// Bottom rows recorded from real fullscreen CLIs (Claude Code 2.1.319, Codex
// 0.167.0) in an isolated workspace with synthetic prompts; rules shortened.
const rule = "─".repeat(40);
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
