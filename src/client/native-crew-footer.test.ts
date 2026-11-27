import assert from "node:assert/strict";
import test from "node:test";
import { nativeCrewFooter } from "./native-crew-footer";

test("moves the Claude roster as shown, preserving each native clock and token label", () => {
  const lines = ["earlier output", "● main",
    "  ◯ general-purpose  Check the input  17m 15s · ↓ 244.7k tokens",
    "  ◯ reviewer  Review output   1h 2m 1s · ↓ 1.3M tokens", "", "> "];
  const roster = nativeCrewFooter("claude", lines)!;
  assert.deepEqual(roster.agents.map(a=>[a.elapsed, a.tokens]), [["17m 15s","244.7k"],["1h 2m 1s","1.3M"]]);
  assert.deepEqual(lines.slice(roster.start,roster.end),lines.slice(1,4));
  assert.equal(nativeCrewFooter("claude",lines.slice(2)),undefined);
  assert.equal(nativeCrewFooter("claude",["✻ Waiting for 3 background agents to finish",...lines.slice(2)]),undefined);
});

test("only moves the Antigravity task suffix from a recognized footer", () => {
  const line = "? for shortcuts    auto · Gemini 4 Carbon · high · 4 task(s) · /tasks";
  const footer = nativeCrewFooter("antigravity",[line])!;
  assert.equal(footer.taskCount,4);
  assert.equal(line.slice(0,footer.suffixOffset),"? for shortcuts    auto · Gemini 4 Carbon · high");
  assert.equal(nativeCrewFooter("antigravity",["output · 4 task(s) · /tasks"]),undefined);
});
