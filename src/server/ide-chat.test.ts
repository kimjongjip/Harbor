import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mailbox } from "./mailbox.js";
import { ManagedPeers } from "./managed-peers.js";
import { PeerDelivery } from "./peer-delivery.js";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { Hub } from "./hub.js";
import type { Store } from "./store.js";
import type { HostConfig } from "../shared/types.js";
import {
  IdeChats,
  IdeChatError,
  createIdeChatRouter,
  type IdeChatDependencies,
} from "./ide-chat.js";
import {
  createClaudeChatFactory,
  type ClaudeQuery,
} from "./ide-chat-claude.js";

const guard = () => {};

test("managed Claude auto toggle handles only the real pending check and cannot grant after disable or a forced human rule",async t=>{
  const results:any[]=[];let releaseCheck!:()=>void,checks=0;
  const slow=new Promise<void>(ok=>{releaseCheck=ok;});
  const sdk=((invocation:any)=>Object.assign((async function*(){
    const session_id=invocation.options.sessionId;
    const signal=new AbortController().signal;
    yield {type:"system",subtype:"init",session_id};
    for(const context of [{signal},{signal},{signal,matchedAskRule:{source:"user",toolName:"Read"}},{signal,defaultToNo:true}])
      results.push(await invocation.options.canUseTool("Read",{file_path:"note.txt"},context));
    yield {type:"result",subtype:"success",session_id,result:"fixture complete"};
  })(),{close(){},async interrupt(){}})) as unknown as ClaudeQuery;
  const {chats}=harness({claude:createClaudeChatFactory({query:sdk}),approveWorkspaceTargets:async()=>{
    if(++checks===2)await slow;
    return true;
  }});
  t.after(()=>chats.close());
  const v=await create(chats,"claude");await send(chats,v.id);
  await until(()=>chats.snapshot(v.id).approvals.length===1);
  await chats.setAutoAcceptance(v.id,{runtimeId:v.runtimeId,enabled:true},guard);
  await until(()=>checks===2);
  assert.deepEqual(results.map(r=>r.behavior),["allow"]);
  assert.equal(results[0].updatedPermissions,undefined);
  await chats.setAutoAcceptance(v.id,{runtimeId:v.runtimeId,enabled:false},guard);releaseCheck();
  await new Promise<void>(ok=>setImmediate(ok));
  assert.equal(results.length,1);
  await chats.answer(v.id,chats.snapshot(v.id).approvals[0].id,{runtimeId:v.runtimeId,approved:false},guard);
  await until(()=>results.length===2&&chats.snapshot(v.id).approvals.length===1);
  await chats.setAutoAcceptance(v.id,{runtimeId:v.runtimeId,enabled:true},guard);
  assert.equal(checks,2);assert.equal(results.length,2);
  await chats.answer(v.id,chats.snapshot(v.id).approvals[0].id,{runtimeId:v.runtimeId,approved:false},guard);
  await until(()=>results.length===3&&chats.snapshot(v.id).approvals.length===1);
  assert.equal(checks,2,"defaultToNo must always wait for the user");
  await chats.answer(v.id,chats.snapshot(v.id).approvals[0].id,{runtimeId:v.runtimeId,approved:false},guard);
  await until(()=>results.length===4);
  assert.deepEqual(results.map(r=>r.behavior),["allow","deny","deny","deny"]);
});

