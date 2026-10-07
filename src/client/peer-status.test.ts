import { test } from "node:test";
import assert from "node:assert/strict";
import { messageDelivery, peerConnection } from "./peer-status.js";
import type { TerminalInfo } from "../shared/types.js";
import type { MailboxMessage } from "../shared/mailbox.js";

const terminal: TerminalInfo = {
  id: "b",
  hostId: "fixture",
  cwd: "/work",
  title: "Review",
  exited: false,
  agentConnected: true,
  agentKind: "claude",
  agentSessionId: "native-b",
  peerDelivery: "automatic",
};
const message: MailboxMessage = {
  id: "q",
  threadId: "thread",
  sender: { kind: "terminal", title: "Implement", terminalId: "a" },
  recipient: {
    kind: "terminal",
    title: "Review",
    terminalId: "b",
    sessionId: "native-b",
  },
  author: "agent",
  text: "Why?",
  status: "queued",
  createdAt: 1,
};

test("offering a native notification never presents it as model receipt", () => {
  assert.equal(
    messageDelivery({ ...message, offeredAt: 2 }, [terminal]),
    "CLI 알림 전달 · AI 확인 대기",
  );
  assert.equal(
    messageDelivery({ ...message, offeredAt: 2, status: "consumed" }, [
      terminal,
    ]),
    "AI 확인",
  );
  assert.equal(
    messageDelivery({ ...message, repliedAt: 3 }, [terminal]),
    "답장 도착",
  );
});
test("changing native conversations reports waiting for original context", () => {
  assert.equal(
    messageDelivery({ ...message, offeredAt: 2 }, [
      { ...terminal, agentSessionId: "other" },
    ]),
    "원래 대화 연결 대기",
  );
  assert.equal(
    messageDelivery(message, [{ ...terminal, exited: true }]),
    "세션 종료 · 확인 대기",
  );
});
test("manual and automatic connections have distinct labels", () => {
  assert.equal(peerConnection(terminal), "채널 수신 요청");
  assert.equal(
    peerConnection({ ...terminal, agentKind: "codex" }),
    "자동 수신",
  );
  assert.equal(
    peerConnection({ ...terminal, peerDelivery: "poll" }),
    "받은함 확인 필요",
  );
  assert.equal(
    peerConnection({ ...terminal, agentConnected: false }),
    "CLI 실행 대기",
  );
});
