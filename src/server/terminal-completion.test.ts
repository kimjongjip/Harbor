import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Terminals } from "./terminals.js";
import { claudeHookSchema, type ClaudeHookEvent } from "./claude-hooks.js";
import type { TerminalInfo } from "../shared/types.js";

function fixture() {
  const terminals = new Terminals();
  const info: TerminalInfo = {
    id: "synthetic-terminal", hostId: "synthetic-host", title: "Fixture",
    cwd: "/fixture", exited: false, agentKind: "claude", agentSessionId: "native-fixture",
    agentState: "working",
  };
  // State-only fixture: never create a PTY or touch a user's native session.
  const entry = { info } as any;
  (terminals as any).entries.set(info.id, entry);
  const event = (hook_event_name: ClaudeHookEvent["hook_event_name"], extra: Partial<ClaudeHookEvent> = {}) =>
    terminals.markClaudeEvent(info.id, claudeHookSchema.parse({ hook_event_name, session_id: "native-fixture", ...extra }));
  return { terminals, info, entry, event };
}

test("only native Stop text creates an exact UTF-8 digest without publishing or persisting its body", () => {
  const f = fixture();
  f.entry.durable = { record: { info: {} } };
  const text = "검증된 답변입니다.\n$K=32$ 🙂 ";
  f.event("Stop", { last_assistant_message: text });
  assert.equal(f.info.agentState, "idle");
  assert.deepEqual(f.info.agentCompletion, {
    sessionId: "native-fixture",
    textHash: createHash("sha256").update(text, "utf8").digest("hex"),
  });
  assert.ok(!JSON.stringify(f.terminals.list()).includes(text));
  assert.equal(f.entry.durable.record.info.agentCompletion, undefined);
  assert.notEqual(f.info.agentCompletion!.textHash, createHash("sha256").update(text.trim(), "utf8").digest("hex"));
});

test("new input, failed stop, tool activity and session boundaries clear completion proof", () => {
  for (const name of ["UserPromptSubmit", "StopFailure", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "SessionStart", "SessionEnd"] as const) {
    const f = fixture();
    f.event("Stop", { last_assistant_message: "Completed once" });
    assert.ok(f.info.agentCompletion);
    f.event(name, { last_assistant_message: "Not another completed answer" });
    assert.equal(f.info.agentCompletion, undefined, name);
  }
  const f = fixture();
  for (const text of [undefined, "", "  ", "x".repeat(128001)]) {
    f.event("Stop", { last_assistant_message: "Earlier completed answer" });
    f.event("Stop", { last_assistant_message: text });
    assert.equal(f.info.agentCompletion, undefined);
    assert.equal(f.info.agentState, "idle", "an oversized/absent proof must not discard the native status");
  }
});

test("stale native hooks cannot replace or clear another session's completion proof", () => {
  const f = fixture();
  f.event("Stop", { last_assistant_message: "Exact final answer" });
  const proof = f.info.agentCompletion;
  for (const name of ["Stop", "StopFailure", "UserPromptSubmit", "SessionEnd"] as const) {
    f.event(name, { session_id: "stale-session", last_assistant_message: "Wrong answer" });
    assert.equal(f.info.agentCompletion, proof);
    assert.equal(f.info.agentSessionId, "native-fixture");
  }
  f.event("SessionStart", { session_id: "replacement-session" });
  assert.equal(f.info.agentCompletion, undefined);
  f.event("Stop", { last_assistant_message: "Old session arrived late" });
  assert.equal(f.info.agentCompletion, undefined);
  assert.equal(f.info.agentSessionId, "replacement-session");
});

test("native continuation, peer input and leaving Claude invalidate Stop proof", () => {
  const f = fixture();
  const stop = () => f.event("Stop", { last_assistant_message: "Completed answer" });
  stop();
  f.terminals.markClaudeContinuation(f.info.id, "stale-session");
  assert.ok(f.info.agentCompletion);
  f.terminals.markClaudeContinuation(f.info.id, "native-fixture");
  assert.equal(f.info.agentCompletion, undefined);
  assert.equal(f.info.agentState, "working");
  stop();
  f.terminals.markPeerRuntime(f.info.id, { kind: "claude", sessionId: "native-fixture", state: "working", delivery: "automatic" });
  assert.equal(f.info.agentCompletion, undefined);
  stop();
  f.terminals.markAgentConnected(f.info.id, "codex");
  assert.equal(f.info.agentCompletion, undefined);
  stop();
  f.terminals.markAgentState(f.info.id, "shell");
  assert.equal(f.info.agentCompletion, undefined);
});