test("managed Codex auto acceptance acts only on matching, bounded native file edits and disables on disconnect",async t=>{
  const checked:string[]=[];
  const {chats,hub,client,replies,calls}=harness({approveWorkspaceTargets:async(h,cwd,targets)=>{
    assert.equal(h,host.id);checked.push(...targets.map(t=>t.file));return targets.every(t=>t.file==="fixture.ts");
  }});
  t.after(()=>chats.close());
  const first=await create(chats,"codex",{autoAccept:true}),second=await create(chats);
  assert.equal(first.autoAccept,true);assert.equal(second.autoAccept,false);
  await send(chats,first.id);await send(chats,second.id);
  const emit=(view:typeof first,id:number,extra:Record<string,unknown>={})=>{
    const s=hub.state().sessions.find(s=>s.threadId===view.nativeId)!;
    const meta={threadId:view.nativeId,turnId:s.activeTurnId,itemId:"edit-"+id};
    (hub as any).notification(host.id,{method:"item/started",params:{...meta,item:{type:"fileChange",id:meta.itemId,changes:[{path:"fixture.ts",kind:{type:"update"},diff:"@@ -1 +1 @@\n-old\n+updated"}]}}});
    (hub as any).request(host.id,client,{id,method:"item/fileChange/requestApproval",params:{...meta,...extra}});
    hub.emit("session",hub.session(s.id));
  };
  emit(first,231);emit(second,232);emit(first,233,{grantRoot:"/other"});
  (hub as any).request(host.id,client,{id:234,method:"item/commandExecution/requestApproval",params:{threadId:first.nativeId,command:"fixture"}});
  await until(()=>replies.some(r=>r.id===231));
  assert.deepEqual(replies.map(r=>[r.id,r.result]),[[231,{decision:"accept"}]]);
  assert.deepEqual(checked,["fixture.ts"]);
  assert.equal(calls.find(c=>c.method==="turn/start")?.params.sandboxPolicy.type,"workspaceWrite");
  assert.equal(calls.find(c=>c.method==="turn/start")?.params.approvalPolicy,"on-request");
  await chats.setAutoAcceptance(second.id,{enabled:true,runtimeId:second.runtimeId},guard);
  await until(()=>replies.some(r=>r.id===232));
  assert.ok(!replies.some(r=>r.id===233||r.id===234));
  hub.emit("host-closed",host.id);assert.equal(chats.snapshot(first.id).autoAccept,false);
  await assert.rejects(()=>create(chats,"claude",{reviewOnly:true,autoAccept:true}),/읽기 전용/);
});
test("managed telemetry follows its own host, native thread and parent-agent roster", async t=>{
  const {chats,hub}=harness({sessionUsage:async v=>({
    usage: {sessionId:"another-thread",provider:v.provider,usedTokens:99,costUsd:45,contextWindow:null,usedPercent:null,updatedAt:1,source:"history"},work:null
  })});
  t.after(()=>chats.close());
  const a=await create(chats),b=await create(chats);
  assert.equal((await chats.usage(a.id,guard)).usage,null);
  const emit=(method:string,params:unknown)=>(hub as any).notification(a.hostId,{method,params});
  emit("thread/tokenUsage/updated",{threadId:a.nativeId,tokenUsage:{last:{totalTokens:210},total:{totalTokens:8500},modelContextWindow:840}});
  emit("item/completed",{threadId:a.nativeId,item:{id:"tool-id",type:"collabAgentToolCall",tool:"spawnAgent",
    status:"completed",receiverThreadIds:["child"],prompt:"Review tests"}});
  const current=(await chats.usage(a.id,guard)).usage!;
  assert.equal(current.usedTokens,210);assert.equal(current.usedPercent,25);assert.equal(current.costUsd,null);
  assert.ok(current.crew?.agents.some(x=>x.id==="child"));assert.equal((await chats.usage(b.id,guard)).usage,null);
  emit("thread/compacted",{threadId:a.nativeId});assert.equal((await chats.usage(a.id,guard)).usage?.usedTokens,null);
  let checks=0;await assert.rejects(chats.usage(a.id,()=>{if(++checks===2)throw Error("revoked during read");}),/revoked/);
});
const imageFixture =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfgAAAABJRU5ErkJggg==";

test("managed Codex submits image-only input once, rejects changed payload or an image reservation", async (t) => {
  const { chats, calls } = harness();
  t.after(() => chats.close());
  const v = await create(chats);
  const body = {
    runtimeId: v.runtimeId,
    requestId: randomUUID(),
    text: "",
    images: [imageFixture],
  };
  await assert.rejects(
    chats.send(v.id, { ...body, delivery: "next" }, "desktop", guard),
    /예약/,
  );
  await assert.rejects(
    chats.send(
      v.id,
      { ...body, images: ["data:image/png;base64,aGVsbG8="] },
      "desktop",
      guard,
    ),
    /이미지/,
  );
  await chats.send(v.id, body, "desktop", guard);
  assert.ok((await chats.send(v.id, body, "desktop", guard)).duplicate);
  await assert.rejects(
    chats.send(
      v.id,
      { ...body, images: [imageFixture, imageFixture] },
      "desktop",
      guard,
    ),
    /다른 메시지/,
  );
  assert.deepEqual(
    calls.filter((c) => c.method === "turn/start").map((c) => c.params.input),
    [[{ type: "image", url: imageFixture }]],
  );
});

