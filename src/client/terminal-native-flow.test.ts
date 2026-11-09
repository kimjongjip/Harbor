import test from "node:test";
import assert from "node:assert/strict";
import headless from "@xterm/headless";
import type { Terminal } from "@xterm/xterm";
import {
  nativeFlowFrame,
  nativeFlowRows,
  nativeFlowCursorOffset,
  nativeFlowLinkAt,
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
