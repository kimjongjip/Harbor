import test from "node:test";
import assert from "node:assert/strict";
import { TerminalReplay } from "./terminal-replay.js";

test("terminal replay preserves split OSC images, SIXEL and normal ANSI byte-for-byte", () => {
  const replay = new TerminalReplay();
  const output =
    "한글\x1b[32mgreen\x1b[0m\r\n\x1b]1337;File=inline=1:YWJj\x07\x1bPq#0!30~\x1b\\done";
  for (let i = 0; i < output.length; i += 3)
    replay.append(output.slice(i, i + 3));
  assert.equal(replay.read(), output);
});
test("terminal replay evicts images atomically instead of showing base64 fragments", () => {
  const replay = new TerminalReplay(90);
  const image = "\x1b]1337;File=inline=1:" + "a".repeat(40) + "\x07";
  replay.append("before\n" + image);
  replay.append("after".repeat(10));
  assert.equal(replay.read(), "after".repeat(10));
  replay.append("\x1bP" + "b".repeat(200));
  assert.ok(replay.read().endsWith("\x1bP"));
  replay.append("\x1b");
  replay.append("\\text");
  assert.ok(replay.read().endsWith("text"));
  assert.ok(!replay.read().includes("bbbb"));
  assert.ok(replay.read().length <= 90);
});

test("snapshot records the original viewport and UTF-16 resize offsets without duplicating output", () => {
  const replay = new TerminalReplay();
  replay.append("한글🙂\x1b[32mwide\x1b[0m");
  const first = replay.read();
  assert.equal(replay.resize(70, 22), true);
  replay.append("\r\nnext");
  assert.equal(replay.resize(70, 22), false);
  assert.deepEqual(replay.snapshot(), {
    data: first + "\r\nnext",
    replay: {
      cols: 100,
      rows: 30,
      resizes: [{ offset: first.length, cols: 70, rows: 22 }],
    },
  });
  assert.equal(replay.snapshot().data, replay.read());
});

test("resizes before the first byte set base dimensions and consecutive markers coalesce", () => {
  const replay = new TerminalReplay();
  replay.resize(80, 24);
  replay.resize(90, 25);
  replay.append("first");
  replay.resize(120, 35);
  replay.resize(140, 40);
  assert.deepEqual(replay.snapshot().replay, {
    cols: 90,
    rows: 25,
    resizes: [{ offset: 5, cols: 140, rows: 40 }],
  });
  assert.equal(replay.resize(NaN, 20), false);
  assert.equal(replay.resize(0, 20), false);
});

test("resize during a split image or ANSI sequence waits for the complete atomic sequence", () => {
  for (const sequence of [
    "\x1b]1337;File=inline=1:YWJj\x07",
    "\x1bPq#0!30~\x1b\\",
    "\x1b[38;2;10;20;30m",
  ]) {
    const replay = new TerminalReplay();
    replay.append("before");
    replay.append(sequence.slice(0, 3));
    replay.resize(60, 20);
    replay.resize(75, 26);
    assert.deepEqual(replay.snapshot().replay.resizes, [
      { offset: 9, cols: 75, rows: 26 },
    ]);
    assert.equal(replay.read(), "before" + sequence.slice(0, 3));
    replay.append(sequence.slice(3) + "after");
    assert.deepEqual(replay.snapshot(), {
      data: "before" + sequence + "after",
      replay: {
        cols: 100,
        rows: 30,
        resizes: [{ offset: 6 + sequence.length, cols: 75, rows: 26 }],
      },
    });
  }
});

test("oversized incomplete control strings signal truncation and retain latest snapshot geometry", () => {
  const replay = new TerminalReplay(20);
  replay.append("\x1bP" + "x".repeat(30));
  replay.resize(80, 24);
  const snapshot = replay.snapshot();
  assert.equal(snapshot.replay.truncated, true);
  assert.equal(snapshot.data, "\x1bP");
  assert.deepEqual(snapshot.replay.resizes, [
    { offset: 2, cols: 80, rows: 24 },
  ]);
  assert.deepEqual(
    replay.snapshot(),
    snapshot,
    "snapshot does not mutate pending control state",
  );
});

test("trimming advances base geometry and keeps remaining resize offsets aligned", () => {
  const replay = new TerminalReplay(12);
  replay.append("0123456789ab");
  replay.resize(80, 24);
  replay.append("ABCDEF");
  replay.resize(60, 20);
  replay.append("ghijklmnop");
  assert.deepEqual(replay.snapshot(), {
    data: "EFghijklmnop",
    replay: {
      cols: 80,
      rows: 24,
      resizes: [{ offset: 2, cols: 60, rows: 20 }],
      truncated: true,
    },
  });
});

test("atomic image eviction also drops obsolete geometry while preserving following data", () => {
  const replay = new TerminalReplay(50);
  const image = "\x1b]1337;File=inline=1:" + "a".repeat(15) + "\x07";
  replay.append(image);
  replay.resize(66, 21);
  replay.append("z".repeat(30));
  assert.deepEqual(replay.snapshot(), {
    data: "z".repeat(30),
    replay: { cols: 66, rows: 21, resizes: [], truncated: true },
  });
});

test("resize metadata remains bounded even when thousands of tiny writes alternate sizes", () => {
  const replay = new TerminalReplay();
  for (let index = 0; index < 1000; index++) {
    replay.append("x");
    replay.resize(60 + (index % 2), 24);
  }
  const { data, replay: metadata } = replay.snapshot();
  assert.equal(metadata.truncated, true);
  assert.ok(metadata.resizes.length <= 256);
  assert.ok(
    metadata.resizes.every(
      (event) => event.offset >= 0 && event.offset <= data.length,
    ),
  );
  assert.ok(
    metadata.resizes.every(
      (event, index) =>
        !index || event.offset >= metadata.resizes[index - 1].offset,
    ),
  );
  assert.equal(metadata.resizes.at(-1)?.cols, 61);
  assert.equal(data, replay.read());
});

test("trimming text never splits a surrogate pair or shifts resize offsets to half a character", () => {
  const replay = new TerminalReplay(5);
  replay.append("🙂abc");
  replay.resize(80, 24);
  replay.append("xy");
  assert.deepEqual(replay.snapshot(), {
    data: "abcxy",
    replay: {
      cols: 100,
      rows: 30,
      resizes: [{ offset: 3, cols: 80, rows: 24 }],
      truncated: true,
    },
  });
});

test("long-running ANSI output retains the exact bounded tail and resize timeline after repeated eviction", () => {
  const output = (index: number) =>
    `\x1b[32m${String(index).padStart(5, "0")}🙂\x1b[0m`;
  const keep = 1024;
  const total = 7200;
  const width = output(0).length;
  const replay = new TerminalReplay(width * keep);
  for (let index = 0; index < total; index++) {
    if (index % 1280 === 0) replay.resize(60 + index / 1280, 20 + index / 1280);
    replay.append(output(index));
  }
  const expected = Array.from({ length: keep }, (_, index) =>
    output(total - keep + index),
  ).join("");
  assert.deepEqual(replay.snapshot(), {
    data: expected,
    replay: {
      cols: 64,
      rows: 24,
      resizes: [
        { offset: (6400 - (total - keep)) * width, cols: 65, rows: 25 },
      ],
      truncated: true,
    },
  });
  assert.equal(replay.read(), expected);
});
