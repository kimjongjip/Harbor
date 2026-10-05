import test from "node:test";
import assert from "node:assert/strict";
import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import { TerminalScreen } from "./terminal-screen.js";
const { Terminal } = headless;
const linkCells = (terminal: InstanceType<typeof Terminal>) => {
  const core = (terminal as any)._core;
  const buffer = terminal.buffer.active;
  return Array.from({length: buffer.length}, (_, y) =>
    Array.from({length: terminal.cols}, (_, x) => {
      const cell = buffer.getLine(y)!.getCell(x)! as any;
      return cell.getChars() ? core._oscLinkService.getLinkData(cell.extended.urlId)?.uri ?? null : null;
    }));
};

test("canonical replay retains absolute OSC8 destinations, wrapped labels and active link continuation", async () => {
  const screen = new TerminalScreen(128);
  const live = new Terminal({cols: 24, rows: 8, allowProposedApi: true});
  const restored = new Terminal({cols: 24, rows: 8, allowProposedApi: true});
  screen.resize(24, 8);
  const open = "\x1b]8;;file:///home/user/project/docs/actual.md\x1b\\";
  const close = "\x1b]8;;\x1b\\";
  try {
    const data = `${open}\x1b[1;32mdocs/ë¬¸ì„œ_long_wrapped_name.md${close}\x1b[0m\r\n` +
      "padding\r\n".repeat(30) + `${open}${"a".repeat(24)}`;
    screen.append(data);
    await write(live, data);
    const baseline = new serialize.SerializeAddon();
    live.loadAddon(baseline);
    assert.equal(baseline.serialize().includes("file:///home/user/project/docs/actual.md"), false,
      "upstream serializer loses the actual destination");
    const snapshot = await screen.snapshot();
    assert.equal(snapshot.replay.snapshot, true);
    assert.equal(screen.history.snapshot().replay.truncated, true);
    await write(restored, snapshot.data);
    assert.deepEqual(read(restored), read(live));
    assert.deepEqual(linkCells(restored), linkCells(live));
    const restoredLine = restored.buffer.active.getLine(restored.buffer.active.baseY + restored.buffer.active.cursorY)!;
    assert.equal((restoredLine.getCell(0) as any).extended.urlId,
      (restoredLine.getCell(23) as any).extended.urlId, "one native link range includes pending-wrap final character");
    await Promise.all([write(live, `_next.md${close} plain`), write(restored, `_next.md${close} plain`)]);
    assert.deepEqual(linkCells(restored), linkCells(live));
    assert.deepEqual(read(restored), read(live));
    screen.append(`${close}\r\nnext`);
    assert.equal((await screen.snapshot()).replay.snapshot, true);
  } finally { screen.dispose(); live.dispose(); restored.dispose(); }
});
const write = (terminal: InstanceType<typeof Terminal>, value: string) =>
  new Promise<void>((resolve) => terminal.write(value, resolve));
const read = (terminal: InstanceType<typeof Terminal>) => {
  const buffer = terminal.buffer.active;
  return {
    type: buffer.type,
    cursor: [buffer.cursorX, buffer.cursorY],
    modes: terminal.modes,
    lines: Array.from({ length: terminal.rows }, (_, row) => {
      const line = buffer.getLine(buffer.baseY + row)!;
      return Array.from({ length: terminal.cols }, (_, col) => {
        const cell = line.getCell(col)!;
        return [
          cell.getChars(),
          cell.getWidth(),
          cell.getFgColorMode(),
          cell.getFgColor(),
          cell.getBgColorMode(),
          cell.getBgColor(),
          cell.isBold(),
          cell.isUnderline(),
        ];
      });
    }),
  };
};

test("canonical screen survives raw-tail eviction, geometry changes, colors and persistent input modes", async () => {
  const screen = new TerminalScreen(256);
  const live = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
  const restored = new Terminal({ cols: 74, rows: 22, allowProposedApi: true });
  const append = async (value: string) => {
    screen.append(value);
    await write(live, value);
  };
  try {
    await append("\x1b[?1049h\x1b[?2004h\x1b[?1004h\x1b[?1h\x1b[38;2;1;2;3m");
    for (let index = 0; index < 140; index++) {
      if (index === 50 || index === 90) {
        const cols = index === 50 ? 60 : 74,
          rows = index === 50 ? 19 : 22;
        screen.resize(cols, rows);
        live.resize(cols, rows);
      }
      await append(
        `\x1b[48;2;${index};15;25mRow ${index} ?œê? ${"wrapped text ".repeat(10)}\r\n`,
      );
    }
    await append("\x1b[5;7H\x1b[1;4mUNSENT_DRAFT");
    const snapshot = await screen.snapshot();
    assert.equal(screen.history.snapshot().replay.truncated, true);
    assert.equal(snapshot.replay.snapshot, true);
    await write(restored, snapshot.data);
    assert.deepEqual(read(restored), read(live));
    await Promise.all([write(live, "_NEXT"), write(restored, "_NEXT")]);
    assert.deepEqual(
      read(restored),
      read(live),
      "subsequent differential output retains cursor and rendition",
    );
  } finally {
    screen.dispose();
    live.dispose();
    restored.dispose();
  }
});

