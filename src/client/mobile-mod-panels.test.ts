import test from "node:test";
import assert from "node:assert/strict";
import headless from "@xterm/headless";
import {
  nativeKeptSpans,
  projectNativeRow,
  claudeModPanels,
  type NativePanelRectangle,
} from "./mobile/claude-mod-panels";

test("panel projection subtracts immutable cell rectangles for only their rows", () => {
  const panels: readonly NativePanelRectangle[] = Object.freeze([
    Object.freeze({ top: 1, bottom: 4, left: 15, right: 30 }),
    Object.freeze({ top: 2, bottom: 3, left: 12, right: 18 }),
    Object.freeze({ top: 2, bottom: 3, left: 3, right: 6 }),
  ]);
  assert.deepEqual(nativeKeptSpans(24, 0, panels), [{ start: 0, end: 24 }]);
  assert.deepEqual(nativeKeptSpans(24, 1, panels), [{ start: 0, end: 15 }]);
  assert.deepEqual(nativeKeptSpans(24, 2, panels), [
    { start: 0, end: 3 },
    { start: 6, end: 12 },
  ]);
  assert.deepEqual(nativeKeptSpans(24, 4, panels), [{ start: 0, end: 24 }]);
});

test("panel projection preserves Unicode, styles, inline suffixes and the source buffer", async () => {
  const term = new headless.Terminal({
    cols: 48,
    rows: 6,
    allowProposedApi: true,
  });
  try {
    await new Promise<void>((resolve) =>
      term.write(
        "\x1b[31;1m한글🙂e\u0301 MAIN\x1b[0m\x1b[1;25HMOD WIDGET\r\n" +
          "\x1b[2;25HMOD ONLY\r\n" +
          "LEFT\x1b[3;13HINLINE\x1b[3;25H\x1b[34mRIGHT 🙂\x1b[0m\r\n" +
          "APPROVAL: allow this command?",
        resolve,
      ),
    );
    const buffer = term.buffer.active;
    const before = Array.from({ length: buffer.length }, (_, row) =>
      buffer.getLine(row)!.translateToString(false),
    );
    const panels = [
      { top: 0, bottom: 2, left: 24, right: 48 },
      { top: 2, bottom: 3, left: 12, right: 20 },
    ];
    const first = projectNativeRow(buffer.getLine(0), 48, 0, panels, {
      red: "#ab0000",
    });
    assert.equal(
      first.runs
        .map((run) => run.text)
        .join("")
        .trimEnd(),
      "한글🙂e\u0301 MAIN",
    );
    assert.equal(first.runs[0].style.color, "#ab0000");
    assert.equal(first.runs[0].style.fontWeight, 700);
    assert.equal(first.hidden, false);
    assert.equal(
      projectNativeRow(buffer.getLine(1), 48, 1, panels, {}).hidden,
      true,
    );
    const inline = projectNativeRow(buffer.getLine(2), 48, 2, panels, {});
    assert.equal(
      inline.runs
        .map((run) => run.text)
        .join("")
        .trimEnd(),
      "LEFT" + " ".repeat(20) + "RIGHT 🙂",
    );
    assert.equal(
      inline.runs.find((run) => run.text.startsWith("RIGHT"))?.style.color,
      "#0000ee",
    );
    const approval = projectNativeRow(buffer.getLine(3), 48, 3, panels, {});
    assert.match(
      approval.runs.map((run) => run.text).join(""),
      /^APPROVAL: allow this command\?/,
    );
    assert.equal(approval.hidden, false);
    assert.deepEqual(
      Array.from({ length: buffer.length }, (_, row) =>
        buffer.getLine(row)!.translateToString(false),
      ),
      before,
    );
  } finally {
    term.dispose();
  }
});

test("cell-boundary clipping blanks partial wide glyphs and keeps complete emoji", async () => {
  const term = new headless.Terminal({
    cols: 20,
    rows: 2,
    allowProposedApi: true,
  });
  try {
    await new Promise<void>((resolve) => term.write("A한🙂Z", resolve));
    const line = term.buffer.active.getLine(0);
    const text = (left: number, right: number) =>
      projectNativeRow(line, 20, 0, [{ top: 0, bottom: 1, left, right }], {})
        .runs.map((run) => run.text)
        .join("")
        .trimEnd();
    assert.equal(text(2, 3), "A  🙂Z");
    assert.equal(text(1, 2), "A  🙂Z");
    // This xterm Unicode provider gives the emoji one cell despite two UTF-16 units.
    assert.equal(text(3, 4), "A한 Z");
    assert.equal(text(4, 5), "A한🙂");
  } finally {
    term.dispose();
  }
});

