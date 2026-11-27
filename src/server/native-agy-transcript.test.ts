import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Files } from "./files.js";
import type { HostConfig } from "../shared/types.js";
import { agyStep, agyTimelineStep } from "./native-agy-transcript.js";
import { conversationTurns } from "../client/conversation-turns.js";
import { liveTranscriptLayout } from "../client/terminal-transcript-boundary.js";

test("tool-only steps retain file paths and command failures without copying reasoning", () => {
  const step = (step_index:number,type:string,fields:object) => agyTimelineStep(JSON.stringify({step_index,type,source:"MODEL",status:"DONE",...fields}));
  const calls = step(50,"PLANNER_RESPONSE",{thinking:"private reasoning",tool_calls:[
    {name:"read_file",args:{Path:"example.py"}},{name:"run_command",args:{CommandLine:"python test.py"}}]});
  assert.equal(calls.length,3);
  assert.doesNotMatch(JSON.stringify(calls),/private reasoning/);
  assert.match(calls[1].text,/example.py/);
  const failed = step(52,"GENERIC",{content:"Command exited with code 1."})[0];
  assert.equal(failed.toolUseId,calls[2].toolUseId);
  assert.equal(failed.status,"failed");
});
test("bound agy transcript paginates by bytes and projects only actual speaker text above the native input", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "harbor-agy-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "transcript_full.jsonl");
  const records = Array.from({ length: 80 }, (_, i) =>
    i % 2
      ? {
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          content: "Results\n\n|model|value|\n|---|---|\n|A|1|",
          thinking: "private",
        }
      : {
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          content:
            "<USER_REQUEST>질문 " +
            i +
            "</USER_REQUEST><ADDITIONAL_METADATA>private</ADDITIONAL_METADATA>",
        },
  );
  await writeFile(
    path,
    records
      .map((r, i) => JSON.stringify({ ...r, status: "DONE", step_index: i }))
      .join("\n") +
      "\n" +
      '{"partial":',
  );
  const files = new Files(() => undefined);
  t.after(() => files.shutdown());
  files.resolvePath = async () => path;
  const host = { id: "test", kind: "local" } as HostConfig,
    id = "f0000000-0000-4000-8000-000000000001";
  const page = await files.nativeAgyPage(host, id, dir);
  assert.equal(page.items.length, 60);
  assert.ok(page.nextCursor);
  const prev = await files.nativeAgyPage(host, id, dir, page.nextCursor!);
  assert.equal(prev.items.length, 20);
  assert.equal(prev.nextCursor, null);
  assert.equal(
    new Set([...prev.items, ...page.items].map((m) => m.id)).size,
    80,
  );
  assert.equal(prev.items[0].text, "질문 0");
  assert.ok(!JSON.stringify(page.items).includes("private"));
  assert.equal(
    agyStep(
      JSON.stringify({
        step_index: 1,
        type: "GENERIC",
        source: "MODEL",
        content: "tool output",
      }),
    ),
    undefined,
  );
  const turns = conversationTurns(page.items),
    lines = [
      "Results",
      "A 1",
      "─────────────────",
      "> ",
      "─────────────────",
      "? for shortcuts",
    ];
  const layout = liveTranscriptLayout(
    turns,
    { lines, end: lines.length, baseY: 0, cursorRow: 3 },
    [],
    { provider: "antigravity", waiting: false },
  );
  assert.equal(layout.historyCount, turns.length);
  assert.ok(layout.live);
  assert.ok(layout.nativeStart <= 3);
});
