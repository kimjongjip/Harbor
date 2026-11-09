import test from "node:test";
import assert from "node:assert/strict";
import { readHtmlSource, HTML_SOURCE_LIMIT } from "./html-source.js";

test("empty HTML source has no satisfiable range but still displays an empty document", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(null, {
        status: 416,
        headers: { "Content-Range": "bytes */0" },
      }),
  );
  assert.deepEqual(
    await readHtmlSource("/fixture", new AbortController().signal),
    { text: "", truncated: false },
  );
});

test("HTML source requests a bounded range and marks a partial document", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) => {
      assert.equal(
        (options.headers as Record<string, string>).Range,
        `bytes=0-${HTML_SOURCE_LIMIT - 1}`,
      );
      return new Response("<h1>원문</h1>", {
        status: 206,
        headers: { "Content-Range": "bytes 0-18/30000000" },
      });
    },
  );
  const result = await readHtmlSource("/fixture", new AbortController().signal);
  assert.equal(result.text, "<h1>원문</h1>");
  assert.equal(result.truncated, true);
});

test("HTML source cancels servers that ignore Range instead of retaining a huge string", async (t) => {
  let cancelled = false,
    produced = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            produced += 65536;
            controller.enqueue(new Uint8Array(65536).fill(120));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Length": "50000000" } },
      ),
  );
  const result = await readHtmlSource("/fixture", new AbortController().signal);
  assert.equal(result.text.length, HTML_SOURCE_LIMIT);
  assert.ok(result.truncated);
  assert.ok(cancelled);
  assert.ok(produced <= HTML_SOURCE_LIMIT + 65536);
});
