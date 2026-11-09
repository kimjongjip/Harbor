import test from "node:test";
import assert from "node:assert/strict";
import headless from "@xterm/headless";
import {
  mobileFlowParts,
  nativeRow,
  nativeSeparator,
  clipNativeRuns,
  terminalContentEnd,
} from "./mobile/terminal-flow";
import type { RichTerminalBlock } from "../shared/rich-terminal";

const id = "0123456789abcdef0123";
const block: RichTerminalBlock = {
  id,
  marker: `~HBR:${id}~`,
  requestId: "fixture",
  sessionId: "native",
  text: "canonical",
  columns: 100,
  viewportRows: 30,
  createdAt: 1,
  state: "ready",
  rows: 50,
  renderer: "rows-v2",
};
test("phone borders do not wrap while code punctuation remains literal", () => {
  assert.equal(nativeSeparator("─".repeat(180)), true);
  assert.equal(nativeSeparator("  " + "-".repeat(90)), true);
  for (const text of [
    "const line = '-------------';",
    "--- changed file",
    "a——b",
    "123456789012",
  ])
    assert.equal(nativeSeparator(text), false);
  const runs = [
    { text: "~HBR:0123~", style: { color: "red" } },
    { text: "   한글🙂 suffix", style: { color: "blue" } },
  ];
  const clipped = clipNativeRuns(runs, 13);
  assert.equal(
    clipped.map((run) => run.text).join(""),
    " ".repeat(13) + "한글🙂 suffix",
  );
  assert.equal(clipped[1].style.color, "blue");
  assert.equal(runs[1].text, "   한글🙂 suffix");
});
test("mobile flow emits one full canonical answer and preserves native gaps and suffixes", () => {
  const lines = [
    `~HBR:${id}:35~`,
    "STATUS GAP",
    `~HBR:${id}:39~    NATIVE SUFFIX`,
    `~HBR:${id}:49~`,
    "PROMPT >",
  ];
  const parts = mobileFlowParts(lines, [block])!;
  assert.deepEqual(
    parts.map((p) => p.kind),
    ["answer", "row", "row", "row"],
  );
  assert.deepEqual(parts[0], { kind: "answer", id, block });
  assert.deepEqual(parts[1], { kind: "row", row: 1, start: 0 });
  assert.deepEqual(parts[2], {
    kind: "row",
    row: 2,
    start: lines[2].indexOf("NATIVE"),
  });
  assert.deepEqual(parts[3], { kind: "row", row: 4, start: 0 });
});
test("missing answer waits for authenticated text; ordinary or malformed markers remain native", () => {
  assert.equal(mobileFlowParts([`~HBR:${id}:35~`], [])?.[0].kind, "answer");
  assert.equal(
    (mobileFlowParts([`~HBR:${id}:35~`], [])?.[0] as any).block,
    undefined,
  );
  for (const text of [
    "ORDINARY >",
    `Example: ~HBR:${id}:35~`,
    `~HBR:${id}:50~`,
    `~HBR:${id}:35~x`,
  ])
    assert.equal(mobileFlowParts([text], [block]), undefined);
});
test("native mobile rows retain Unicode, ANSI color, style and right-hand output without changing buffer", async () => {
  const term = new headless.Terminal({
    cols: 100,
    rows: 10,
    allowProposedApi: true,
  });
  try {
    await new Promise<void>((r) =>
      term.write(
        "\x1b[31;1m한글 A\x1b[0m  \x1b[38;2;12;34;56mRGB\x1b[0m\r\n\x1b[7;4;9mINV\x1b[0m\r\nLEFT    RIGHT >",
        r,
      ),
    );
    const buffer = term.buffer.active;
    const before = Array.from({ length: buffer.length }, (_, i) =>
      buffer.getLine(i)!.translateToString(false),
    );
    const first = nativeRow(buffer.getLine(0), term.cols, 0, {
      red: "#ab0000",
    });
    assert.equal(
      first
        .map((r) => r.text)
        .join("")
        .trimEnd(),
      "한글 A  RGB",
    );
    assert.equal(first[0].style.color, "#ab0000");
    assert.equal(first[0].style.fontWeight, 700);
    assert.equal(first.find((r) => r.text === "RGB")?.style.color, "#0c2238");
    const inverse = nativeRow(buffer.getLine(1), term.cols, 0, {});
    assert.equal(inverse[0].style.backgroundColor, "#182235");
    assert.equal(inverse[0].style.textDecoration, "underline line-through");
    assert.equal(
      nativeRow(buffer.getLine(2), term.cols, 8, {})
        .map((r) => r.text)
        .join("")
        .trimEnd(),
      "        RIGHT >",
    );
    assert.equal(terminalContentEnd(buffer), 3);
    assert.deepEqual(
      Array.from({ length: buffer.length }, (_, i) =>
        buffer.getLine(i)!.translateToString(false),
      ),
      before,
    );
  } finally {
    term.dispose();
  }
});