test("snapshot freezes its exact output boundary and preserves unfinished control sequences", async () => {
  const screen = new TerminalScreen();
  const restored = new Terminal({
    cols: 100,
    rows: 30,
    allowProposedApi: true,
  });
  try {
    screen.append("BEFORE\x1b[38;2;20;");
    const first = screen.snapshot();
    screen.append("30;40mAFTER");
    const firstValue = await first;
    assert.ok(!firstValue.data.includes("AFTER"));
    await write(restored, firstValue.data);
    await write(restored, "30;40mAFTER");
    const second = await screen.snapshot();
    const comparison = new Terminal({
      cols: 100,
      rows: 30,
      allowProposedApi: true,
    });
    try {
      await write(comparison, second.data);
      assert.deepEqual(read(restored), read(comparison));
    } finally {
      comparison.dispose();
    }
  } finally {
    screen.dispose();
    restored.dispose();
  }
});

test("cwd metadata keeps canonical replay enabled", async () => {
  const screen = new TerminalScreen();
  try {
    screen.append("before\x1b]1337;CurrentDir=/home/user\x07after");
    assert.equal((await screen.snapshot()).replay.snapshot, true);
  } finally { screen.dispose(); }
});

test("inline-image protocols retain atomic raw replay rather than disappearing from a headless snapshot", async () => {
  const screen = new TerminalScreen();
  try {
    screen.append("before\x1b]13");
    screen.append("37;File=inline=1:YWJj\x07after");
    const snapshot = await screen.snapshot();
    assert.equal(snapshot.replay.snapshot, undefined);
    assert.equal(snapshot.data, "before\x1b]1337;File=inline=1:YWJj\x07after");
  } finally {
    screen.dispose();
  }
});

test("scroll regions, saved cursor, cursor visibility and SGR mouse survive later live output", async () => {
  const screen = new TerminalScreen(96);
  screen.resize(40, 10);
  const live = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
  const restored = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
  try {
    const frame =
      Array.from({ length: 10 }, (_, i) => `\x1b[${i + 1};1HROW_${i}`).join(
        "",
      ) +
      "\x1b[2;3H\x1b7\x1b[3;8r\x1b[8;1H\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?2004l";
    screen.append(frame);
    await write(live, frame);
    const snapshot = await screen.snapshot();
    assert.equal(snapshot.replay.snapshot, true);
    assert.ok(snapshot.data.includes("\x1b[?2004l"));
    await write(restored, snapshot.data);
    const state = (terminal: any) => ({
      top: terminal._core._bufferService.buffer.scrollTop,
      bottom: terminal._core._bufferService.buffer.scrollBottom,
      hidden: terminal._core.coreService.isCursorHidden,
      mouse: terminal._core.coreMouseService.activeEncoding,
    });
    assert.deepEqual(state(restored), state(live));
    for (const output of ["\r\nNEXT", "\x1b8Z"]) {
      await Promise.all([write(restored, output), write(live, output)]);
      assert.deepEqual(read(restored), read(live));
    }
  } finally {
    screen.dispose();
    live.dispose();
    restored.dispose();
  }
});

test("full-row pending wrap continues on the next row after restoration", async () => {
  const screen = new TerminalScreen();
  screen.resize(10, 3);
  const live = new Terminal({ cols: 10, rows: 3, allowProposedApi: true });
  const restored = new Terminal({ cols: 10, rows: 3, allowProposedApi: true });
  try {
    const value = "\x1b[?1049hABCDEFGHIJ";
    screen.append(value);
    await write(live, value);
    await write(restored, (await screen.snapshot()).data);
    assert.equal(restored.buffer.active.cursorX, 10);
    await Promise.all([write(restored, "K"), write(live, "K")]);
    assert.deepEqual(read(restored), read(live));
  } finally {
    screen.dispose();
    live.dispose();
    restored.dispose();
  }
});

test("adjacent small writes batch instead of waiting one OS timer per chunk", async () => {
  const screen = new TerminalScreen();
  try {
    const start = performance.now();
    for (let index = 0; index < 1000; index++)
      screen.append(`line_${index}\r\n`);
    const snapshot = await screen.snapshot();
    assert.ok(snapshot.data.includes("line_999"));
    assert.ok(
      performance.now() - start < 3000,
      "1000 chunks must not schedule 1000 serial write timers",
    );
  } finally {
    screen.dispose();
  }
});

test("leaving the alternate buffer restores the normal cursor's saved rendition", async () => {
  const screen = new TerminalScreen();
  const live = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
  const restored = new Terminal({
    cols: 100,
    rows: 30,
    allowProposedApi: true,
  });
  try {
    const frame = "\x1b[31;1mNORMAL\x1b[?1049h\x1b[0mALT";
    screen.append(frame);
    await write(live, frame);
    await write(restored, (await screen.snapshot()).data);
    assert.deepEqual(read(restored), read(live));
    await Promise.all([
      write(restored, "\x1b[?1049lNEXT"),
      write(live, "\x1b[?1049lNEXT"),
    ]);
    assert.deepEqual(read(restored), read(live));
  } finally {
    screen.dispose();
    live.dispose();
    restored.dispose();
  }
});