test("worktree mutations require write capability, a current runtime and a writable conversation", async (t) => {
  let count = 0;
  const { chats } = harness({
    gitAction: async (_host, _cwd, _input, validate) => {
      await validate();
      count++;
      return { ok: true };
    },
  });
  t.after(() => chats.close());
  const normal = await create(chats),
    review = await create(chats, "codex", { reviewOnly: true });
  const payload = { operation: "push" as const, runtimeId: normal.runtimeId };
  await assert.rejects(
    () => chats.changeWorktree(review.id, payload, guard),
    /읽기 전용/,
  );
  await assert.rejects(
    () =>
      chats.changeWorktree(
        normal.id,
        { ...payload, runtimeId: "previous" },
        guard,
      ),
    /연결이 바뀌/,
  );
  let permitted = false;
  const app = express();
  app.use(
    express.json(),
    createIdeChatRouter(chats, {
      authorize: () => {},
      actor: () => "phone",
      gitWrites: () => permitted,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  t.after(() => server.close());
  const send = () =>
    fetch(
      "http://127.0.0.1:" +
        (server.address() as AddressInfo).port +
        "/conversations/" +
        normal.id +
        "/worktree",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
  assert.equal((await send()).status, 403);
  assert.equal(count, 0);
  permitted = true;
  assert.equal((await send()).status, 200);
  assert.equal(count, 1);
});

test("opted-in managed Codex peers use native tool calls, wake idle sessions once and reject a stale or disabled identity", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "harbor-managed-peer-test-"));

  let managed: ManagedPeers;
  const mailbox = new Mailbox(dir, {
    terminal: (id) => managed.list().find((p) => p.id === id),
    host: (id) => ({ id, name: "Fixture" }),
  });
  const peers = new PeerDelivery(mailbox);
  managed = new ManagedPeers({
    mailbox,
    peers,
    terminals: () => [],
    hostName: () => "Fixture",
  });
  const { chats, hub, calls, replies, client } = harness({
    managedPeers: managed,
  });
  t.after(async () => {
    chats.close();
    await rm(dir, { recursive: true, force: true });
  });
  hub.managedPeerCall = (hostId, nativeId, name, args) =>
    managed.call({ hostId, nativeId, provider: "codex" }, name, args);
  const a = await create(chats),
    b = await create(chats);
  assert.equal(a.peerEnabled, false);
  assert.ok(
    calls
      .find((c) => c.method === "thread/start")
      ?.params.dynamicTools.some((tool: any) => tool.name === "harbor_ask"),
  );
  for (const v of [a, b])
    await chats.setCollaboration(
      v.id,
      { runtimeId: v.runtimeId, enabled: true },
      guard,
    );
  const [aid, bid] = managed.list().map((p) => p.id);
  const askArgs = {
    to: bid,
    question: "What changed?",
    requestKey: "initial",
    waitMs: 0,
  };
  (hub as any).request(host.id, client, {
    id: 21,
    method: "item/tool/call",
    params: { threadId: a.nativeId, tool: "harbor_ask", arguments: askArgs },
  });
  for (let i = 0; i < 40 && !calls.some((c) => c.method === "turn/start"); i++)
    await new Promise((r) => setTimeout(r, 5));
  const request = JSON.parse(
    replies.find((r) => r.id === 21)?.result.contentItems[0].text,
  ).request;
  assert.equal(request.status, "pending");
  assert.equal(request.message.sender.terminalId, aid);
  assert.equal(calls.filter((c) => c.method === "turn/start").length, 1);
  assert.equal(
    calls.find((c) => c.method === "turn/start")?.params.threadId,
    b.nativeId,
  );
  const sender = [...hub.sessions.values()].find(
    (s) => s.threadId === a.nativeId,
  )!;
  sender.status = "running";
  await managed.call(b, "harbor_reply", {
    messageId: request.requestId,
    text: "An actual result",
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.filter((c) => c.method === "turn/start").length, 1);
  sender.status = "idle";
  hub.emit("session", sender);
  for (
    let i = 0;
    i < 40 && calls.filter((c) => c.method === "turn/start").length < 2;
    i++
  )
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(
    calls.filter((c) => c.method === "turn/start").at(-1)?.params.threadId,
    a.nativeId,
  );
  assert.equal(calls.filter((c) => c.method === "turn/start").length, 2);
  const result = await managed.call(a, "harbor_ask_result", {
    requestId: request.requestId,
  });
  assert.equal(result.request?.reply?.text, "An actual result");
  await chats.setCollaboration(
    a.id,
    { runtimeId: a.runtimeId, enabled: false },
    guard,
  );
  await assert.rejects(
    managed.call(a, "harbor_send", { to: bid, text: "No longer authorized" }),
    /협업/,
  );
  await assert.rejects(
    managed.call({ ...b, nativeId: "wrong" }, "harbor_sessions", {}),
    /협업/,
  );
  const review = await create(chats, "codex", { reviewOnly: true });
  assert.equal(review.peerEnabled, undefined);
  assert.equal(
    calls.filter((c) => c.method === "thread/start").at(-1)?.params
      .dynamicTools,
    undefined,
  );
  await assert.rejects(
    chats.setCollaboration(
      review.id,
      { runtimeId: review.runtimeId, enabled: true },
      guard,
    ),
    /협업/,
  );
});
const host: HostConfig = {
  id: "test-host",
  name: "Test",
  kind: "ssh",
  address: "example.invalid",
  username: "test",
  port: 22,
  identityFile: "",
  codexPath: "codex",
  defaultCwd: "/old/default",
  mode: "isolated",
  color: "blue",
  createdAt: 0,
};
function harness(overrides: Partial<IdeChatDependencies> = {}) {
  const calls: { method: string; params: any }[] = [];
  const replies: { id: unknown; result: any }[] = [];
  const hub = new Hub({
    data: {
      hosts: [host],
      sessions: [],
      activities: [],
      transfers: [],
      discussions: [],
    },
    session() {},
    save() {},
    activity() {},
  } as unknown as Store);
  hub.host(host.id).status = "connected";
  const client = {
    alive: true,
    async call(method: string, params: any) {
      calls.push({ method, params });
      if (method === "thread/start")
        return {
          thread: { id: randomUUID(), cwd: params.cwd, status: "idle" },
        };
      if (method === "thread/read" || method === "thread/resume")
        return {
          thread: {
            id: params.threadId,
            cwd: "/project",
            status: "idle",
            name: "Prior work",
          },
        };
      if (method === "thread/turns/list") return { data: [], nextCursor: null };
      if (method === "turn/start") return { turn: { id: randomUUID() } };
      return {};
    },
    respond(id: unknown, result: unknown) {
      replies.push({ id, result });
    },
    rejectRequest() {},
  };
  hub.clients.set(host.id, client as any);
  const dependencies: IdeChatDependencies = {
    runtimeId: "test-runtime",
    hub,
    host: (id) => {
      assert.equal(id, host.id);
      return host;
    },
    password: async () => undefined,
    resolveCwd: async (_hostId, cwd) => cwd || "/home/test",
    historyList: async () => ({ data: [], nextCursor: null }),
    historyRead: async (hostId, provider, id) => ({
      thread: {
        provider,
        id,
        hostId,
        title: "Past conversation",
        cwd: "/project",
        preview: "",
        updatedAt: 0,
        source: "test",
        active: false,
      },
      items: [{ id: "old-user", kind: "user", text: "Previous question" }],
      nextCursor: "next",
    }),
    nativeActive: () => false,
    ...overrides,
  };
  const chats = new IdeChats(dependencies);
  return { chats, hub, calls, replies, client, dependencies };
}
const create = (
  chats: IdeChats,
  provider: "codex" | "claude" = "codex",
  extra = {},
) =>
  chats.create(
    { hostId: host.id, provider, requestId: randomUUID(), ...extra },
    "desktop",
    guard,
  );
const send = (
  chats: IdeChats,
  id: string,
  text = "Explain this project",
  requestId = randomUUID(),
) =>
  chats.send(
    id,
    { runtimeId: "test-runtime", requestId, text },
    "desktop",
    guard,
  );
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(predicate());
}

test("chat controls validate the selected engine and apply model, effort and read-only policy to the next native turn", async () => {
  const {chats,calls}=harness({models:async()=>[{id:"fixture-codex",name:"Fixture",isDefault:true,efforts:["high","max"]}]});
  const view=await create(chats);
  const settings={runtimeId:view.runtimeId,model:"fixture-codex",effort:"max" as const,permission:"read-only" as const};
  await assert.rejects(chats.settings(view.id,{...settings,effort:"ultra"},guard));
  await assert.rejects(chats.settings(view.id,{...settings,permission:"auto-accept"},guard));
  assert.equal(chats.snapshot(view.id).permission,"default");
  const updated=await chats.settings(view.id,settings,guard);
  assert.equal(updated.nativeId,view.nativeId);
  assert.equal(updated.permission,"read-only");
  assert.equal(updated.configuredModel,"fixture-codex");
  await send(chats,view.id,"Inspect the selected file");
  const cmd=calls.find(c=>c.method==="turn/start")!;
  assert.equal(cmd.params.model,"fixture-codex");
  assert.equal(cmd.params.effort,"max");
  assert.equal(cmd.params.sandboxPolicy.type,"readOnly");
  assert.equal(cmd.params.approvalPolicy,"never");
  await assert.rejects(chats.settings(view.id,{runtimeId:view.runtimeId,permission:"default"},guard));
  const review=await create(chats,"codex",{reviewOnly:true});
  await assert.rejects(chats.settings(review.id,{runtimeId:review.runtimeId,permission:"default"},guard));
  chats.close();
});
test("settings preserve untouched fields, survive polling and restore from the same native journal",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"harbor-chat-settings-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const dependency={reservationDirectory:dir,models:async()=>[{id:"test-model",name:"Test",isDefault:true,efforts:["high" as const]}]};
  const {chats}=harness(dependency);
  const c=await create(chats,"claude",{model:"test-model",effort:"high"});
  const patch=await chats.settings(c.id,{runtimeId:c.runtimeId,changedFields:["permission"],permission:"accept-edits"},guard);
  assert.equal(patch.configuredModel,"test-model");assert.equal(patch.effort,"high");assert.equal(patch.permission,"accept-edits");
  assert.deepEqual((await chats.read(c.id,guard)).configuredModel,patch.configuredModel);
  chats.close();
  const reopened=harness(dependency).chats;t.after(()=>reopened.close());
  const restored=await create(reopened,"claude",{resumeId:c.nativeId});
  assert.deepEqual([restored.model,restored.configuredModel,restored.effort,restored.permission],["test-model","test-model","high","accept-edits"]);
  const inherit=await reopened.settings(restored.id,{runtimeId:restored.runtimeId,changedFields:["effort"]},guard);
  assert.equal(inherit.effort,undefined);assert.equal(inherit.configuredModel,"test-model");assert.equal(inherit.permission,"accept-edits");
});

