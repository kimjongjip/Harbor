import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ViewConnections } from "./view-connections";

test("connection journal stores bounded safe codes without request content", () => {
  const root = resolve(".cache/view-connection-tests");
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "run-"));
  try {
    const journal = new ViewConnections(directory);
    journal.trace({
      reason: "socket-close",
      code: 1006,
      token: "private-value",
      output: "secret transcript",
    } as any);
    journal.trace({ reason: "private-value" } as any);
    journal.trace({ reason: "snapshot-timeout", terminalId: "invalid" } as any);
    for (let i = 0; i < 400; i++)
      journal.trace({ reason: "heartbeat-timeout" });
    const data = readFileSync(
      join(directory, "view-connections.jsonl"),
      "utf8",
    );
    assert.ok(
      !data.includes("private-value") && !data.includes("secret transcript"),
    );
    const events = data
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 300);
    assert.equal(events[0].code, 1006);
    assert.ok(
      events.every((event) =>
        Object.keys(event).every((key) =>
          ["at", "terminalId", "reason", "code"].includes(key),
        ),
      ),
    );
  } finally {
    assert.ok(directory.startsWith(root + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
