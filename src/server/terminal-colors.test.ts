import assert from "node:assert/strict";
import test from "node:test";
import { TerminalColorResponder } from "./terminal-colors.js";
import { TerminalReplay } from "./terminal-replay.js";

test("fresh paired startup color probes get immediate replies and never enter replay", () => {
  const colors = new TerminalColorResponder();
  const replay = new TerminalReplay();
  const replies: string[] = [];
  const value = "before\x1b[6n\x1b]10;?\x07\x1b]11;?\x1b\\after";
  for (const char of value) {
    const result = colors.consume(char);
    replay.append(result.output);
    replies.push(...result.replies);
  }
  assert.deepEqual(replies, [
    "\x1b]10;rgb:2020/2424/2c2c\x1b\\",
    "\x1b]11;rgb:ffff/ffff/ffff\x1b\\",
  ]);
  assert.equal(replay.read(), "before\x1b[6nafter");
  // A new/reconnected viewer sees no color query that could inject an old reply.
  assert.equal(
    new TerminalColorResponder().consume(replay.read()).replies.length,
    0,
  );
});

test("theme updates affect only later queries, including combined and C1 probes", () => {
  const colors = new TerminalColorResponder();
  colors.update({ foreground: "#e6e8ee", background: "#181b21" });
  assert.deepEqual(colors.consume(""), { output: "", replies: [] });
  assert.deepEqual(colors.consume("\x9d10;?;?\x9c"), {
    output: "",
    replies: [
      "\x1b]10;rgb:e6e6/e8e8/eeee\x1b\\",
      "\x1b]11;rgb:1818/1b1b/2121\x1b\\",
    ],
  });
  assert.throws(() =>
    colors.update({ foreground: "#ffffff\x07", background: "red" }),
  );
});

test("ordinary ANSI, unsupported OSC, and image control strings are preserved without replies", () => {
  const colors = new TerminalColorResponder();
  const value =
    "한글\x1b[38;2;2;3;4mtext\x1b[0m\x1b]0;window\x07\x1b]9;attention\x07\x1b]11;#ff0000\x07\x1b]12;?\x07\x1b]10;?;?;?\x07\x1bPq\x1b]11;?\x07payload\x1b\\\x1b]1337;File=inline=1:" +
    "A".repeat(10000) +
    "\x07done";
  let output = "";
  for (let offset = 0; offset < value.length; offset += 7) {
    const result = colors.consume(value.slice(offset, offset + 7));
    output += result.output;
    assert.equal(result.replies.length, 0);
  }
  assert.equal(output, value);
});

test("cancelled/incomplete queries and oversized OSC payloads cannot inject color responses", () => {
  const colors = new TerminalColorResponder();
  assert.deepEqual(colors.consume("\x1b]11;?\x18"), {
    output: "\x1b]11;?\x18",
    replies: [],
  });
  assert.deepEqual(colors.consume("\x1b]11;?"), { output: "", replies: [] });
  assert.equal(colors.flush(), "\x1b]11;?");
  const oversized = "\x1b]" + "a".repeat(1000);
  assert.deepEqual(colors.consume(oversized), {
    output: oversized,
    replies: [],
  });
  assert.deepEqual(colors.consume("\x1b]11;?\x07"), {
    output: "\x1b]11;?\x07",
    replies: [],
  });
});
