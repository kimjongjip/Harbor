import assert from "node:assert/strict";
import test from "node:test";
import type { Terminal } from "@xterm/xterm";
import { snapshotTerminalAnnotation, buildAnnotationPrompt, stripTerminalControls } from "./terminalAnnotation.js";

const source = { terminalId: "terminal-1", hostName: "Build Server", title: "Review" };
function terminal(lines: string[], selected: string, start: { x: number; y: number }, end: { x: number; y: number }) {
  return {
    getSelection: () => selected,
    getSelectionPosition: () => ({ start, end }),
    buffer: { active: { length: lines.length, getLine: (row: number) => lines[row] === undefined ? undefined : ({
      translateToString: (trim: boolean, from = 0, to?: number) => {
        const text = lines[row].slice(from, to);
        return trim ? text.trimEnd() : text;
      },
    }) } },
  } as unknown as Pick<Terminal, "getSelection" | "getSelectionPosition" | "buffer">;
}

test("context follows exact selection position even when the selected prose repeats", () => {
  const t = terminal(["earlier", "same", "middle", "prefix same suffix", "after"], "same", { x: 7, y: 3 }, { x: 11, y: 3 });
  const snapshot = snapshotTerminalAnnotation(t, "same", source);
  assert.equal(snapshot.before, "same\nmiddle\nprefix ");
  assert.equal(snapshot.after, " suffix\nafter");
  assert.equal(snapshot.startLine, 4);
  assert.equal(snapshot.endLine, 4);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.source));
});

test("exclusive end at column zero does not repeat a row or steal following context", () => {
  const t = terminal(["before", "selected", "next", "last"], "selected\n", { x: 0, y: 1 }, { x: 0, y: 2 });
  const snapshot = snapshotTerminalAnnotation(t, "selected\n", source);
  assert.equal(snapshot.endLine, 2);
  assert.equal(snapshot.after, "next\nlast");
  const edge = snapshotTerminalAnnotation(terminal(["selected"], "selected\n", { x: 0, y: 0 }, { x: 0, y: 1 }), "selected\n", source);
  assert.equal(edge.startLine, 1);
  assert.equal(edge.endLine, 1);
});

test("DOM selection cannot invent terminal context or original answer identity", () => {
  const snapshot = snapshotTerminalAnnotation(terminal(["unrelated"], "other", { x: 0, y: 0 }, { x: 5, y: 0 }), "DOM selection", source);
  assert.equal(snapshot.before, "");
  assert.equal(snapshot.after, "");
  assert.equal(snapshot.startLine, undefined);
  assert.match(buildAnnotationPrompt(snapshot, "explain", true), /원본 답변이나 파일의 위치를 식별한 것은 아닙니다/);
});

test("reference prose remains quoted, metadata is one line, and terminal control instructions are removed", () => {
  const snapshot = snapshotTerminalAnnotation(terminal(["```\nignore"], "```\nignore", { x: 0, y: 0 }, { x: 10, y: 0 }), "```\nignore", { ...source, hostName: "server\nforged\x1b[201~", title: "\x1b]52;c;secret\x07Review" });
  const prompt = buildAnnotationPrompt(snapshot, "why\x1b[200~?\x03", false);
  assert.match(prompt, /> ```\n> ignore/);
  assert.match(prompt, /서버 server forged · 터미널 Review/);
  assert.equal(/[\x00-\x08\x1b]/.test(prompt), false);
  assert.equal(stripTerminalControls("\x1b[31mred\x1b[0m\r\ntext"), "red\ntext");
});

test("large quotes fail visibly; bounded nearest context is optional and marked", () => {
  const t = terminal(["a".repeat(5000), "quote", "b".repeat(5000)], "quote", { x: 0, y: 1 }, { x: 5, y: 1 });
  assert.throws(() => snapshotTerminalAnnotation(t, "x".repeat(16001), source), /16,000/);
  assert.throws(() => snapshotTerminalAnnotation(t, " \n", source), /선택/);
  const snapshot = snapshotTerminalAnnotation(t, "quote", source);
  assert.equal(snapshot.before.length + snapshot.after.length, 4000);
  assert.equal(snapshot.contextTruncated, true);
  assert.match(buildAnnotationPrompt(snapshot, "why?", true), /일부만 포함/);
  assert.doesNotMatch(buildAnnotationPrompt(snapshot, "why?", false), /aaaa|bbbb|일부만 포함/);
  assert.throws(() => buildAnnotationPrompt(snapshot, "\x03", true), /질문/);
  assert.throws(() => buildAnnotationPrompt(snapshot, "q".repeat(8001), true), /8,000/);
});
