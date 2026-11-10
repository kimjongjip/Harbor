import test from "node:test";
import assert from "node:assert/strict";
import headless from "@xterm/headless";
import type { Terminal } from "@xterm/xterm";
import {
  claudeModSurface,
  frameWithoutModPanels,
} from "./terminal-mod-surface";
import { nativeFlowFrame } from "./terminal-native-flow";

test("Claude idle notices above the composer stay native beside a Mods dock", async () => {
  const terminal = new headless.Terminal({
    cols: 253,
    rows: 44,
    allowProposedApi: true,
  });
  const term = terminal as unknown as Terminal;
  const compaction =
    '● Compacted while idle, before the prompt cache expired ·\u00a0turn off with "idleCompaction": false in settings.json';
  const update = "✔ Update installed · /restart to apply";
  const lines = Array<string>(44).fill("");
  lines[0] = "Synthetic answer remains in the history reader.";
  lines[36] = compaction;
  lines[39] = " ".repeat(140) + update;
  for (let row = 0; row < 40; row++)
    lines[row] +=
      `\x1b[${row + 1};181H│` +
      (row === 0 ? " ".repeat(70) + "✕ " : " ".repeat(72));
  lines[40] = "─".repeat(253);
  lines[41] = "❯ UNSENT DRAFT";
  lines[42] = "─".repeat(253);
  lines[43] = "  ? for shortcuts";
  try {
    await new Promise<void>((done) =>
      terminal.write(
        "\x1b[?1049h" +
          lines.map((line, row) => `\x1b[${row + 1};1H${line}`).join("") +
          "\x1b[42;15H",
        done,
      ),
    );
    const before = nativeFlowFrame(term);
    const surface = claudeModSurface(term)!;
    assert.equal(surface.columns, 180);
    assert.equal(
      surface.end,
      36,
      "both notices stay below the reader's bottom edge",
    );
    assert.deepEqual(
      nativeFlowFrame(term),
      before,
      "footer detection never changes native cells or draft",
    );
    const replace = (row: number, text: string) =>
      new Promise<void>((done) =>
        terminal.write(
          `\x1b[${row + 1};1H${text.padEnd(180)}\x1b[42;15H`,
          done,
        ),
      );
    await replace(38, "Ordinary transcript output remains readable.");
    assert.equal(
      claudeModSurface(term)?.end,
      39,
      "stop at unrelated output between notices",
    );
    await replace(39, "Explanation: " + update);
    assert.equal(
      claudeModSurface(term)?.end,
      40,
      "a quoted phrase inside ordinary text is not a footer",
    );
    await replace(38, "");
    await replace(39, "");
    assert.equal(
      claudeModSurface(term)?.end,
      36,
      "compaction can appear without an update notice",
    );
    await replace(
      36,
      "● Compacted while idle, before the prompt cache expired · turn off with",
    );
    await replace(37, '  "idleCompaction": false in settings.json');
    await replace(38, "✔ Update installed · /restart");
    await replace(39, "  to apply");
    assert.equal(
      claudeModSurface(term)?.end,
      36,
      "explicitly positioned continuation rows remain native",
    );
    for (let row = 36; row < 40; row++) await replace(row, "");
    assert.equal(
      claudeModSurface(term)?.end,
      40,
      "reader space returns when notices disappear",
    );
    await new Promise<void>(done=>terminal.write("\x1b[35;1H\x1b[2K\x1b[36;1H\x1b[2K  ❯ /help     Show help\x1b[37;1H\x1b[2K    /theme    Change theme\x1b[38;1H\x1b[2K    /doctor   Check setup\x1b[39;1H\x1b[2K\x1b[40;1H\x1b[2K\x1b[42;1H\x1b[2K❯\u00a0/he ",done));
    const menu=claudeModSurface(term);
    assert.equal(menu?.columns,180);
    assert.equal(menu?.end,34,"slash picker remains native below the reader");
    assert.equal(menu?.panels[0].bottom,34,"dock is preserved above the picker overlay");
    await new Promise<void>(done=>terminal.write("\x1b[36;1H\x1b[2K  Ordinary transcript output",done));
    assert.equal(claudeModSurface(term),undefined,"a broken dock without a native picker still fails closed");
  } finally {
    terminal.dispose();
  }
});

test("Claude dock and multiline composer remain outside the history surface without modifying native output", async () => {
  const terminal = new headless.Terminal({
    cols: 160,
    rows: 40,
    allowProposedApi: true,
  });
  const term = terminal as unknown as Terminal;
  const lines = Array<string>(40).fill("");
  lines[0] = "MAIN ANSWER 한글";
  lines[28] = "BAND".padEnd(105) + "[-] ";
  lines[29] = "PET ANIMATION";
  for (let row = 0; row < 34; row++)
    lines[row] =
      lines[row] +
      `\x1b[${row + 1};110H` +
      "│" +
      (row === 0 ? " ".repeat(48) + "✕ " : "CONTEXT 42% · CREW");
  lines[34] = "─".repeat(160);
  lines[35] = "❯ first draft line";
  lines[36] = "  second draft line";
  lines[37] = "─".repeat(160);
  lines[38] = "  ? for shortcuts";
  try {
    await new Promise<void>((done) =>
      terminal.write(
        "\x1b[?1049h" +
          lines.map((line, row) => `\x1b[${row + 1};1H${line}`).join("") +
          "\x1b[37;5H",
        done,
      ),
    );
    const before = nativeFlowFrame(term);
    const surface = claudeModSurface(term)!;
    assert.equal(surface.columns, 109);
    assert.equal(surface.end, 28);
    const projected = frameWithoutModPanels(term, before, surface);
    assert.equal(projected.lines[0], "MAIN ANSWER 한글");
    assert.doesNotMatch(
      projected.lines.join("\n"),
      /CREW|CONTEXT|PET ANIMATION|BAND/,
    );
    assert.match(projected.lines.join("\n"), /second draft line/);
    assert.deepEqual(
      nativeFlowFrame(term),
      before,
      "the original buffer and cursor stay intact",
    );
    await new Promise<void>((done) =>
      terminal.write("\x1b[36;1H\x1b[2KAllow this command?", done),
    );
    assert.equal(
      claudeModSurface(term),
      undefined,
      "a modal is not a panel/composer layout",
    );
  } finally {
    terminal.dispose();
  }
});