function nativeFrame(columns: number, pane = true, band = true) {
  const lines = Array.from({ length: 38 }, () => "");
  const dock = columns === 160 && pane ? 109 : undefined;
  const width = dock ?? columns;
  lines[0] = "MAIN ANSWER";
  lines[4] = "+ const result = 42;";
  if (pane && dock === undefined) {
    const top = band ? 21 : 26;
    lines[top] = "╭" + "─".repeat(columns - 4) + "✕─╮";
    for (let row = top + 1; row < top + 6; row++)
      lines[row] = "│" + "PANE BODY".padEnd(columns - 2) + "│";
    lines[top + 6] = "╰" + "─".repeat(columns - 2) + "╯";
  }
  if (band) {
    lines[28] = "PET BAND".padEnd(width - 4) + "[-] ";
    lines[29] = "  (=^.^=)";
    lines[32] = "BAND LAST ROW";
  }
  if (dock !== undefined)
    for (let row = 0; row < 34; row++)
      lines[row] =
        lines[row].padEnd(dock) +
        "│" +
        (row === 0 ? " ".repeat(columns - dock - 3) + "✕ " : "PANE BODY");
  lines[34] = "─".repeat(columns);
  lines[35] = "❯\u00a0 ";
  lines[36] = "─".repeat(columns);
  lines[37] = "  ? for shortcuts";
  return lines;
}

async function writeFrame(
  term: InstanceType<typeof headless.Terminal>,
  lines: string[],
  cursor = [35, 2],
) {
  await new Promise<void>((resolve) =>
    term.write(
      "\x1b[?1049h\x1b[2J" +
        lines.map((line, row) => `\x1b[${row + 1};1H${line}`).join("") +
        `\x1b[${cursor[0] + 1};${cursor[1] + 1}H`,
      resolve,
    ),
  );
}

test("native Mods chrome recognizes docked, inline, band-only and pane-only layouts", async () => {
  for (const [columns, pane, band] of [
    [160, true, true],
    [100, true, true],
    [100, false, true],
    [100, true, false],
  ] as const) {
    const term = new headless.Terminal({
      cols: columns,
      rows: 38,
      allowProposedApi: true,
    });
    try {
      await writeFrame(term, nativeFrame(columns, pane, band));
      const panels = claudeModPanels(term.buffer.active, columns, 38);
      assert.equal(panels.length, Number(pane) + Number(band));
      const projected = Array.from({ length: 38 }, (_, row) =>
        projectNativeRow(
          term.buffer.active.getLine(row),
          columns,
          row,
          panels,
          {},
        )
          .runs.map((run) => run.text)
          .join(""),
      ).join("\n");
      assert.match(projected, /MAIN ANSWER/);
      assert.match(projected, /const result = 42/);
      assert.match(projected, /❯/);
      assert.doesNotMatch(projected, /PANE BODY|PET BAND|BAND LAST ROW|\[-\]/);
    } finally {
      term.dispose();
    }
  }
});

test("native Mods recognition preserves ordinary boxes, partial frames and modals", async () => {
  const term = new headless.Terminal({
    cols: 100,
    rows: 38,
    allowProposedApi: true,
  });
  try {
    const ordinary = nativeFrame(100, true, false);
    ordinary[26] = ordinary[26].replace("✕", "─");
    await writeFrame(term, ordinary);
    assert.deepEqual(claudeModPanels(term.buffer.active, 100, 38), []);

    const incomplete = nativeFrame(100);
    incomplete[36] = "";
    await writeFrame(term, incomplete);
    assert.deepEqual(claudeModPanels(term.buffer.active, 100, 38), []);

    const modal = nativeFrame(100);
    modal[35] = "Do you want to allow this command?";
    await writeFrame(term, modal);
    assert.deepEqual(claudeModPanels(term.buffer.active, 100, 38), []);
  } finally {
    term.dispose();
  }
});

test("classic native Mods frames may end above the viewport bottom and park the cursor in a panel", async () => {
  const term = new headless.Terminal({
    cols: 100,
    rows: 38,
    allowProposedApi: true,
  });
  try {
    const lines = nativeFrame(100);
    const compact = [
      "MAIN ANSWER",
      ...lines.slice(21),
      ...Array<string>(20).fill(""),
    ];
    await writeFrame(term, compact, [4, 5]);
    const panels = claudeModPanels(term.buffer.active, 100, 38);
    assert.deepEqual(panels, [
      { top: 8, bottom: 14, left: 0, right: 100 },
      { top: 1, bottom: 8, left: 0, right: 100 },
    ]);
    assert.equal(
      projectNativeRow(term.buffer.active.getLine(0), 100, 0, panels, {})
        .hidden,
      false,
    );
  } finally {
    term.dispose();
  }
});

test("collapsed native bands disappear without matching similar transcript text", async () => {
  const term = new headless.Terminal({
    cols: 100,
    rows: 38,
    allowProposedApi: true,
  });
  try {
    const lines = nativeFrame(100, false, false);
    lines[5] =
      "Example: ▸ plugin panel hidden · ctrl+x ctrl+a or click to show";
    lines[32] = "▸ plugin panel hidden · ctrl+x ctrl+a or click to show";
    await writeFrame(term, lines);
    const panels = claudeModPanels(term.buffer.active, 100, 38);
    assert.deepEqual(panels, [{ top: 32, bottom: 34, left: 0, right: 100 }]);
    assert.equal(
      projectNativeRow(term.buffer.active.getLine(5), 100, 5, panels, {})
        .hidden,
      false,
    );
  } finally {
    term.dispose();
  }
});
