import test from "node:test";
import assert from "node:assert/strict";
import { TerminalCompletionCue } from "./terminal-completion-cue";

test("initial replay and subsequent draft edits do not reread old completion", () => {
  const cue = new TerminalCompletionCue();
  assert.equal(cue.observe([""]), false);
  assert.equal(cue.observe(["Saved answer", "• Worked for 1m 3s", "›"]), false);
  for (const draft of ["new", "new prompt", "new prompt 한글🙂"])
    assert.equal(
      cue.observe(["Saved answer", "• Worked for 1m 3s", `› ${draft}`]),
      false,
    );
});

test("a new footer requests once and supports repeated durations on new answers", () => {
  const cue = new TerminalCompletionCue();
  assert.equal(
    cue.observe(["› task", "• Working (2s • esc to interrupt)"]),
    false,
  );
  assert.equal(
    cue.observe(["First answer", "─ Worked for 2s ─", "› draft"]),
    true,
  );
  assert.equal(
    cue.observe(["First answer", "─ Worked for 2s ─", "› changed"]),
    false,
  );
  assert.equal(
    cue.observe(["Another answer", "─ Worked for 2s ─", "› changed"]),
    true,
  );
  assert.equal(cue.observe(["Another answer", "─ Worked for 2s ─"]), false);
});

test("an absent footer rearms the same completion while working output is never proof", () => {
  const cue = new TerminalCompletionCue();
  cue.observe(["Answer", "Worked for 40s"]);
  assert.equal(
    cue.observe(["Working (5s)", "Allow this command?", "1. Yes"]),
    false,
  );
  assert.equal(cue.observe(["Answer", "Worked for 40s"]), true);
});

test("ordinary text, Claude footers and old scrollback do not create completion cues", () => {
  const cue = new TerminalCompletionCue();
  cue.observe(["› hello"]);
  for (const text of [
    "I worked for 2s yesterday",
    "Worked for an hour",
    "Baked for 2s · done",
    "• Working (2s)",
    "› Worked for 2s",
  ])
    assert.equal(cue.observe([text]), false);
  assert.equal(
    cue.observe([
      "Answer",
      "Worked for 2s",
      ...Array.from({ length: 90 }, (_, i) => `output ${i}`),
    ]),
    false,
  );
});

test("empty first capture waits for replay instead of generating an extra initial fetch", () => {
  const cue = new TerminalCompletionCue();
  assert.equal(cue.observe([]), false);
  assert.equal(cue.observe([" ", ""]), false);
  assert.equal(cue.observe(["Existing answer", "Worked for 1m 10s"]), false);
});

test("Codex completion footer may include compact duration and a display time", () => {
  const cue = new TerminalCompletionCue();
  cue.observe(["Working"]);
  assert.equal(cue.observe(["Answer", "• Worked for 1m15s · 3:18 PM"]), true);
  assert.equal(
    cue.observe(["Answer", "• Worked for 1m15s · 3:18 PM", "› draft"]),
    false,
  );
});
