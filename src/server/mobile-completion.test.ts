import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { MobileCompletions } from "./mobile-completion";
import { mobileFixture } from "../test/mobile-fixture";
import type { ClaudeHookEvent } from "./claude-hooks";

test("native completions deduplicate per session and ignore obsolete/disconnected/closed terminals", async () => {
  const f = await mobileFixture(),
    sent: string[] = [];
  const completion = new MobileCompletions(
    () => f.state,
    (_id, key) => sent.push(key),
  );
  try {
    completion.completed(f.id, "native-fixture", "turn-1");
    completion.completed(f.id, "native-fixture", "turn-1");
    completion.completed(f.id, "old-session", "turn-2");
    assert.equal(sent.length, 1);
    completion.completed(f.id, "native-fixture", "turn-2");
    f.state.terminals[0].connectionState = "reconnecting";
    completion.completed(f.id, "native-fixture", "turn-3");
    f.state.terminals[0].connectionState = "connected";
    f.state.terminals[0].exited = true;
    completion.completed(f.id, "native-fixture", "turn-3");
    assert.equal(sent.length, 2);
  } finally {
    completion.dispose();
    await f.close();
  }
});
test("Claude Stop notifies once; tools, failures and Harbor continuation do not announce a finished answer", async () => {
  const f = await mobileFixture(),
    sent: string[] = [];
  const completion = new MobileCompletions(
    () => f.state,
    (_id, key) => sent.push(key),
    10,
  );
  const event = (hook_event_name: ClaudeHookEvent["hook_event_name"]) =>
    completion.claudeEvent(f.id, {
      hook_event_name,
      session_id: "native-fixture",
    });
  try {
    event("UserPromptSubmit");
    event("PostToolUse");
    event("PostToolUseFailure");
    await delay(25);
    assert.equal(sent.length, 0);
    event("Stop");
    event("Stop");
    await delay(25);
    assert.equal(sent.length, 1);
    event("Stop");
    await delay(25);
    assert.equal(sent.length, 1);
    event("UserPromptSubmit");
    event("StopFailure");
    await delay(25);
    assert.equal(sent.length, 1);
    event("UserPromptSubmit");
    event("Stop");
    completion.continued(f.id);
    await delay(25);
    assert.equal(sent.length, 1);
    event("PostToolUse");
    event("Stop");
    await delay(25);
    assert.equal(sent.length, 2);
    event("UserPromptSubmit");
    event("Stop");
    f.state.terminals[0].agentSessionId = "replacement";
    await delay(25);
    assert.equal(sent.length, 2);
    f.state.terminals[0].agentSessionId = "native-fixture";
    completion.dispose();
    event("UserPromptSubmit");
    event("Stop");
    await delay(25);
    assert.equal(sent.length, 3);
    event("UserPromptSubmit");
    event("Stop");
    completion.dispose();
    await delay(25);
    assert.equal(sent.length, 3);
  } finally {
    completion.dispose();
    await f.close();
  }
});
