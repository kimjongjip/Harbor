import test from "node:test";
import assert from "node:assert/strict";
import headless from "@xterm/headless";
import type { Terminal } from "@xterm/xterm";
import {
  nativeFlowFrame,
  nativeFlowRows,
  nativeFlowCursorOffset,
  nativeFlowLinkAt,
  NativeFlowReader,
} from "./terminal-native-flow";

test("native flow preserves exact styled output and wide-cell cursor without writes or resizes", async () => {
  const term = new headless.Terminal({
    cols: 60,
    rows: 8,
    allowProposedApi: true,
  });
  try {
    await new Promise<void>((resolve) =>
      term.write(
        "\x1b[31;1mRan 한글🙂\x1b[0m\r\n  exact output\r\n› 미전송🙂",
        resolve,
      ),
    );
    const typed = term as unknown as Terminal;
    const before = Array.from({ length: term.buffer.active.length }, (_, row) =>
      term.buffer.active.getLine(row)!.translateToString(false),
    );
    const frame = nativeFlowFrame(typed);
    assert.equal(frame.lines[0], "Ran 한글🙂");
    assert.equal(frame.cursorRow, 2);
    const offset = nativeFlowCursorOffset(
      term.buffer.active.getLine(frame.cursorRow) as any,
      frame.cursorColumn,
    );
    assert.equal(offset, "› 미전송🙂".length);
    const rows = nativeFlowRows(typed, frame, 0);
    assert.equal(rows[0][0].style.fontWeight, 700);
    assert.equal(
      rows[0]
        .map((run) => run.text)
        .join("")
        .trimEnd(),
      frame.lines[0],
    );
    assert.deepEqual(
      Array.from({ length: term.buffer.active.length }, (_, row) =>
        term.buffer.active.getLine(row)!.translateToString(false),
      ),
      before,
    );
    assert.deepEqual([term.cols, term.rows], [60, 8]);
  } finally {
    term.dispose();
  }
});

test("native capture reuses scrollback while tracking trim, color-only updates, erase, resize and alternate buffers", async () => {
  const term = new headless.Terminal({
    cols: 40,
    rows: 8,
    scrollback: 32,
    allowProposedApi: true,
  });
  const typed = term as unknown as Terminal;
  const reader = new NativeFlowReader(typed);
  const write = (text: string) =>
    new Promise<void>((resolve) => term.write(text, resolve));
  const capture = () => {
    const frame = reader.frame(),
      rows = reader.rows(frame, 0);
    assert.deepEqual(frame, nativeFlowFrame(typed));
    assert.deepEqual(rows, nativeFlowRows(typed, frame, 0));
    return { frame, rows };
  };
  try {
    await write(
      Array.from({ length: 55 }, (_, i) => `line ${i}\r\n`).join("") + "prompt",
    );
    const first = capture();
    await write("x");
    const second = capture();
    assert.equal(
      second.rows[0],
      first.rows[0],
      "unchanged styled history retains its identity",
    );
    const cursorRow = second.frame.cursorRow;
    await write("\r\x1b[31mpromptx\x1b[0m");
    const colorOnly = capture();
    assert.equal(
      colorOnly.frame.lines[cursorRow],
      second.frame.lines[cursorRow],
    );
    assert.notEqual(colorOnly.rows[cursorRow], second.rows[cursorRow]);
    assert.equal(colorOnly.rows[cursorRow][0].style.color, "#cd0000");
    await write("\r\nnew row\r\nnext");
    const trimmed = capture();
    assert.equal(
      trimmed.frame.baseY,
      first.frame.baseY,
      "full scrollback keeps baseY constant",
    );
    assert.notEqual(
      trimmed.frame.lines[0],
      first.frame.lines[0],
      "marker tracks the trimmed prefix",
    );
    typed.options.theme = {
      foreground: "#123456",
      background: "#abcdef",
      red: "#aabbcc",
    };
    const themed = capture();
    assert.equal(themed.rows[0][0].style.color, "#123456");
    await write("\x1b[3J");
    capture();
    term.resize(25, 10);
    capture();
    await write("\x1b[?1049hALT\x1b[41m\x1b[K");
    capture();
    await write("\x1b[?1049l");
    capture();
    term.reset();
    await write("after reset");
    capture();
  } finally {
    reader.dispose();
    assert.equal(term.markers.length, 0);
    term.dispose();
  }
});

