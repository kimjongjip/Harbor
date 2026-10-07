import test from "node:test";
import assert from "node:assert/strict";
import { claudeArguments, claudeHookSettings, claudeHookSchema } from "./claude-hooks.js";
import { bashInitialization, powershellInitialization } from "./terminal-shell.js";
import type { HostConfig } from "../shared/types.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import express from "express";
import { AgentBridge } from "./agent-bridge.js";
import { Mailbox } from "./mailbox.js";
import { Requests } from "./requests.js";

test("Claude HTTP hooks authenticate, scope metadata and honor only explicit permission decisions", async t => {
  const parent=resolve(".cache/claude-hook-tests"); await mkdir(parent,{recursive:true});
  const dir=await mkdtemp(join(parent,"run-"));
  const terminals=["a","b"].map(id=>({id,hostId:"fixture",title:id,cwd:"/fixture",exited:false}));
  const resolver={terminal:(id:string)=>terminals.find(t=>t.id===id),host:(id:string)=>({id,name:"fixture"})};
  const requests=new Requests(dir,resolver), mailbox=new Mailbox(dir,resolver);
  const events:any[]=[];
  const bridge=new AgentBridge(mailbox,{terminals:()=>terminals,host:resolver.host,requests,onClaudeEvent:(id,event)=>events.push({id,event})});
  const app=express();app.use("/claude",bridge.claudeHandle);
  const server=createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(async()=>{requests.shutdown();await new Promise<void>(done=>{server.close(()=>done());server.closeAllConnections();});assert.ok(resolve(dir).startsWith(parent+sep));await rm(dir,{recursive:true,force:true});});
  const issued=bridge.issue("a");
  const url=`http://127.0.0.1:${(server.address() as any).port}/claude`;
  const post=(body:any,token=issued.hookToken)=>fetch(url,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
  const start={hook_event_name:"SessionStart",session_id:"synthetic",cwd:"/fixture/a"};
  assert.equal((await post(start,issued.token)).status,401);
  assert.equal((await post(start)).status,200);
  assert.equal(events.length,1);assert.equal(events[0].id,"a");
  const reference=bridge.annotations.capture("a",{text:"selected Claude text",source:{hostName:"fixture",title:"a",cwd:"/fixture/a"}});
  const annotated=await (await post({hook_event_name:"UserPromptSubmit",session_id:"synthetic",prompt:`${reference.reference} Explain this`})).json();
  assert.deepEqual(JSON.parse(annotated.hookSpecificOutput.additionalContext),{annotations:[{reference:reference.reference,text:"selected Claude text",source:{hostName:"fixture",title:"a",cwd:"/fixture/a"}}]});
  assert.deepEqual(await (await post({hook_event_name:"UserPromptSubmit",session_id:"synthetic",prompt:"ordinary prompt"})).json(),{});
  assert.equal((await (await post({hook_event_name:"UserPromptSubmit",session_id:"new-session",prompt:reference.reference})).json()).decision,"block");
  for(const choice of ["allow","deny"]){
    const changed=once(requests,"change");
    const pending=post({hook_event_name:"PermissionRequest",session_id:"synthetic",tool_name:"Bash",tool_input:{command:"echo fixture"}});
    await changed;
    const request=requests.list().find(r=>r.status==="pending")!;
    requests.respond(request.id,{text:"",optionId:choice});
    assert.equal((await (await pending).json()).hookSpecificOutput.decision.behavior,choice);
  }
  const count=requests.list().length;
  assert.deepEqual(await (await post({hook_event_name:"PermissionRequest",session_id:"synthetic",tool_name:"AskUserQuestion",tool_input:{questions:[]}})).json(),{});
  assert.equal(requests.list().length,count);
  bridge.revoke("a");assert.equal((await post(start)).status,401);
});

test("Claude settings use scoped HTTP hooks without MCP tools or embedded secrets", () => {
  const settings = JSON.parse(claudeHookSettings("http://127.0.0.1:123/bridge/claude"));
  assert.equal(settings.mcpServers, undefined);
  for (const entries of Object.values(settings.hooks) as any[]) {
    assert.equal(entries[0].hooks[0].headers.Authorization, "Bearer $HARBOR_HOOK_TOKEN");
    assert.deepEqual(entries[0].hooks[0].allowedEnvVars, ["HARBOR_HOOK_TOKEN"]);
  }
  assert.deepEqual(claudeArguments(undefined, "test-id", true), ["--resume", "test-id"]);
  assert.equal(claudeHookSchema.safeParse({hook_event_name:"SessionStart",session_id:"fixture",cwd:"/project"}).success,true);
  assert.equal(claudeHookSchema.safeParse({hook_event_name:"MadeUp",session_id:"fixture"}).success,false);
});

test("Claude shell launch and resume keep home shell start and isolate MCP credentials", () => {
  const host = {codexPath:"codex"} as HostConfig;
  const ps = powershellInitialization(host,"claude-resume","http://127.0.0.1:123/bridge/mcp","session",true,"C:\\project space");
  assert.ok(ps.includes("Remove-Item Env:HARBOR_SESSION_TOKEN"));
  assert.ok(ps.endsWith("Set-Location -LiteralPath 'C:\\project space' -ErrorAction Stop; claude --resume 'session'"));
  const bash = bashInitialization(host,"~","claude-resume",{token:"fixture",url:"http://127.0.0.1:123/bridge/mcp",hook:{token:"fixturehook",url:"http://127.0.0.1:123/bridge/permission"}},"session","/project space");
  assert.ok(bash.includes("unset HARBOR_SESSION_TOKEN; command claude"));
  assert.ok(bash.includes('cd "$HOME" || exit;'));
  assert.ok(bash.includes("/bridge/claude"));
});