test("native thread start/resume report resolved model and effort even when absent on thread metadata",async t=>{
  const {hub,client,chats}=harness();
  t.after(()=>chats.close());
  const orig=client.call.bind(client);
  client.call=async(method,params)=>{
    const result=await orig(method,params);
    if(method==="thread/start" || method==="thread/resume")Object.assign(result,{model:"fixture-actual",reasoningEffort:"high"});
    return result;
  };
  const c=await create(chats);
  const updated=await chats.read(c.id,guard);
  assert.equal(updated.model,"fixture-actual");assert.equal(updated.observedEffort,"high");
  assert.equal(updated.observedModel,"fixture-actual");
  assert.equal(updated.configuredModel,undefined);
  const reset=await chats.settings(c.id,{runtimeId:c.runtimeId,changedFields:["model"]},guard);
  assert.equal(reset.configuredModel,"");assert.equal(reset.observedModel,"fixture-actual");
});

test("managed reservations survive client disconnect, allow editing and dispatch once when the active turn finishes", async () => {
  const { chats, hub, calls } = harness();
  const view = await create(chats, "codex", {
    reviewOnly: true,
    effort: "high",
  });
  await send(chats, view.id, "inspect");
  assert.equal(
    calls.find((c) => c.method === "turn/start")!.params.approvalPolicy,
    "never",
  );
  const session = [...hub.sessions.values()].find(
    (s) => s.threadId === view.nativeId,
  )!;
  const reserve = (text: string, requestId: string) =>
    chats.send(
      view.id,
      { text, requestId, runtimeId: view.runtimeId, delivery: "next" },
      "desktop",
      guard,
    );
  const requestId = randomUUID();
  await reserve("original", requestId);
  await reserve("original", requestId);
  await reserve("remove", randomUUID());
  let queue = chats.snapshot(view.id).queue!;
  assert.equal(queue.length, 2);
  await chats.modifyQueue(
    view.id,
    queue[0].id,
    {
      runtimeId: view.runtimeId,
      expectedText: "original",
      action: "edit",
      text: "revised",
    },
    guard,
  );
  await chats.modifyQueue(
    view.id,
    queue[1].id,
    { runtimeId: view.runtimeId, expectedText: "remove", action: "remove" },
    guard,
  );
  session.status = "idle";
  session.activeTurnId = undefined;
  hub.emit("session", session);
  hub.emit("session", session);
  await until(() => chats.snapshot(view.id).queue?.length === 0);
  assert.deepEqual(
    calls
      .filter((c) => c.method === "turn/start")
      .map((c) => c.params.input[0].text),
    ["inspect", "revised"],
  );
  chats.close();
});
test("restart restores exact queued drafts without replaying past authorization, preserving edits, receipts and review mode", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "harbor-queue-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness({ reservationDirectory: dir });
  const v = await create(h.chats, "codex", {
    reviewOnly: true,
    effort: "high",
  });
  await send(h.chats, v.id, "busy");
  let stale = false;
  const id = randomUUID(),
    input = {
      runtimeId: v.runtimeId,
      requestId: id,
      text: "pending",
      delivery: "next" as const,
    };
  await h.chats.send(v.id, input, "phone", () => {
    if (stale) throw Error("expired device");
  });
  const entry = h.chats.snapshot(v.id).queue![0].id;
  await h.chats.modifyQueue(
    v.id,
    entry,
    {
      runtimeId: v.runtimeId,
      expectedText: "pending",
      action: "edit",
      text: "edited",
    },
    guard,
  );
  h.chats.close();
  stale = true;
  const changed = harness({
    reservationDirectory: dir,
    host: (id) => ({ ...host, id, address: "replacement.invalid" }),
  });
  const unrelated = await create(changed.chats, "codex", {
    resumeId: v.nativeId,
  });
  assert.ok(!unrelated.queue?.length);
  changed.chats.close();
  const h2 = harness({
    reservationDirectory: dir,
    runtimeId: "second-runtime",
  });
  const v2 = await create(h2.chats, "codex", { resumeId: v.nativeId });
  assert.equal(v2.queue?.[0].text, "edited");
  assert.equal(v2.queue?.[0].needsAuthorization, true);
  assert.equal(v2.reviewOnly, true);
  assert.equal(v2.effort, "high");
  assert.equal(
    (
      await h2.chats.send(
        v2.id,
        { ...input, runtimeId: v2.runtimeId },
        "phone",
        guard,
      )
    ).duplicate,
    true,
  );
  assert.equal(h2.calls.filter((c) => c.method === "turn/start").length, 0);
  const auth = {
    runtimeId: v2.runtimeId,
    expectedText: "edited",
    action: "authorize" as const,
  };
  await assert.rejects(
    h2.chats.modifyQueue(v2.id, entry, auth, () => {
      throw Error("revoked");
    }),
    /revoked/,
  );
  await h2.chats.modifyQueue(v2.id, entry, auth, guard, "desktop");
  await until(() => h2.chats.snapshot(v2.id).queue?.length === 0);
  assert.deepEqual(
    h2.calls
      .filter((c) => c.method === "turn/start")
      .map((c) => c.params.input[0].text),
    ["edited"],
  );
  h2.chats.close();
});

