import { test } from "node:test";
import assert from "node:assert/strict";
import headless from "@xterm/headless";
import { isTerminalProtocolResponse } from "../shared/terminal-protocol-response.js";
import { TerminalControl } from "./terminal-control.js";
const { Terminal } = headless;

test("only full known terminal responses and response-only concatenations are passive", () => {
  const responses = [
    "\x1b[?1;2c",
    "\x1b[>0;276;0c",
    "\x1b[0n",
    "\x1b[24;80R",
    "\x1b[?24;80R",
    "\x1b[?2004;1$y",
    "\x1b[4;800;1200t",
    "\x1b[6;16;8t",
    "\x1b[8;24;80t",
    "\x1b[I",
    "\x1b[O",
    "\x1b[?1u",
    "\x1b[>4;2m",
    "\x1b]10;rgb:aaaa/bbbb/cccc\x07",
    "\x1b]4;255;rgb:ff/0/ffff\x1b\\",
    "\x1bP1$r0m\x1b\\",
    "\x1bP1$r1;24r\x1b\\",
    '\x1bP1$r61;1"p\x1b\\',
    '\x1bP1$r0"q\x1b\\',
    "\x1bP1$r2 q\x1b\\",
    "\x1bP0$r\x1b\\",
  ];
  for (const response of responses)
    assert.equal(
      isTerminalProtocolResponse(response),
      true,
      JSON.stringify(response),
    );
  assert.equal(isTerminalProtocolResponse(responses.join("")), true);
  for (const input of [
    "",
    "ls\r",
    "a",
    "1c",
    "\r",
    "\x03",
    "\x1b",
    "\x1b[A",
    "\x1b[1;5D",
    "\x1b[<0;20;40M",
    "\x1b[200~hello\x1b[201~",
    "\x1b]52;c;clipboard\x07",
    "\x1b[?1;2c\r",
    "text\x1b[24;80R",
    "\x1b[24;80Rtext",
    "\x1b[24;80",
    "\x1b[24;80r",
    "\x1b[0N",
    "\x1bP1$rcommand\x1b\\",
  ])
    assert.equal(
      isTerminalProtocolResponse(input),
      false,
      JSON.stringify(input),
    );
});

test("actual headless xterm capability replies do not acquire a local input lease", async () => {
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const controls = new TerminalControl(() => "runtime/session");
  const data: string[] = [];
  terminal.onData((value) => {
    data.push(value);
    if (!isTerminalProtocolResponse(value)) controls.local("terminal");
  });
  try {
    await new Promise<void>((resolve) =>
      terminal.write(
        "\x1b[c\x1b[>c\x1b[5n\x1b[6n\x1b[?2004$p\x1bP$qm\x1b\\",
        resolve,
      ),
    );
    assert.ok(data.length >= 5);
    assert.ok(data.every(isTerminalProtocolResponse));
    assert.equal(controls.view("terminal"), null);
    controls.change("terminal", "remote", "Other PC", {
      clientId: "remote-tab",
      action: "claim",
    });
    assert.equal(controls.canResizeLocally("terminal"), false);
    assert.throws(() => controls.local("terminal"));
  } finally {
    terminal.dispose();
  }
});
