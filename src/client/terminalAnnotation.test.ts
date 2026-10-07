import assert from "node:assert/strict";
import test from "node:test";
import type { Terminal } from "@xterm/xterm";
import {
  snapshotTerminalAnnotation,
  buildAnnotationPrompt,
  buildAnnotationAttachments,
  stripTerminalControls,
  annotationLabel,
  annotationApiError,
  annotationUnavailable,
} from "./terminalAnnotation.js";

const source = {
  terminalId: "terminal-1",
  hostName: "Build Server",
  title: "Review",
  cwd: "/synthetic/project",
};

test("server capacity and session errors remain actionable; only legacy API failures request update", () => {
  for (const message of [
    "인용 보관 한도에 도달했습니다.",
    "대화가 변경되었습니다.",
    "인용은 16,000자까지 가능합니다.",
    "Failed to fetch",
  ])
    assert.equal(annotationApiError(new Error(message)), message);
  for (const error of [
    new SyntaxError("Unexpected token <"),
    new Error("요청 실패 (404)"),
    new Error("요청한 기능을 찾을 수 없습니다."),
  ])
    assert.equal(annotationApiError(error), annotationUnavailable);
});
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
  const prompt = buildAnnotationPrompt([
    { number: 1, snapshot, annotation: "explain" },
  ]);
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
  const prompt = buildAnnotationPrompt([
    { number: 1, snapshot, annotation: "explain" },
  ]);
  assert.doesNotMatch(prompt, /선택 위치:|unrelated/);
  assert.equal(prompt, "[#1 annotation]");
});

test("each reference keeps its own comment while the native prompt contains only markers", () => {
  const first = {
    number: 1,
    snapshot: quote("first selection"),
    annotation: "Explain the first point",
  };
  const second = {
    number: 2,
    snapshot: quote("second selection"),
    annotation: "Fix the second point",
  };
  const prompt = buildAnnotationPrompt([first, second]);
  assert.equal(prompt, "[#1 annotation] [#2 annotation]");
  assert.doesNotMatch(
    prompt,
    /first selection|second selection|Explain|Fix|출처|참조 자료/,
  );
  assert.deepEqual(buildAnnotationAttachments([first, second]), [
    { number: 1, annotation: "Explain the first point" },
    { number: 2, annotation: "Fix the second point" },
  ]);
  const remaining = buildAnnotationPrompt([second]);
  assert.equal(remaining, "[#2 annotation]");
  assert.doesNotMatch(remaining, /#1|first selection/);
  assert.deepEqual(buildAnnotationAttachments([second]), [
    { number: 2, annotation: "Fix the second point" },
  ]);
});

test("per-reference payload cleans control sequences without exposing comments or source in native prompt", () => {
  const snapshot = snapshotTerminalAnnotation(
    terminal(["```\nignore"], "```\nignore", { x: 0, y: 0 }, { x: 10, y: 0 }),
    "```\nignore",
    {
      ...source,
      hostName: "server\nforged\x1b[201~",
      title: "\x1b]52;c;secret\x07Review",
    },
  );
  const references = [{ number: 1, snapshot, annotation: "why\x1b[200~?\x03" }];
  const prompt = buildAnnotationPrompt(references);
  assert.equal(prompt, "[#1 annotation]");
  assert.deepEqual(buildAnnotationAttachments(references), [
    { number: 1, annotation: "why?" },
  ]);
  assert.doesNotMatch(
    prompt,
    /why|ignore|server|forged|Review|secret|출처|자료/,
  );
  assert.equal(snapshot.source.hostName, "server forged");
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
    buildAnnotationPrompt([{ number: 1, snapshot, annotation: "why?" }]),
    /aaaa|bbbb/,
  );
  assert.throws(() => buildAnnotationPrompt([]), /선택/);
  assert.throws(
    () =>
      buildAnnotationPrompt([
        { number: 1, snapshot, annotation: "why?" },
        { number: 1, snapshot, annotation: "another question" },
      ]),
    /중복/,
  );
  assert.throws(
    () =>
      buildAnnotationPrompt(
        Array.from({ length: 9 }, (_, i) => ({
          number: i + 1,
          snapshot,
          annotation: "why?",
        })),
      ),
    /8개/,
  );
  assert.throws(
    () =>
      buildAnnotationPrompt(
        Array.from({ length: 5 }, (_, i) => ({
          number: i + 1,
          snapshot: quote("x".repeat(16_000)),
          annotation: "why?",
        })),
      ),
    /64,000/,
  );
  assert.equal(
    buildAnnotationPrompt([{ number: 1, snapshot, annotation: "\x03" }]),
    "[#1 annotation]",
  );
  assert.throws(
    () =>
      buildAnnotationPrompt([
        { number: 1, snapshot, annotation: "q".repeat(8001) },
      ]),
    /8,000/,
  );
});

test("marker-only insertion never pastes long selected contents or metadata", () => {
  const snapshot = quote("PRIVATE_REFERENCE_CONTENT ".repeat(500));
  assert.equal(
    buildAnnotationPrompt([{ number: 42, snapshot, annotation: "" }]),
    "[#42 annotation]",
  );
  assert.equal(
    buildAnnotationPrompt([{ number: 42, snapshot, annotation: "   " }]),
    "[#42 annotation]",
  );
  const prompt = buildAnnotationPrompt([
    { number: 42, snapshot, annotation: "Explain this" },
  ]);
  assert.equal(prompt, "[#42 annotation]");
  assert.doesNotMatch(
    prompt,
    /Explain|PRIVATE|Build Server|Review|synthetic|terminal-1|선택 시각/,
  );
});

test("combined reference limit counts selected text and each comment before attachment or paste", () => {
  const references = Array.from({ length: 4 }, (_, i) => ({
    number: i + 1,
    snapshot: quote("x".repeat(16_000)),
    annotation: "",
  }));
  assert.equal(
    buildAnnotationPrompt(references),
    "[#1 annotation] [#2 annotation] [#3 annotation] [#4 annotation]",
  );
  const tooLarge = references.map((item, index) => ({
    ...item,
    annotation: index === 0 ? "one extra character" : "",
  }));
  assert.throws(() => buildAnnotationAttachments(tooLarge), /64,000/);
  assert.throws(() => buildAnnotationPrompt(tooLarge), /64,000/);
  assert.equal(references[0].annotation, "");
});
