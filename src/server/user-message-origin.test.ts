import test from "node:test";
import assert from "node:assert/strict";
import { classifyUserMessage } from "../shared/user-message-origin";
import { parseClaudeHistory } from "./claude-history";

const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n");

test("typed prompts keep their text, including prompts that contain markup", () => {
  assert.deepEqual(classifyUserMessage("컴파일 오류를 수정해줘"), {
    text: "컴파일 오류를 수정해줘",
    startsTurn: true,
  });
  assert.equal(classifyUserMessage("<div>왜 깨져?</div>").origin, undefined);
  // Claude labels typed prompts; a pasted command tag is still the person's text.
  assert.equal(
    classifyUserMessage("<command-name>/x</command-name>", "human").origin,
    undefined,
  );
});

test("slash commands, their output and caveats are not shown as typed prompts", () => {
  assert.deepEqual(
    classifyUserMessage(
      "<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n            <command-args>max</command-args>",
    ),
    { origin: "command", text: "/effort max", startsTurn: true },
  );
  assert.deepEqual(
    classifyUserMessage(
      "<local-command-stdout>\u001b[1mSet effort level to max\u001b[22m</local-command-stdout>",
    ),
    { origin: "command-output", text: "Set effort level to max", startsTurn: false },
  );
  assert.equal(
    classifyUserMessage("<local-command-caveat>Caveat: generated</local-command-caveat>").hidden,
    true,
  );
  assert.deepEqual(classifyUserMessage("<bash-input>git status</bash-input>"), {
    origin: "command",
    text: "! git status",
    startsTurn: true,
  });
  assert.deepEqual(
    classifyUserMessage("<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>"),
    { origin: "command-output", text: "clean", startsTurn: false },
  );
});

test("background notifications, interrupts and channel deliveries are labelled", () => {
  const notice =
    '<task-notification>\n<task-id>fixture-task-1</task-id>\n<status>completed</status>\n<summary>Background command "Rebuild" completed (exit code 0)</summary>\n</task-notification>';
  assert.deepEqual(classifyUserMessage(notice, "task-notification"), {
    origin: "notification",
    text: 'Background command "Rebuild" completed (exit code 0)',
    detail: "completed",
    startsTurn: true,
  });
  assert.deepEqual(classifyUserMessage("[Request interrupted by user for tool use]"), {
    origin: "interrupt",
    text: "[Request interrupted by user for tool use]",
    startsTurn: false,
  });
  assert.deepEqual(
    classifyUserMessage(
      '<channel source="harbor" message_id="m1" sender_name="리뷰">구조를 설명해줘</channel>',
    ),
    { origin: "channel", text: "구조를 설명해줘", detail: "리뷰", startsTurn: true },
  );
  assert.equal(
    classifyUserMessage("<system-reminder>internal</system-reminder>").hidden,
    true,
  );
  assert.equal(classifyUserMessage("Continue", "auto-continuation").origin, "system");
});

test("Harbor's own Codex peer deliveries show the peer text, not the envelope", () => {
  const envelope = JSON.stringify({
    messageId: "m-1",
    from: { title: "구현" },
    text: "왜 이렇게 했나요?",
  });
  assert.deepEqual(
    classifyUserMessage(
      `A Harbor peer session has a question about your current work. Answer using harbor_reply.\n${envelope}`,
    ),
    { origin: "channel", text: "왜 이렇게 했나요?", detail: "구현", startsTurn: true },
  );
  assert.equal(
    classifyUserMessage(`A Harbor peer session has a question.\nnot json`).origin,
    undefined,
  );
});

test("Claude edits keep their recorded hunks with line numbers and pair with the call", () => {
  const detail = parseClaudeHistory(
    "h",
    "id",
    jsonl([
      { type: "user", uuid: "q", message: { content: "고쳐줘" }, origin: { kind: "human" } },
      {
        type: "assistant",
        uuid: "call",
        message: {
          content: [
            { type: "tool_use", id: "toolu_1", name: "Edit", input: { file_path: "/p/a.ts", old_string: "a", new_string: "b" } },
          ],
          stop_reason: "tool_use",
        },
      },
      {
        type: "user",
        uuid: "result",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "updated" }] },
        toolUseResult: {
          filePath: "/p/a.ts",
          structuredPatch: [
            { oldStart: 18, oldLines: 3, newStart: 18, newLines: 4, lines: [" keep", "-old", "+new", "+added"] },
          ],
        },
      },
      {
        type: "user",
        uuid: "notice",
        message: { content: "<task-notification><summary>Build done</summary></task-notification>" },
        origin: { kind: "task-notification" },
      },
    ]),
    1,
    { includeActivity: true },
  );
  const work = detail.timeline!.filter((item) => item.kind !== "user");
  assert.deepEqual(
    work.map((item) => ({ kind: item.kind, toolUseId: item.toolUseId, format: item.format, text: item.text })),
    [
      { kind: "tool", toolUseId: "toolu_1", format: undefined, text: "Edit" },
      { kind: "tool", toolUseId: "toolu_1", format: "diff", text: "2줄 추가 · 1줄 삭제" },
    ],
  );
  assert.equal(work[1].detail, "@@ -18,3 +18,4 @@\n keep\n-old\n+new\n+added");
  const notice = detail.items.at(-1)!;
  assert.deepEqual(
    { text: notice.text, origin: notice.origin },
    { text: "Build done", origin: "notification" },
  );
  // A notification is answered as its own native turn.
  assert.notEqual(notice.turnId, detail.items[0].turnId);
});

test("Claude turns split at every typed prompt and ignore API request copies", () => {
  const rows: any[] = [];
  let parent: string | null = null, n = 0;
  const push = (row: any) => {
    const uuid = `u${n++}`;
    rows.push({ parentUuid: parent, uuid, sessionId: "s", ...row });
    parent = uuid;
  };
  for (let turn = 1; turn <= 2; turn++) {
    push({ type: "user", message: { content: `질문 ${turn}` }, origin: { kind: "human" } });
    push({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${turn}`, name: "Bash", input: { command: "ls" } }], stop_reason: "tool_use" } });
    push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${turn}`, content: "ok" }] } });
    // Claude 2.1.319 also stores the request it sent; never a second result.
    rows.push({ type: "api-request-blob", sessionId: "s", message: { content: [{ type: "tool_result", tool_use_id: `t${turn}`, content: "ok\n<request copy>" }] } });
    push({ type: "assistant", message: { content: [{ type: "text", text: `답 ${turn}` }], stop_reason: "end_turn" } });
  }
  const detail = parseClaudeHistory("h", "s", jsonl(rows), 1, { includeActivity: true });
  const turns = [...new Set(detail.timeline!.map((item) => item.turnId))];
  assert.equal(turns.length, 2);
  assert.equal(detail.timeline!.filter((item) => item.toolUseId === "t1").length, 2);
  assert.ok(!detail.timeline!.some((item) => item.detail?.includes("request copy")));
});
