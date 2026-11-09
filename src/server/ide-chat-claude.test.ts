import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import {
  ClaudeSshProcess,
  ClaudeChatMessages,
  createClaudeChatFactory,
  type ClaudeChatEvents,
  type ClaudeQuery,
} from "./ide-chat-claude.js";
import type { HostConfig, MessageItem } from "../shared/types.js";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

const host: HostConfig = {
  id: "fake-host",
  name: "Fake",
  kind: "ssh",
  address: "example.invalid",
  port: 22,
  username: "fake",
  identityFile: "",
  codexPath: "codex",
  defaultCwd: "/home/fake",
  mode: "isolated",
  color: "blue",
  createdAt: 0,
};
function events(items: MessageItem[] = []): ClaudeChatEvents {
  return {
    item: (item) => {
      const index = items.findIndex((old) => old.id === item.id);
      if (index < 0) items.push(item);
      else items[index] = item;
    },
    approval: async () => ({ approved: false }),
    removeApproval() {},
    native() {},
  };
}
async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("SSH SDK transport keeps final stdout after exit-status and uses a non-PTY exec channel", async () => {
  const channel = new PassThrough() as any;
  channel.stderr = new PassThrough();
  channel.close = () => {};
  channel.signal = () => {};
  const connection = new EventEmitter() as any;
  connection.end = () => {};
  let command = "";
  connection.exec = (...args: any[]) => {
    assert.equal(args.length, 2, "SSH exec must not request a PTY");
    command = args[0];
    args[1](null, channel);
  };
  const process = new ClaudeSshProcess(
    host,
    "not-in-argv",
    {
      command: "claude",
      args: [
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
      ],
      cwd: "/home/fake/project space",
      env: { DO_NOT_FORWARD: "private" },
      signal: new AbortController().signal,
    } as SpawnOptions,
    async () => connection,
  );
  const received: string[] = [];
  process.stdout.on("data", (data) => received.push(data.toString()));
  let exited = false;
  process.on("exit", () => {
    exited = true;
  });
  process.on("error", (error) => {
    throw error;
  });
  await tick();
  channel.write("before\n");
  channel.emit("exit", 0);
  assert.equal(exited, false);
  channel.write("final result\n");
  channel.emit("close");
  await tick();
  assert.equal(received.join(""), "before\nfinal result\n");
  assert.equal(exited, true);
  assert.equal(process.exitCode, 0);
  assert.match(command, /claude/);
  assert.match(command, /stream-json/);
  assert.ok(!command.includes("not-in-argv"));
  assert.ok(!command.includes("DO_NOT_FORWARD"));
});

test("SDK parser ignores child session frames without rebinding the conversation", () => {
  const items: MessageItem[] = [];
  const handler = events(items);
  const ids: string[] = [];
  handler.native = (id) => {
    ids.push(id);
  };
  const parser = new ClaudeChatMessages(handler, "test-request");
  parser.consume({
    type: "assistant",
    parent_tool_use_id: "child-tool",
    session_id: "subagent",
    message: { content: [{ type: "text", text: "private subagent state" }] },
  });
  parser.consume({
    type: "assistant",
    parent_tool_use_id: null,
    session_id: "parent",
    message: {
      id: "native-message",
      content: [{ type: "text", text: "Top-level answer" }],
    },
  });
  assert.deepEqual(ids, ["parent"]);
  assert.equal(items[0].text, "Top-level answer");
});

test("custom local SDK spawn has hidden window, drains stderr, and maps structured questions", async () => {
  let spawned: any;
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  child.killed = false;
  child.exitCode = null;
  let permission: any;
  let requested: any;
  const handler = events();
  handler.approval = async (value) => {
    requested = value;
    return { approved: true, answers: { "0": "Choice A" } };
  };
  const sdk = ((invocation: any) => ({
    async *[Symbol.asyncIterator]() {
      const options = invocation.options;
      options.spawnClaudeCodeProcess({
        command: "node",
        args: ["installed-cli.js", "--print"],
        cwd: "/synthetic",
        env: {},
        signal: new AbortController().signal,
      });
      const input = {
        questions: [
          {
            question: "Which implementation?",
            header: "Plan",
            options: [{ label: "Choice A" }, { label: "Choice B" }],
          },
        ],
      };
      permission = await options.canUseTool("AskUserQuestion", input, {
        signal: new AbortController().signal,
      });
      yield { type: "result", subtype: "success", is_error: false };
    },
    async interrupt() {},
    close() {},
  })) as ClaudeQuery;
  const factory = createClaudeChatFactory({
    query: sdk,
    executable: async () => "installed-cli.js",
    spawn: ((command: string, args: string[], options: any) => {
      spawned = { command, args, options };
      return child;
    }) as any,
  });
  const run = factory({
    host: { ...host, kind: "local" },
    nativeId: randomUUID(),
    resume: false,
    cwd: "/synthetic",
    requestId: randomUUID(),
    text: "Test only",
    events: handler,
  });
  await run.done;
  assert.equal(spawned.options.windowsHide, true);
  assert.equal(spawned.options.shell, undefined);
  assert.equal(child.stderr.listenerCount("data"), 1);
  assert.equal(requested.kind, "question");
  assert.deepEqual(permission.updatedInput.answers, {
    "Which implementation?": "Choice A",
  });
  assert.equal(permission.behavior, "allow");
  assert.equal(permission.updatedPermissions, undefined);
});

test("Claude rechecks authorization before the SDK consumes a prompt after initialization", async () => {
  let prompts = 0;
  const sdk = ((invocation: any) => ({
    async *[Symbol.asyncIterator]() {
      await invocation.prompt[Symbol.asyncIterator]().next();
      prompts++;
      yield { type: "result", subtype: "success", is_error: false };
    },
    async interrupt() {},
    close() {},
  })) as ClaudeQuery;
  const factory = createClaudeChatFactory({ query: sdk });
  const run = factory({
    host,
    nativeId: randomUUID(),
    resume: false,
    cwd: "/synthetic",
    requestId: randomUUID(),
    text: "Never dispatch",
    events: events(),
    beforeDispatch: () => {
      throw new Error("revoked after startup");
    },
  });
  await assert.rejects(run.done, /revoked after startup/);
  assert.equal(prompts, 0);
});
