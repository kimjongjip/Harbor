import assert from "node:assert/strict";
import test from "node:test";
import type { IdeChatConversation } from "../shared/ide-chat";
import { sideSettings, withParentActivity } from "./ide/side-parent";

test("follow-ups sample current work and reject replies from a replaced parent connection", async () => {
  const parent = {id:"parent",runtimeId:"worker-a",nativeId:"native-a",hostId:"local",provider:"codex",cwd:"/project",
    model:"last-model",configuredModel:"selected-model",effort:"high",supportsSideFork:true,items:[]} as unknown as IdeChatConversation;
  let latest={...parent,items:[{id:"tool",kind:"command" as const,text:"npm test",detail:"starting"}]};
  const read=async()=>Response.json(latest);
  assert.equal(sideSettings(parent,"codex").model,"selected-model");
  assert.equal(sideSettings(parent,"claude").model,undefined);
  assert.equal(sideSettings(parent,"codex").sideParent?.nativeId,parent.nativeId);
  assert.match(await withParentActivity(read,parent,"progress?"),/starting/);
  latest.items[0].detail="late assertion failure";
  assert.match(await withParentActivity(read,parent,"why?"),/late assertion failure/);
  latest={...latest,runtimeId:"worker-b"};
  await assert.rejects(withParentActivity(read,parent,"why?"));
});