test("crash between native dispatch and acknowledgement restores an uncertain reservation without a resend action", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "harbor-queue-crash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness({ reservationDirectory: dir }),
    v = await create(h.chats);
  const call = h.client.call.bind(h.client);
  let acknowledge!: () => void,
    started = false;
  h.client.call = async (method, params) => {
    if (method === "turn/start") {
      started = true;
      await new Promise<void>((done) => {
        acknowledge = done;
      });
    }
    return call(method, params);
  };
  await h.chats.send(
    v.id,
    {
      text: "run once",
      delivery: "next",
      runtimeId: v.runtimeId,
      requestId: randomUUID(),
    },
    "test",
    guard,
  );
  await until(() => started);
  h.chats.close();
  acknowledge();
  const h2 = harness({ reservationDirectory: dir }),
    v2 = await create(h2.chats, "codex", { resumeId: v.nativeId });
  const item = v2.queue![0];
  assert.match(item.error!, /미확인/);
  assert.ok(!item.needsAuthorization);
  await assert.rejects(
    h2.chats.modifyQueue(
      v2.id,
      item.id,
      { expectedText: item.text, runtimeId: v2.runtimeId, action: "authorize" },
      guard,
    ),
    /전송 여부/,
  );
  await h2.chats.modifyQueue(
    v2.id,
    item.id,
    { expectedText: item.text, runtimeId: v2.runtimeId, action: "remove" },
    guard,
  );
  assert.equal(h2.calls.filter((c) => c.method === "turn/start").length, 0);
  h2.chats.close();
});

