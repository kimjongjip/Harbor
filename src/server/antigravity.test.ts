import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { AntigravityHistory, findAntigravity } from "./antigravity";
import { AgentBridge } from "./agent-bridge";
import { Mailbox } from "./mailbox";
import { createBridgeRouter } from "./bridge-router";
import { createInterface } from "node:readline";
import type { TerminalInfo } from "../shared/types";
import type { HostConfig } from "../shared/types";

test(
  "one Antigravity ACP session handles an idle peer, a multiline draft, approval, usage and resume",
  { timeout: 30000 },
  async () => {
    const root = resolve(".cache/antigravity-test");
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "run-")),
      id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const fake = join(dir, "fake.cjs"),
      journal = join(dir, "records");
    await writeFile(
      fake,
      `
const rl=require('node:readline').createInterface({input:process.stdin});
const fs=require('node:fs'),sid=${JSON.stringify(id)};let prompting;
const send=v=>console.log(JSON.stringify({jsonrpc:'2.0',...v}));
const update=u=>send({method:'session/update',params:{sessionId:sid,update:u}});
function finish(req){update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'## fixture answer'}});update({sessionUpdate:'usage_update',used:250,size:1000,cost:{amount:1.5,currency:'USD'}});send({id:req,result:{stopReason:'end_turn'}})}
rl.on('line',s=>{const m=JSON.parse(s);if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1}});
else if(m.method==='session/new'||m.method==='session/load'){if(m.params.mcpServers[0].name!=='harbor')process.exit(2);fs.appendFileSync('trace',JSON.stringify([m.method,m.params.sessionId])+'\\n');send({id:m.id,result:{sessionId:sid,configOptions:[{id:'model',category:'model',currentValue:'fixture-model'}]}})}
else if(m.method==='session/prompt'){const text=m.params.prompt[0].text;fs.appendFileSync('trace',JSON.stringify(['prompt',m.params.sessionId,text])+'\\n');if(text.includes('approve-fixture')){prompting=m.id;send({id:901,method:'session/request_permission',params:{sessionId:sid,toolCall:{title:'test tool'},options:[{optionId:'one',name:'one'}]}})}else finish(m.id)}
else if(m.id===901){fs.appendFileSync('trace',JSON.stringify(['permission',m.result.outcome])+'\\n');finish(prompting)}});
`,
    );
    let queued = false,
      acked = false;
    const states: string[] = [];
    const server = createServer(async (req, res) => {
      assert.equal(req.headers.authorization, "Bearer fixture");
      res.setHeader("Content-Type", "application/json");
      let body = "";
      for await (const data of req) body += data;
      if (req.url?.includes("/events?")) {
        if (!queued || acked) await new Promise((r) => setTimeout(r, 80));
        res.end(
          JSON.stringify({
            sessionId: id,
            messages:
              queued && !acked
                ? [
                    {
                      id: "peer-1",
                      recipient: { sessionId: id },
                      sender: { title: "Peer" },
                      text: "peer-fixture",
                    },
                  ]
                : [],
          }),
        );
      } else {
        if (req.url?.endsWith("/runtime")) states.push(JSON.parse(body).state);
        if (req.url?.endsWith("/ack")) acked = true;
        res.end("{}");
      }
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const entry = resolve("desktop/antigravity.cjs");
    const start = (resume = false) =>
      spawn(
        process.execPath,
        [
          "-e",
          `require(${JSON.stringify(entry)}).run([${JSON.stringify(process.execPath)},${JSON.stringify(journal)},${JSON.stringify(resume ? id : "")}],[${JSON.stringify(fake)}]).catch(e=>{console.error(e);process.exitCode=1})`,
        ],
        {
          cwd: dir,
          env: {
            ...process.env,
            HARBOR_AGY_CONFIG: "",
            HARBOR_SESSION_TOKEN: "fixture",
            HARBOR_AGY_BRIDGE: `http://127.0.0.1:${address.port}/bridge/mcp`,
          },
          stdio: "pipe",
          windowsHide: true,
        },
      );
    const wait = async (check: () => boolean | Promise<boolean>) => {
      for (let i = 0; i < 160; i++) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw Error("Timed out waiting for fixture");
    };
    let proc = start();
    proc.stdout.resume();
    proc.stderr.resume();
    try {
      await wait(() => states.includes("idle"));
      queued = true;
      await wait(() => acked && states.at(-1) === "idle");
      proc.stdin.write("\x1b[200~approve-fixture\r\nsecond line\x1b[201~");
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(states.includes("waiting"), false);
      proc.stdin.write("\r");
      await wait(() => states.at(-1) === "waiting");
      proc.stdin.write("/approve 1\r");
      await wait(() => states.at(-1) === "idle");
      const history = new AntigravityHistory(journal),
        host = { id: "local", kind: "local" } as HostConfig;
      const detail = await history.read(host, undefined, id);
      assert.equal(
        detail.items.filter((i) => i.kind === "assistant").length,
        2,
      );
      assert.ok(
        detail.items.some((i) => i.text === "approve-fixture\nsecond line"),
      );
      const usage = await history.usage(host, id);
      assert.equal(usage?.usedTokens, 250);
      assert.equal(usage?.contextWindow, 1000);
      proc.stdin.write("/exit\r");
      await wait(() => proc.exitCode !== null);
      states.length = 0;
      proc = start(true);
      proc.stdout.resume();
      proc.stderr.resume();
      await wait(() => states.includes("idle"));
      const trace = (await readFile(join(dir, "trace"), "utf8"))
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x));
      assert.equal(
        trace.filter((x) => x[0] === "prompt" && x[2].includes("peer-fixture"))
          .length,
        1,
      );
      assert.ok(trace.some((x) => x[0] === "session/load" && x[1] === id));
      assert.ok(
        trace.some((x) => x[0] === "permission" && x[1].optionId === "one"),
      );
      proc.stdin.write("/exit\r");
      await wait(() => proc.exitCode !== null);
    } finally {
      proc.kill();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Windows installation directory resolves the exe with a stale PATH",
  { skip: process.platform !== "win32" },
  async () => {
    const root = resolve(".cache/antigravity-test");
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "path-"));
    try {
      const bin = join(dir, "agy", "bin");
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, "agy.exe"), "fixture");
      assert.equal(
        findAntigravity({ LOCALAPPDATA: dir, PATH: "" }),
        join(bin, "agy.exe"),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test(
  "Antigravity MCP reads and replies to scoped Codex and Claude questions",
  { timeout: 15000 },
  async () => {
    const root = resolve(".cache/antigravity-test");
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "mcp-"));
    const terminals: TerminalInfo[] = (
      ["codex", "claude", "antigravity"] as const
    ).map((kind) => ({
      id: kind,
      program: kind,
      agentKind: kind,
      agentSessionId: "native-" + kind,
      title: kind,
      hostId: "local",
      cwd: "/fixture",
      exited: false,
    }));
    const host = (id: string) => ({ id, name: "fixture" });
    const mailbox = new Mailbox(dir, {
      host,
      terminal: (id) => terminals.find((t) => t.id === id),
    });
    const bridge = new AgentBridge(mailbox, {
      host,
      terminals: () => terminals,
    });
    const credentials = bridge.issue("antigravity");
    for (const t of terminals)
      bridge.setPeerRuntime(t.id, {
        kind: t.agentKind!,
        sessionId: t.agentSessionId,
        state: "idle",
        delivery: "automatic",
      });
    const app = createServer(createBridgeRouter(bridge)).listen(0, "127.0.0.1");
    await once(app, "listening");
    const addr = app.address();
    assert.ok(addr && typeof addr !== "string");
    const child = spawn(
      process.execPath,
      [resolve("desktop/antigravity.cjs"), "--mcp"],
      {
        stdio: "pipe",
        windowsHide: true,
        env: {
          ...process.env,
          HARBOR_AGY_BRIDGE: "http://127.0.0.1:" + addr.port + "/bridge/mcp",
          HARBOR_SESSION_TOKEN: credentials.token,
        },
      },
    );
    const output = createInterface({ input: child.stdout });
    let seq = 0;
    const rpc = async (method: string, params: unknown) => {
      const next = once(output, "line", { signal: AbortSignal.timeout(4000) });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }) + "\n",
      );
      const r = JSON.parse(String((await next)[0]));
      assert.equal(r.id, seq);
      assert.equal(r.error, undefined);
      assert.ok(!r.result.isError);
      return r.result;
    };
    try {
      await rpc("initialize", {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "fixture", version: "1" },
        capabilities: {},
      });
      for (const sender of ["codex", "claude"]) {
        const question = bridge.peers.send(
          sender,
          "antigravity",
          "scoped question",
          "question",
        );
        const read = await rpc("tools/call", {
          name: "harbor_inbox",
          arguments: { unreadOnly: true },
        });
        assert.ok(
          JSON.parse(read.content[0].text).messages.some(
            (m: { id: string }) => m.id === question.id,
          ),
        );
        await rpc("tools/call", {
          name: "harbor_reply",
          arguments: { messageId: question.id, text: "fixture reply" },
        });
        assert.equal(
          bridge.peers.result(sender, question.id).status,
          "answered",
        );
      }
    } finally {
      output.close();
      child.kill();
      app.closeAllConnections();
      await new Promise<void>((r) => app.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
