import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import {
  ClaudeSshProcess,
  ClaudeChatMessages,
  createClaudeChatFactory,
  installedClaudeExecutable,
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
test("Claude resolver skips a directory and non-executable POSIX entries before a valid executable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harbor-claude-bin-"));
  const original = process.env.PATH;
  const name = process.platform === "win32" ? "claude.exe" : "claude";
  try {
    const paths = [
      join(dir, "directory"),
      join(dir, "noexec"),
      join(dir, "bin"),
    ];
    for (const item of paths) await mkdir(item);
    await mkdir(join(paths[0], name));
    if (process.platform !== "win32")
      await writeFile(join(paths[1], name), "fixture", { mode: 0o600 });
    const executable = join(paths[2], name);
    await writeFile(executable, "fixture", { mode: 0o700 });
    process.env.PATH = paths.join(delimiter);
    assert.equal(await installedClaudeExecutable(), executable);
  } finally {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
    await rm(dir, { recursive: true, force: true });
  }
});
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
test("SDK streams an in-progress tool and its public arguments before the assistant or result frame", () => {
  const items:MessageItem[] = [];
  const parser = new ClaudeChatMessages(events(items),"request","native");
  const stream = (event:unknown) => parser.consume({type:"stream_event",session_id:"native",event});
  stream({type:"message_start",message:{id:"reply"}});
  stream({type:"content_block_start",index:0,content_block:{type:"tool_use",id:"read",name:"Read",input:{}}});
  assert.equal(items[0].text,"Read");
  assert.equal(items[0].status,"started");
  stream({type:"content_block_delta",index:0,delta:{type:"input_json_delta",partial_json:'{"file_path":"sample.ts","token":"secret"}'}});
  stream({type:"content_block_stop",index:0});
  assert.equal(items[0].detail,"file_path: sample.ts");
  parser.consume({type:"tool_progress",session_id:"native",tool_use_id:"read",tool_name:"Read",elapsed_time_seconds:12});
  assert.match(items[0].detail!,/sample.ts[\s\S]*12초/);
  stream({type:"content_block_start",index:1,content_block:{type:"text",text:""}});
  stream({type:"content_block_delta",index:1,delta:{type:"text_delta",text:"중간 보고"}});
  parser.consume({type:"user",session_id:"native",message:{content:[{type:"tool_result",tool_use_id:"read",content:[
    {type:"text",text:"public result"},{type:"image",data:"binary"},
  ]}]}});
  assert.deepEqual(items.map(item=>item.text),["Read","중간 보고","도구 결과"]);
  assert.equal(items[2].toolUseId,"read");
  assert.equal(items[2].detail,"public result");
  assert.equal(items[1].status,"inProgress");
});
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
    "test-conversation-a",
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
  assert.match(command, /export HARBOR_CLAUDE_WORK_ID=[0-9a-f]{64};/);
  assert.ok(!command.includes("test-conversation-a"));
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

test("SDK usage combines one main message's fresh/cache tokens with its confirmed model window and cost",()=>{
  const snapshots:import("../shared/terminal-usage").TerminalUsage[]=[];
  const nativeId=randomUUID();
  const p=new ClaudeChatMessages({...events(),usage:u=>snapshots.push(u)},"turn",nativeId);
  const event=(m:Record<string,unknown>)=>p.consume({session_id:nativeId,...m});
  event({type:"assistant",message:{id:"a",model:"model-a",content:[],usage:{input_tokens:8,cache_creation_input_tokens:12,cache_read_input_tokens:100}}});
  event({type:"system",subtype:"task_started",task_id:"child-a",task_type:"local_agent",subagent_type:"reviewer",description:"Read the tests"});
  event({type:"system",subtype:"task_started",task_id:"background-shell",task_type:"local_bash",description:"shell"});
  event({type:"result",subtype:"success",total_cost_usd:0.4,usage:{input_tokens:7000},modelUsage:{"model-a":{contextWindow:1000},"other":{contextWindow:8000}}});
  const u=snapshots.at(-1)!;
  assert.equal(u.usedTokens,120);assert.equal(u.contextWindow,1000);assert.equal(u.usedPercent,12);
  assert.equal(u.costUsd,0.4);assert.equal(u.costSource,"api-estimate");
  assert.deepEqual(u.crew?.agents.map(x=>x.id),["child-a"]);
  const count=snapshots.length;
  event({type:"result",subtype:"success",session_id:randomUUID(),total_cost_usd:50});
  event({type:"result",subtype:"success",parent_tool_use_id:"child",total_cost_usd:80});
  assert.equal(snapshots.length,count);
});

test("custom local SDK spawn has hidden window, drains stderr, and maps structured questions", async () => {
  let spawned: any;
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  child.killed = false;
  child.pid = 31234;
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
  assert.match(spawned.options.env.HARBOR_CLAUDE_WORK_ID, /^[0-9a-f]{64}$/);
  assert.equal(run.processId, child.pid);
  child.emit("exit", 0);
  assert.equal(run.processId, undefined);
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