test("quota-reset reservation waits for the explicit deadline and checks the same recovered account once",async t=>{
 const startAt=1700000000000;t.mock.timers.enable({apis:["Date","setTimeout"],now:startAt});
 const accountKey="a".repeat(64),expiry=startAt+10000;
 const h=harness({reservationQuota:async(_h,_p,_m,fresh)=>({accountKey,notBefore:fresh?undefined:expiry})});
 const view=await create(h.chats);
 const input={delivery:"reset" as const,requestId:randomUUID(),runtimeId:view.runtimeId,text:"run after reset"};
 await assert.rejects(h.chats.send(view.id,input,"test",guard),/초기화/);
 assert.equal((await h.chats.resetWindow(view.id,guard)).notBefore,expiry);
 await h.chats.send(view.id,input,"test",guard);
 assert.equal(h.chats.snapshot(view.id).queue?.[0].notBefore,expiry);
 t.mock.timers.tick(9999); await new Promise<void>(r=>setImmediate(r));
 assert.equal(h.calls.filter(c=>c.method==="turn/start").length,0);
 t.mock.timers.tick(1); await new Promise<void>(r=>setImmediate(r));
 assert.equal(h.calls.filter(c=>c.method==="turn/start").length,1);
 assert.equal(h.chats.snapshot(view.id).queue?.length,0);
 h.chats.close();
});
test("fresh Codex chat starts at actual home and sends one structured turn without a terminal", async () => {
  const { chats, calls } = harness();
  const requestId = randomUUID();
  const input = { hostId: host.id, provider: "codex" as const, requestId };
  const [first, duplicate] = await Promise.all([
    chats.create(input, "desktop", guard),
    chats.create(input, "desktop", guard),
  ]);
  assert.equal(first.id, duplicate.id);
  assert.equal(first.cwd, "/home/test");
  assert.equal(
    calls.filter((call) => call.method === "thread/start").length,
    1,
  );
  assert.equal(calls[0].params.approvalPolicy, "on-request");
  const messageId = randomUUID();
  await send(chats, first.id, "hello", messageId);
  assert.equal(
    (await send(chats, first.id, "hello", messageId)).duplicate,
    true,
  );
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 1);
  assert.deepEqual(
    calls.find((call) => call.method === "turn/start")?.params.input,
    [{ type: "text", text: "hello", text_elements: [] }],
  );
  await assert.rejects(
    send(chats, first.id, "different", messageId),
    /다른 메시지/,
  );
  await assert.rejects(send(chats, first.id, "second prompt"), /현재 답변/);
});

test("both providers title quoted messages with the question while sending the full selection", async () => {
  const question = "이 함수 설명해줘";
  const text = `${question}\n\n<editor_selection>\n${JSON.stringify({ path: "/project/example.ts", startLine: 2, endLine: 4, unsaved: true, text: "function selected() {\n  return 42;\n}" }, null, 2)}\n</editor_selection>`;
  for (const provider of ["codex", "claude"] as const) {
    let claudeText = "";
    const { chats, calls } = harness({
      claude: (turn) => {
        claudeText = turn.text;
        return { done: Promise.resolve(), async interrupt() {}, close() {} };
      },
    });
    const view = await create(chats, provider);
    await send(chats, view.id, text);
    assert.equal(chats.snapshot(view.id).title, question, provider);
    assert.equal(
      provider === "codex"
        ? calls.find((call) => call.method === "turn/start")?.params.input[0]
            .text
        : claudeText,
      text,
      "selection metadata must remain in the native prompt",
    );
    if (provider === "claude")
      assert.equal(chats.snapshot(view.id).items[0].text, text);
    const malformed = "Q\n\n<editor_selection>\n{}\n</editor_selection>";
    const next = await create(chats, provider);
    await send(chats, next.id, malformed);
    assert.equal(
      chats.snapshot(next.id).title,
      malformed,
      "ordinary literal text is retained",
    );
    chats.close();
  }
});

test("history resume can open a closed native conversation; an open CLI blocks competing writers", async () => {
  let active = false;
  const { chats, calls } = harness({ nativeActive: () => active });
  const nativeId = randomUUID();
  const resumed = await create(chats, "codex", { resumeId: nativeId });
  assert.equal(resumed.nativeId, nativeId);
  assert.equal(resumed.cwd, "/project");
  assert.ok(calls.some((call) => call.method === "thread/resume"));
  assert.equal(
    (await create(chats, "codex", { resumeId: nativeId })).id,
    resumed.id,
  );
  active = true;
  await assert.rejects(send(chats, resumed.id), /터미널에서 열려/);
  await assert.rejects(
    create(chats, "claude", { resumeId: randomUUID() }),
    /터미널에서 열려/,
  );
});

