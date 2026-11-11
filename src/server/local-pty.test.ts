import test from "node:test";
import assert from "node:assert/strict";
import { spawnLocalPty, type LocalPty } from "./local-pty.js";

const fixture = new URL("./fixtures/fake-pty-worker.mjs", import.meta.url);
const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("PTY output did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const observe = (pty: LocalPty) => {
  const result = { text: "", exits: [] as number[] };
  pty.onData((data) => {
    result.text += data;
  });
  pty.onExit(({ exitCode }) => result.exits.push(exitCode));
  return result;
};

test(
  "a terminal host crash cannot terminate the server or another terminal",
  { timeout: 20000 },
  async () => {
    const first = await spawnLocalPty("fixture", [], {}, fixture);
    const second = await spawnLocalPty("fixture", [], {}, fixture);
    const a = observe(first),
      b = observe(second);
    try {
      await until(
        () => a.text.includes("initial") && b.text.includes("initial"),
      );
      first.write("crash");
      await until(() => a.exits.length > 0);
      assert.deepEqual(a.exits, [73]);
      second.write("한글 echo survives");
      second.resize(120, 40);
      await until(
        () =>
          b.text.includes("한글 echo survives") && b.text.includes("120x40"),
      );
      assert.deepEqual(b.exits, []);
      first.kill();
      first.resize(90, 30);
      first.write("after exit");
      second.kill();
      second.kill();
      await until(() => b.exits.length > 0);
      assert.deepEqual(b.exits, [0]);
      assert.deepEqual(a.exits, [73]);
    } finally {
      first.kill();
      second.kill();
    }
    await assert.rejects(spawnLocalPty("fail-start", [], {}, fixture), /71/);
  },
);

test(
  "isolated native PTY transports output, resizes and exits without touching live sessions",
  { skip: process.platform !== "win32", timeout: 20000 },
  async () => {
    const pty = await spawnLocalPty(
      process.execPath,
      [
        "-e",
        "process.stdout.write('PTY_READY\\r\\n');process.stdin.on('data',()=>{process.stdout.write('PTY_DONE\\r\\n');process.exit(0)})",
      ],
      {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
        useConptyDll: true,
      },
    );
    const state = observe(pty);
    try {
      await until(() => state.text.includes("PTY_READY"));
      pty.resize(100, 35);
      pty.write("synthetic input\r");
      await until(() => state.exits.length > 0);
      assert.ok(state.text.includes("PTY_DONE"));
      assert.deepEqual(state.exits, [0]);
    } finally {
      pty.kill();
    }
  },
);
