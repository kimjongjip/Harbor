import test from "node:test";
import assert from "node:assert/strict";
import { isLegacyClaudeHistoryLimit } from "./history-errors";

test("legacy history compatibility matches only the known whole-file limit", () => {
  const message =
    "이 Claude 기록은 16 MB를 초과합니다. 터미널에서 이어서 확인하세요.";
  assert.equal(isLegacyClaudeHistoryLimit(message), true);
  assert.equal(isLegacyClaudeHistoryLimit(new Error(message)), true);
  for (const other of [
    undefined,
    "Permission denied",
    "SSH timeout",
    "16 MB image too large",
    "이 Claude 기록은 32 MB를 초과합니다. 터미널에서 이어서 확인하세요.",
  ])
    assert.equal(isLegacyClaudeHistoryLimit(other), false);
});
