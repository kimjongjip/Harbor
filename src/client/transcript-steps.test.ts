import test from "node:test";
import assert from "node:assert/strict";
import type { MessageItem } from "../shared/types";
import {
  parseDiff,
  stepTitle,
  toolArguments,
  transcriptEntries,
} from "./transcript-steps";

const item = (id: string, kind: MessageItem["kind"], text: string, extra: Partial<MessageItem> = {}): MessageItem => ({ id, kind, text, ...extra });

test("tool calls pair with results by native id, even when issued in parallel", () => {
  const entries = transcriptEntries([
    item("q", "user", "고쳐줘"),
    item("c", "assistant", "두 파일을 봅니다.", { phase: "commentary" }),
    item("t1", "tool", "Read", { status: "started", toolUseId: "a", detail: "file_path: /p/a.ts" }),
    item("t2", "command", "Bash", { status: "started", toolUseId: "b", detail: "command: npm test" }),
    item("r2", "tool", "도구 결과", { status: "completed", toolUseId: "b", detail: "ok" }),
    item("r1", "tool", "도구 결과", { status: "completed", toolUseId: "a", detail: "1\tconst a" }),
    item("final", "assistant", "완료", { phase: "final_answer" }),
  ]);
  assert.deepEqual(
    entries.map((entry) =>
      entry.kind === "step"
        ? `step:${entry.call?.id}+${entry.result?.id}`
        : `${entry.kind}:${"item" in entry ? entry.item.id : ""}`,
    ),
    ["message:q", "commentary:c", "step:t1+r1", "step:t2+r2", "message:final"],
  );
});

test("older servers without tool ids pair results with calls in issue order", () => {
  const entries = transcriptEntries([
    item("t1", "command", "Bash", { status: "started", detail: "command: ls" }),
    item("t2", "tool", "Grep", { status: "started", detail: "pattern: TODO" }),
    item("r1", "tool", "도구 결과", { status: "completed", detail: "a.ts" }),
    item("r2", "tool", "도구 결과", { status: "failed", detail: "no match" }),
  ]);
  assert.deepEqual(
    entries.map((entry) => entry.kind === "step" && `${entry.call?.id}+${entry.result?.id}`),
    ["t1+r1", "t2+r2"],
  );
});

test("slash command output joins its command line; raw tags from old servers are recognized", () => {
  const entries = transcriptEntries([
    item("cmd", "user", "<command-name>/effort</command-name><command-args>max</command-args>"),
    item("out", "user", "<local-command-stdout>Set effort level to max</local-command-stdout>"),
    item("caveat", "user", "<local-command-caveat>Caveat</local-command-caveat>"),
    item("q", "user", "질문"),
  ]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, "system");
  assert.deepEqual(
    entries[0].kind === "system" ? entries[0].outputs.map((output) => output.id) : [],
    ["out"],
  );
  assert.equal(entries[1].kind, "message");
});

test("Codex command and change items stay self-contained work entries", () => {
  const entries = transcriptEntries([
    item("cmd", "command", "npm test", { detail: "ok", status: "completed" }),
    item("chg", "change", "src/a.ts", { detail: "--- src/a.ts\n@@ -1 +1 @@\n-a\n+b" }),
  ]);
  assert.deepEqual(entries.map((entry) => entry.kind), ["item", "item"]);
});

test("CLI-like step titles use the primary argument relative to the session folder", () => {
  const call = (text: string, detail: string) => item("c", "tool", text, { status: "started", detail });
  assert.deepEqual(
    (({ name, target }) => ({ name, target }))(stepTitle(call("Edit", "file_path: C:\\work\\repo\\src\\a.ts"), "C:\\work\\repo")),
    { name: "Update", target: "src\\a.ts" },
  );
  assert.equal(stepTitle(call("Bash", "command: cd x && python3 - <<'PY'\nprint(1)\nPY\ndescription: run")).target, "cd x && python3 - <<'PY'\nprint(1)\nPY");
  assert.equal(stepTitle(call("mcp__harbor__harbor_ask", "message: 확인해줘")).name, "harbor - harbor_ask (MCP)");
  assert.deepEqual(toolArguments("pattern: TODO\npath: src"), { pattern: "TODO", path: "src" });
});

test("unified diffs keep old/new line numbers from hunk headers", () => {
  const diff = parseDiff("@@ -18,3 +18,4 @@\n keep\n-old\n+new\n+added\n context");
  assert.deepEqual(
    diff!.map((line) => [line.kind, line.oldLine ?? null, line.newLine ?? null, line.text]),
    [
      ["hunk", null, null, "@@ -18,3 +18,4 @@"],
      ["context", 18, 18, "keep"],
      ["remove", 19, null, "old"],
      ["add", null, 19, "new"],
      ["add", null, 20, "added"],
      ["context", 20, 21, "context"],
    ],
  );
  assert.equal(parseDiff("plain output\n-not a diff"), undefined);
});
