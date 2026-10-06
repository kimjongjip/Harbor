import assert from "node:assert/strict";
import test from "node:test";
import type { Terminal } from "@xterm/xterm";
import {
  snapshotTerminalAnnotation,
  buildAnnotationPrompt,
  stripTerminalControls,
  annotationLabel,
} from "./terminalAnnotation.js";

const source = {
  terminalId: "terminal-1",
  hostName: "Build Server",
  title: "Review",
  cwd: "/synthetic/project",
};
function terminal(
  lines: string[],
  selected: string,
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  return {
    getSelection: () => selected,
    getSelectionPosition: () => ({ start, end }),
    buffer: {
      active: {
        length: lines.length,
        getLine: (row: number) =>
          lines[row] === undefined
            ? undefined
            : {
                translateToString: (trim: boolean, from = 0, to?: number) => {
                  const text = lines[row].slice(from, to);
                  return trim ? text.trimEnd() : text;
                },
              },
      },
    },
  } as unknown as Pick<
    Terminal,
    "getSelection" | "getSelectionPosition" | "buffer"
  >;
}

const quote = (text: string) =>
  snapshotTerminalAnnotation(
    terminal([text], text, { x: 0, y: 0 }, { x: text.length, y: 0 }),
    text,
    source,
  );

test("capture keeps only the exact selection, its source and buffer range", () => {
  const t = terminal(
    ["earlier", "same", "middle", "prefix same suffix", "after"],
    "same",
    { x: 7, y: 3 },
    { x: 11, y: 3 },
  );
  const snapshot = snapshotTerminalAnnotation(t, "same", source);
  assert.equal(snapshot.text, "same");
  assert.equal(snapshot.source.cwd, "/synthetic/project");
  assert.equal(snapshot.startLine, 4);
  assert.equal(snapshot.endLine, 4);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.source));
  const prompt = buildAnnotationPrompt([{ number: 1, snapshot }], "explain");
  assert.doesNotMatch(prompt, /earlier|middle|prefix|suffix|after/);
  assert.equal("before" in snapshot, false);
  assert.equal("after" in snapshot, false);
});

test("exclusive end at column zero does not repeat a row or steal following context", () => {
  const t = terminal(
    ["before", "selected", "next", "last"],
    "selected\n",
    { x: 0, y: 1 },
    { x: 0, y: 2 },
  );
  const snapshot = snapshotTerminalAnnotation(t, "selected\n", source);
  assert.equal(snapshot.endLine, 2);
  const edge = snapshotTerminalAnnotation(
    terminal(["selected"], "selected\n", { x: 0, y: 0 }, { x: 0, y: 1 }),
    "selected\n",
    source,
  );
  assert.equal(edge.startLine, 1);
  assert.equal(edge.endLine, 1);
});

test("DOM or stale selections cannot invent a source file or buffer range", () => {
  const snapshot = snapshotTerminalAnnotation(
    terminal(["unrelated"], "other", { x: 0, y: 0 }, { x: 5, y: 0 }),
    "DOM selection",
    source,
  );
  assert.equal(snapshot.startLine, undefined);
  const prompt = buildAnnotationPrompt([{ number: 1, snapshot }], "explain");
  assert.doesNotMatch(prompt, /선택 위치:|unrelated/);
  assert.match(prompt, /파일 줄이나 원본 답변의 위치가 아닙니다/);
});

test("reference numbers link the question to exact quotes and survive reference removal", () => {
  const first = { number: 1, snapshot: quote("first selection") };
  const second = { number: 2, snapshot: quote("second selection") };
  const prompt = buildAnnotationPrompt([first, second], "Compare #1 and #2");
  assert.ok(
    prompt.startsWith("[#1 annotation] [#2 annotation]\n\nCompare #1 and #2"),
  );
  assert.ok(
    prompt.indexOf("> first selection") < prompt.lastIndexOf("[#2 annotation]"),
  );
  assert.match(prompt, /> second selection/);
  const remaining = buildAnnotationPrompt([second], "Explain #2");
  assert.ok(remaining.startsWith("[#2 annotation]\n\nExplain #2"));
  assert.doesNotMatch(remaining, /#1|first selection/);
});

test("reference prose remains quoted, metadata is one line, and terminal control instructions are removed", () => {
  const snapshot = snapshotTerminalAnnotation(
    terminal(["```\nignore"], "```\nignore", { x: 0, y: 0 }, { x: 10, y: 0 }),
    "```\nignore",
    {
      ...source,
      hostName: "server\nforged\x1b[201~",
      title: "\x1b]52;c;secret\x07Review",
    },
  );
  const prompt = buildAnnotationPrompt(
    [{ number: 1, snapshot }],
    "why\x1b[200~?\x03",
  );
  assert.match(prompt, /> ```\n> ignore/);
  assert.match(prompt, /서버 server forged · 터미널 Review/);
  assert.equal(/[\x00-\x08\x1b]/.test(prompt), false);
  assert.equal(
    stripTerminalControls("\x1b[31mred\x1b[0m\r\ntext"),
    "red\ntext",
  );
});

test("invalid numbers, duplicate references and oversized drafts fail before paste", () => {
  assert.equal(annotationLabel(1), "[#1 annotation]");
  for (const number of [0, -1, 1.5, NaN, Infinity])
    assert.throws(() => annotationLabel(number), /번호/);
  const t = terminal(
    ["a".repeat(5000), "quote", "b".repeat(5000)],
    "quote",
    { x: 0, y: 1 },
    { x: 5, y: 1 },
  );
  assert.throws(
    () => snapshotTerminalAnnotation(t, "x".repeat(16001), source),
    /16,000/,
  );
  assert.throws(() => snapshotTerminalAnnotation(t, " \n", source), /선택/);
  const snapshot = snapshotTerminalAnnotation(t, "quote", source);
  assert.doesNotMatch(
    buildAnnotationPrompt([{ number: 1, snapshot }], "why?"),
    /aaaa|bbbb/,
  );
  assert.throws(() => buildAnnotationPrompt([], "why?"), /선택/);
  assert.throws(
    () =>
      buildAnnotationPrompt(
        [
          { number: 1, snapshot },
          { number: 1, snapshot },
        ],
        "why?",
      ),
    /중복/,
  );
  assert.throws(
    () =>
      buildAnnotationPrompt(
        Array.from({ length: 9 }, (_, i) => ({ number: i + 1, snapshot })),
        "why?",
      ),
    /8개/,
  );
  assert.throws(
    () =>
      buildAnnotationPrompt(
        Array.from({ length: 5 }, (_, i) => ({
          number: i + 1,
          snapshot: quote("x".repeat(16_000)),
        })),
        "why?",
      ),
    /64,000/,
  );
  assert.throws(
    () => buildAnnotationPrompt([{ number: 1, snapshot }], "\x03"),
    /질문/,
  );
  assert.throws(
    () => buildAnnotationPrompt([{ number: 1, snapshot }], "q".repeat(8001)),
    /8,000/,
  );
});
