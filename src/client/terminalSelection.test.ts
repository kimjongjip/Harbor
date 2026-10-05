import assert from "node:assert/strict";
import test from "node:test";
import { terminalQuote } from "./terminalSelection";

test("selected multiline content stays a quote with an unfinished question", () => {
  assert.equal(
    terminalQuote("첫 줄\r\nsecond line\rthird"),
    "> 첫 줄\n> second line\n> third\n\n이 부분에 대해: ",
  );
});

test("quoted terminal output cannot inject escape controls or interrupt input", () => {
  const quote = terminalQuote("answer\x1b[201~\x03\x00\x7f\nnext");
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(quote));
  assert.ok(quote.includes("\n> next"));
  assert.ok(quote.endsWith(": "));
});
