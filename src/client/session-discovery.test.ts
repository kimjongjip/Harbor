import test from "node:test";
import assert from "node:assert/strict";
import { discoverSessions, parsePreferences } from "./session-discovery";
import type { TerminalInfo } from "../shared/types";

test("session discovery preserves host order and active work, prioritizes pins and searches normalized Korean terms", () => {
  const hosts = [{ id: "compiler", name: "컴파일러" }],
    terms: TerminalInfo[] = ["실험", "작업", "측정", "종료"].map(
      (title, i) => ({
        id: String(i),
        hostId: "compiler",
        cwd: "/project",
        title,
        agentState: i === 1 ? "working" : "idle",
        exited: i === 3,
      }),
    );
  terms[2].connectionState = "disconnected";
  const prefs = parsePreferences(
    JSON.stringify({ pins: ["2", "2"], attention: true }),
  );
  const selected = new Set(["0", "3"]);
  assert.deepEqual(
    discoverSessions(terms, hosts, selected, "컴파일러", prefs).map(
      (t) => t.id,
    ),
    ["2", "0"],
  );
  assert.deepEqual(
    discoverSessions(
      terms,
      hosts,
      selected,
      "측정 컴파일러".normalize("NFD"),
      prefs,
    ).map((t) => t.id),
    ["2"],
  );
  assert.deepEqual(
    discoverSessions(
      terms,
      hosts,
      selected,
      "",
      parsePreferences("bad-json"),
    ).map((t) => t.id),
    ["0", "1", "2", "3"],
  );
  assert.deepEqual(
    terms.map((t) => t.id),
    ["0", "1", "2", "3"],
  );
});