test("typing reads styles only in the live viewport, not thousands of history rows", async () => {
  const term = new headless.Terminal({
    cols: 100,
    rows: 25,
    scrollback: 6000,
    allowProposedApi: true,
  });
  const typed = term as unknown as Terminal;
  const reader = new NativeFlowReader(typed);
  const write = (text: string) =>
    new Promise<void>((resolve) => term.write(text, resolve));
  try {
    await write(
      Array.from({ length: 5000 }, (_, i) => `history ${i}\r\n`).join("") +
        "› ",
    );
    const frame = reader.frame();
    const rows = reader.rows(frame, 0);
    const buffer = term.buffer.active,
      getLine = buffer.getLine.bind(buffer);
    let historyCells = 0,
      liveCells = 0,
      historyText = 0;
    buffer.getLine = (row: number) => {
      const line = getLine(row);
      if (!line) return line;
      const getCell = line.getCell.bind(line),
        translate = line.translateToString.bind(line);
      line.getCell = (...args: Parameters<typeof getCell>) => {
        if (row < buffer.baseY) historyCells++;
        else liveCells++;
        return getCell(...args);
      };
      line.translateToString = (...args: Parameters<typeof translate>) => {
        if (row < buffer.baseY) historyText++;
        return translate(...args);
      };
      return line;
    };
    await write("typing 한글🙂");
    const next = reader.frame(),
      nextRows = reader.rows(next, 0);
    assert.equal(historyCells, 0);
    assert.equal(historyText, 0);
    assert.ok(liveCells <= term.rows * term.cols, String(liveCells));
    assert.equal(nextRows[0], rows[0]);
    assert.ok(next.lines.at(-1)?.endsWith("typing 한글🙂"));
    // Expanding a previously hidden prefix still reads the real history.
    reader.dispose();
    const partial = new NativeFlowReader(typed);
    const initial = partial.frame();
    partial.rows(initial, initial.baseY);
    await write("!");
    const expanded = partial.frame();
    assert.equal(
      partial
        .rows(expanded, 0)[0]
        .map((run) => run.text)
        .join("")
        .trimEnd(),
      "history 0",
    );
    partial.dispose();
  } finally {
    reader.dispose();
    term.dispose();
  }
});

test("native links cross real wraps but never independent terminal lines", async () => {
  const term = new headless.Terminal({
    cols: 35,
    rows: 10,
    allowProposedApi: true,
  });
  try {
    await new Promise<void>((resolve) =>
      term.write(
        "문서 /project/subdirectory/documents/README.md:12\r\nhttps://example.test/really-long/path/report.html\r\nplain text\r\nnot-a-link",
        resolve,
      ),
    );
    const frame = nativeFlowFrame(term as unknown as Terminal);
    const wrapped = frame.wrapped.findIndex((value) => value);
    assert.ok(wrapped > 0);
    assert.equal(
      nativeFlowLinkAt(frame, wrapped, 2),
      "/project/subdirectory/documents/README.md:12",
    );
    const webRow = frame.lines.findIndex((line) => line.startsWith("https:"));
    assert.equal(
      nativeFlowLinkAt(frame, webRow + 1, 2),
      "https://example.test/really-long/path/report.html",
    );
    assert.equal(
      nativeFlowLinkAt(frame, frame.lines.indexOf("plain text"), 1),
      undefined,
    );
    assert.equal(
      nativeFlowLinkAt(frame, frame.lines.indexOf("not-a-link"), 2),
      undefined,
    );
  } finally {
    term.dispose();
  }
});
