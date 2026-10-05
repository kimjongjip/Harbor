import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import type { IBuffer } from "@xterm/xterm";
import {
  attachmentReflected,
  terminalComposer,
  waitForAttachment,
} from "./terminalAttachmentQueue.js";

function buffer(lines: string[], cursorY = lines.length - 1, baseY = 0) {
  return {
    baseY,
    cursorY,
    getLine: (row: number) => ({ translateToString: () => lines[row] || "" }),
  } as unknown as IBuffer;
}

test("attachment evidence belongs to the cursor's composer, not historical image markers", () => {
  const current = terminalComposer(
    buffer([
      "› [Image #99] old-file.png",
      "",
      "Assistant [Image #80]",
      "",
      "› draft",
    ]),
  );
  assert.deepEqual(current, { text: "› draft", images: 0 });
  assert.equal(
    terminalComposer(buffer(["› [Image #99]", "", "approval dialog"])),
    null,
  );
  assert.equal(
    attachmentReflected(current!, current, "/tmp/new.png", true),
    false,
  );
  assert.equal(
    attachmentReflected(
      current!,
      { text: "› draft [Image #1]", images: 1 },
      "/tmp/new.png",
      true,
    ),
    true,
  );
});

test("a wrapped generated filename is acknowledged only when newly visible in the draft", () => {
  assert.equal(
    attachmentReflected(
      { text: "› draft", images: 0 },
      terminalComposer(
        buffer(["› '/tmp/space", "name-1791000000000-a1b2c3d4.txt'"]),
      ),
      "/tmp/space name-1791000000000-a1b2c3d4.txt",
      false,
    ),
    true,
  );
  const before = terminalComposer(buffer(["› draft"]));
  const after = terminalComposer(
    buffer(["› draft '/tmp/한글-179100", "  000-abc123.txt'"]),
  );
  // Native wrapping has no indentation inserted into the logical filename.
  const wrapped = terminalComposer(
    buffer(["› draft '/tmp/한글-179100", "000-abc123.txt'"]),
  );
  assert.equal(
    attachmentReflected(
      before!,
      wrapped,
      "/tmp/한글-179100000-abc123.txt",
      false,
    ),
    true,
  );
  assert.equal(
    attachmentReflected(before!, after, "/tmp/other.txt", false),
    false,
  );
  assert.equal(
    attachmentReflected(
      wrapped!,
      wrapped,
      "/tmp/한글-179100000-abc123.txt",
      false,
    ),
    false,
  );
});

test("delayed native redraw beyond the old 350ms gap holds the following paste until reflected", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const controller = new AbortController();
  let composer = { text: "› draft", images: 0 };
  const before = composer;
  const sent = ["first image"];
  let complete = false;
  const waiting = waitForAttachment({
    signal: controller.signal,
    ready: () => true,
    read: () =>
      attachmentReflected(before, composer, "/tmp/first.png", true)
        ? true
        : null,
  }).then((reflected) => {
    if (reflected) sent.push("second image");
    complete = true;
  });
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.deepEqual(sent, ["first image"]);
  assert.equal(complete, false);
  composer = { text: "› draft [Image #1]", images: 1 };
  t.mock.timers.tick(40);
  await waiting;
  assert.deepEqual(sent, ["first image", "second image"]);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("timeout, cancellation and disconnected targets finish without retries or leaked listeners", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const controller = new AbortController();
  let reads = 0;
  const options = {
    signal: controller.signal,
    ready: () => true,
    read: () => {
      reads++;
      return null;
    },
    timeoutMs: 100,
  };
  const expired = waitForAttachment(options);
  t.mock.timers.tick(150);
  assert.equal(await expired, null);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const oldReads = reads;
  t.mock.timers.tick(1000);
  assert.equal(reads, oldReads);
  const cancelled = waitForAttachment(options);
  controller.abort();
  assert.equal(await cancelled, null);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const disconnected = new AbortController();
  assert.equal(
    await waitForAttachment({
      ...options,
      signal: disconnected.signal,
      ready: () => false,
    }),
    null,
  );
  assert.equal(getEventListeners(disconnected.signal, "abort").length, 0);
  assert.equal(
    await waitForAttachment({
      ...options,
      signal: disconnected.signal,
      read: () => {
        throw Error("disposed terminal");
      },
    }),
    null,
  );
  assert.equal(getEventListeners(disconnected.signal, "abort").length, 0);
});
