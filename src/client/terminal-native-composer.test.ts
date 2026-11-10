import test from "node:test";
import assert from "node:assert/strict";
import headless from "@xterm/headless";
import type { Terminal } from "@xterm/xterm";
import { nativeFlowFrame } from "./terminal-native-flow";
import { nativeComposerFill } from "./terminal-native-composer";

test("Codex composer fallback belongs only to the live default-background prompt", async () => {
  const term = new headless.Terminal({
    cols: 24,
    rows: 8,
    allowProposedApi: true,
  });
  const typed = term as unknown as Terminal;
  const write = (value: string) =>
    new Promise<void>((resolve) => term.write(value, resolve));
  const fill = () => nativeComposerFill(typed, nativeFlowFrame(typed));
  const reset = async (value: string) => {
    term.reset();
    await write(value);
  };
  try {
    await write("› draft");
    assert.equal(
      fill(),
      undefined,
      "ordinary shell output is not a Codex input mode",
    );
    await write("\x1b[?2004h");
    assert.deepEqual(fill(), {
      first: 0,
      last: 0,
      color: "color-mix(in srgb, #ffffff 92%, #20242c 8%)",
    });
    const before = term.buffer.active.getLine(0)!.translateToString(false);
    fill();
    assert.equal(
      term.buffer.active.getLine(0)!.translateToString(false),
      before,
    );
    for (const prompt of ["› ", "❯ draft", "» draft", "> draft"]) {
      await reset("\x1b[?2004h" + prompt);
      assert.equal(fill()?.first, 0);
    }
    await reset("\x1b[?2004h› " + "x".repeat(30));
    assert.deepEqual(
      [fill()?.first, fill()?.last],
      [0, 1],
      "genuine wrapped draft stays together",
    );
    await reset(
      "\x1b[?1049h\x1b[?2004h\x1b[4;1H› 직접 배치한 입력\x1b[5;1H  두 번째 줄 한글\x1b[7;1H  GPT-6-Astra max\x1b[8;1H  ? for shortcuts\x1b[5;18H",
    );
    assert.deepEqual(
      [fill()?.first, fill()?.last],
      [3, 4],
      "cursor-positioned multiline drafts receive one continuous fill",
    );
    assert.equal(term.buffer.active.getLine(4)?.isWrapped, false);
    await reset("\x1b[?2004h› previous\r\nTool output");
    assert.equal(
      fill(),
      undefined,
      "an earlier prompt cannot claim an output row",
    );
    await reset("\x1b[?2004h› previous\r\n\r\nWorking");
    assert.equal(fill(), undefined);
    await reset("\x1b[?2004h❯ Allow once\r");
    assert.equal(
      fill(),
      undefined,
      "a menu marker before the input position is not a draft",
    );
    await reset("\x1b[?2004h\x1b[48;2;255;255;255m› explicit\x1b[K");
    assert.equal(fill(), undefined, "even explicit native white has priority");
    await reset("\x1b[?2004h\x1b[7m› inverse\x1b[K");
    assert.equal(fill(), undefined, "inverse selection has priority");
    await reset("\x1b[?2004h› draft");
    typed.options.theme = { foreground: "#e6e8ee", background: "#181b21" };
    assert.equal(fill()?.color, "color-mix(in srgb, #181b21 92%, #e6e8ee 8%)");
  } finally {
    term.dispose();
  }
});