test("the same create request recovers after a busy native CLI is closed", async () => {
  let active = true;
  const { chats } = harness({ nativeActive: () => active });
  const input = {
    hostId: host.id,
    provider: "claude" as const,
    resumeId: randomUUID(),
    requestId: randomUUID(),
  };
  await assert.rejects(
    chats.create(input, "desktop", guard),
    /터미널에서 열려/,
  );
  active = false;
  assert.equal(
    (await chats.create(input, "desktop", guard)).nativeId,
    input.resumeId,
  );
});

test("late auth revocation at native dispatch sends no prompt; runtime IDs are checked", async () => {
  const { chats, hub, calls } = harness();
  const view = await create(chats);
  let allowed = true;
  const originalOpen = hub.openSession.bind(hub);
  hub.openSession = async (id) => {
    const result = await originalOpen(id);
    allowed = false;
    return result;
  };
  await assert.rejects(
    chats.send(
      view.id,
      { runtimeId: view.runtimeId, requestId: randomUUID(), text: "sensitive" },
      "desktop",
      () => {
        if (!allowed) throw new IdeChatError("revoked", 403);
      },
    ),
    /revoked/,
  );
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 0);
  await assert.rejects(
    chats.send(
      view.id,
      { runtimeId: "stale", requestId: randomUUID(), text: "hello" },
      "desktop",
      guard,
    ),
    /연결이 바뀌/,
  );
});

test("uncertain turn dispatch is retained and retry does not submit it twice", async () => {
  const { chats, client, calls } = harness();
  const view = await create(chats);
  const originalCall = client.call.bind(client);
  client.call = async (method, params) => {
    const result = await originalCall(method, params);
    if (method === "turn/start") throw new Error("response lost");
    return result;
  };
  const requestId = randomUUID();
  await assert.rejects(
    send(chats, view.id, "only once", requestId),
    /response lost/,
  );
  assert.equal(
    (await send(chats, view.id, "only once", requestId)).status,
    "uncertain",
  );
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 1);
});

test("a changed host binding cannot receive a prompt intended for its previous server", async () => {
  const config = { ...host };
  const { chats } = harness({ host: () => config });
  const view = await create(chats, "claude");
  config.address = "changed.invalid";
  await assert.rejects(send(chats, view.id), /서버 연결 설정이 바뀌/);
  const reopened = await create(chats, "claude", { resumeId: view.nativeId });
  assert.notEqual(reopened.id, view.id);
});

test("read-only managed children can decline tool permission but cannot grant it",async()=>{
  const {chats,hub,client,replies}=harness();
  const child=await create(chats,"codex",{reviewOnly:true});
  (hub as any).request(host.id,client,{id:77,method:"item/permissions/requestApproval",params:{threadId:child.nativeId,permissions:{network:{enabled:true}}}});
  const ask=chats.snapshot(child.id).approvals[0];
  await assert.rejects(chats.answer(child.id,ask.id,{runtimeId:child.runtimeId,approved:true},guard),/읽기 전용/);
  assert.equal(replies.length,0);
  await chats.answer(child.id,ask.id,{runtimeId:child.runtimeId,approved:false},guard);
  assert.equal(replies.length,1);
  assert.deepEqual(replies[0].result.permissions,{});
  chats.close();
});
test("Codex approval is bound to native conversation and only grants original turn permissions", async () => {
  const { chats, hub, client, replies } = harness();
  const first = await create(chats),
    second = await create(chats);
  const permissions = {
    network: { enabled: true },
    fileSystem: { read: ["/specific"] },
  };
  (hub as any).request(host.id, client, {
    id: 100,
    method: "item/permissions/requestApproval",
    params: { threadId: first.nativeId, permissions },
  });
  const approval = chats.snapshot(first.id).approvals[0];
  const previousRevision = chats.snapshot(first.id).revision;
  await assert.rejects(
    chats.answer(
      second.id,
      approval.id,
      { runtimeId: first.runtimeId, approved: true },
      guard,
    ),
    /대기 중인 승인 요청이 아닙니다/,
  );
  await chats.answer(
    first.id,
    approval.id,
    { runtimeId: first.runtimeId, approved: true },
    guard,
  );
  assert.ok(chats.snapshot(first.id).revision > previousRevision);
  assert.deepEqual(replies, [
    { id: 100, result: { permissions, scope: "turn" } },
  ]);
  await assert.rejects(
    chats.answer(
      first.id,
      approval.id,
      { runtimeId: first.runtimeId, approved: true },
      guard,
    ),
    /대기 중인 승인 요청이 아닙니다/,
  );
});

