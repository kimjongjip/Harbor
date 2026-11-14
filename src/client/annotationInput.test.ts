import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  AtomicAnnotationInput,
  annotationDeletion,
} from "./annotationInput.js";
const { Terminal } = createRequire(import.meta.url)("@xterm/headless");
test("delete and backspace remove one complete annotation from its ends or middle", () => {
  const marker = "[#1 annotation][ref:96]",
    text = `앞 문장 ${marker} 뒤 문장`;
  const start = text.indexOf(marker),
    end = start + marker.length;
  assert.equal(
    annotationDeletion(text, end, "\x7f"),
    "\x7f".repeat(marker.length),
  );
  assert.equal(
    annotationDeletion(text, start, "\x1b[3~"),
    "\x1b[C".repeat(marker.length) + "\x7f".repeat(marker.length),
  );
  assert.equal(
    annotationDeletion(text, start + 3, "\x7f"),
    "\x1b[C".repeat(marker.length - 3) + "\x7f".repeat(marker.length),
  );
  assert.equal(annotationDeletion(text, start, "\x7f"), null);
  assert.equal(annotationDeletion(text, end, "\x1b[3~"), null);
  assert.equal(annotationDeletion(text, end, "a"), null);
});
test("wide text, wrapped markers, delayed SSH echo and non-composer output are safe", async () => {
  const term = new Terminal({ cols: 24, rows: 12, allowProposedApi: true });
  const write = (s: string) =>
    new Promise<void>((resolve) => term.write(s, resolve));
  try {
    const input = new AtomicAnnotationInput();
    await write("❯ 한글 앞 문장 [#1 annotation][ref:96]");
    const deletion = input.transform(term.buffer.active, "\x7f");
    assert.equal(deletion, "\x7f".repeat("[#1 annotation][ref:96]".length));
    assert.equal(
      input.transform(term.buffer.active, "\x7f"),
      "",
      "do not replay against stale echo",
    );
    await write("\x1b[2J\x1b[H❯ 한글 앞 문장 ");
    assert.equal(input.transform(term.buffer.active, "\x7f"), "\x7f");
    await write("\r\noutput [#2 annotation:100]");
    assert.equal(
      new AtomicAnnotationInput().transform(term.buffer.active, "\x7f"),
      "\x7f",
      "hard output line must not borrow a prior composer",
    );
  } finally {
    term.dispose();
  }
});
