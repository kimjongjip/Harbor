import test from "node:test";
import assert from "node:assert/strict";
import headless from "@xterm/headless";
import type { Terminal } from "@xterm/xterm";
import {
  claudeModSurface,
  frameWithoutModPanels,
} from "./terminal-mod-surface";
import { nativeFlowFrame } from "./terminal-native-flow";

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