test("Claude SDK streams a native answer, asks permission in IDE, and resumes its persisted ID", async () => {
  const invocations: any[] = [];
  const permissionResults: any[] = [];
  const fakeQuery = ((invocation: any) => {
    invocations.push(invocation);
    return {
      async *[Symbol.asyncIterator]() {
        const prompt = (await invocation.prompt[Symbol.asyncIterator]().next())
          .value;
        const session_id =
          invocation.options.sessionId || invocation.options.resume;
        assert.equal(prompt.message.role, "user");
        if (invocations.length === 1)
          assert.deepEqual(prompt.message.content, [
            { type: "text", text: "Look" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: imageFixture.split(",")[1],
              },
            },
          ]);
        yield {
          type: "system",
          subtype: "init",
          session_id,
          model: "fake-model",
        };
        permissionResults.push(
          await invocation.options.canUseTool(
            "Bash",
            { command: "echo sample" },
            { signal: new AbortController().signal },
          ),
        );
        yield {
          type: "stream_event",
          session_id,
          event: { type: "message_start", message: { id: "reply-id" } },
        };
        yield {
          type: "stream_event",
          session_id,
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        };
        yield {
          type: "stream_event",
          session_id,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Rendered answer" },
          },
        };
        yield {
          type: "assistant",
          session_id,
          message: {
            id: "reply-id",
            content: [{ type: "text", text: "Rendered answer" }],
          },
        };
        yield {
          type: "result",
          session_id,
          subtype: "success",
          is_error: false,
        };
      },
      async interrupt() {},
      close() {},
    };
  }) as ClaudeQuery;
  const { chats } = harness({
    claude: createClaudeChatFactory({ query: fakeQuery }),
  });
  const view = await create(chats, "claude");
  assert.equal(invocations.length, 0, "creating a draft doesn't start a model");
  await chats.send(
    view.id,
    {
      text: "Look",
      images: [imageFixture],
      runtimeId: view.runtimeId,
      requestId: randomUUID(),
    },
    "desktop",
    guard,
  );
  await until(() => chats.snapshot(view.id).status === "waiting");
  const approval = chats.snapshot(view.id).approvals[0];
  await chats.answer(
    view.id,
    approval.id,
    { runtimeId: view.runtimeId, approved: true },
    guard,
  );
  await until(() => chats.snapshot(view.id).status === "idle");
  const done = chats.snapshot(view.id);
  assert.equal(
    done.items.filter((item) => item.kind === "assistant").length,
    1,
  );
  assert.equal(
    done.items.find((item) => item.kind === "assistant")?.text,
    "Rendered answer",
  );
  assert.equal(permissionResults[0].behavior, "allow");
  assert.equal(invocations[0].options.permissionMode, "default");
  assert.deepEqual(invocations[0].options.settingSources, [
    "user",
    "project",
    "local",
  ]);
  await send(chats, view.id, "continue");
  await until(() => chats.snapshot(view.id).status === "waiting");
  assert.equal(invocations[1].options.resume, view.nativeId);
  assert.equal(invocations[1].options.sessionId, undefined);
  await chats.answer(
    view.id,
    chats.snapshot(view.id).approvals[0].id,
    { runtimeId: view.runtimeId, approved: false },
    guard,
  );
  await until(() => chats.snapshot(view.id).status === "idle");
  assert.equal(permissionResults[1].behavior, "deny");
  chats.close();
});

test("router enforces authorization for reads/writes and accepts scoped Codex approval IDs", async (t) => {
  let folderReads=0;
  const { chats, hub, client } = harness({folders:async(id,path)=>{
    assert.equal(id,host.id);folderReads++;
    return {path,parent:"/",folders:[{name:"project",path:path+"/project"}],truncated:false};
  }});
  const app = express();
  app.use(express.json());
  app.use(
    "/api/ide-chat",
    createIdeChatRouter(chats, {
      actor: () => "desktop",
      authorize: (req) => {
        if (req.headers.authorization !== "test-token")
          throw new IdeChatError("denied", 403);
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    chats.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ide-chat`;
  const folders=base+"/hosts/"+host.id+"/folders";
  assert.equal((await fetch(folders)).status,403);
  assert.equal(folderReads,0);
  const onlyDefault=await fetch(folders+"?list=0",{headers:{authorization:"test-token"}});
  assert.equal((await onlyDefault.json()).path,"/home/test");assert.equal(folderReads,0);
  const list=await fetch(folders+"?path=%2Fproject",{headers:{authorization:"test-token"}});
  assert.equal(list.status,200);assert.deepEqual((await list.json()).folders,[{name:"project",path:"/project/project"}]);
  assert.equal(folderReads,1);
  assert.equal(
    (await fetch(`${base}/hosts/${host.id}/history?provider=codex`)).status,
    403,
  );
  const response = await fetch(`${base}/conversations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "test-token",
    },
    body: JSON.stringify({
      hostId: host.id,
      provider: "codex",
      requestId: randomUUID(),
    }),
  });
  assert.equal(response.status, 200);
  const view = (await response.json()) as any;
  (hub as any).request(host.id, client, {
    id: 9,
    method: "item/commandExecution/requestApproval",
    params: { threadId: view.nativeId, command: "echo synthetic" },
  });
  const approval = chats.snapshot(view.id).approvals[0];
  const answer = await fetch(
    `${base}/conversations/${view.id}/approvals/${encodeURIComponent(approval.id)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "test-token",
      },
      body: JSON.stringify({ runtimeId: view.runtimeId, approved: true }),
    },
  );
  assert.equal(answer.status, 200);
  assert.equal((await fetch(`${base}/conversations/${view.id}`)).status, 403);
});
