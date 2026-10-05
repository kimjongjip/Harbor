import test from "node:test";
import assert from "node:assert/strict";
import { TerminalNotices } from "./terminal-notices.js";
test("attention from any terminal survives split OSCs and is shared without image/progress noise", () => {
  const notices = new TerminalNotices();
  notices.append("a", "Build Server", "\x1b]9;답변");
  notices.append("a", "Build Server", "이 필요합니다\x1b");
  notices.append(
    "a",
    "Build Server",
    "\\\x1b]9;4;1;50\x07\x1b]1337;File=" + "a".repeat(5000),
  );
  notices.append("a", "Build Server", "\x07");
  notices.append("b", "Local", "\x1b]777;notify;완료;확인하세요\x07");
  assert.equal(notices.list().length, 2);
  assert.equal(notices.list()[1].body, "답변이 필요합니다");
  notices.read("a");
  assert.equal(notices.list()[1].read, true);
  assert.equal(notices.list()[0].read, false);
  notices.close("a");
  assert.equal(notices.list().length, 2);
});
