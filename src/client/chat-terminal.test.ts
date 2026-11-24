import test from "node:test";
import assert from "node:assert/strict";
import { chatTerminalTarget } from "./ide/chat-terminal";
import type { TerminalInfo } from "../shared/types";
import type { IdeChatConversation } from "../shared/ide-chat";

const terminal: TerminalInfo = {id:"terminal", hostId:"host", cwd:"/fixture", title:"Compiler 작업",
  exited:false, connectionState:"connected", agentKind:"codex", agentSessionId:"original", agentConnected:true};
const chat = {id:"handle", hostId:"host", provider:"codex", nativeId:"original", status:"running",
  live:{terminalId:terminal.id, origin:"terminal", terminalTitle:terminal.title, canSend:true, transport:"codex-native"}
} as IdeChatConversation;

test("terminal navigation requires a user-visible, same-account, same-session target", () => {
  assert.equal(chatTerminalTarget(chat,[terminal],undefined,false),terminal);
  for (const patch of [{id:"other"},{hostId:"other"},{agentSessionId:"another"},{agentConnected:false},
    {agentKind:"claude" as const},{connectionState:"disconnected" as const},{exited:true}])
    assert.equal(chatTerminalTarget(chat,[{...terminal,...patch}],undefined,false),undefined);
  assert.equal(chatTerminalTarget(chat,[],undefined,false),undefined);
  assert.equal(chatTerminalTarget(chat,[terminal],undefined,true),undefined);
  assert.equal(chatTerminalTarget({...chat,status:"offline"},[terminal],undefined,false),undefined);
  assert.equal(chatTerminalTarget({...chat,live:{...chat.live!,terminalTitle:undefined}},[terminal],undefined,false),undefined);
});

test("private ACP adapters and legacy worker handles do not advertise an open terminal", () => {
  const adapter = {...terminal,agentKind:"antigravity" as const};
  const c = {...chat,provider:"antigravity" as const,live:{...chat.live!,origin:"managed" as const,
    terminalTitle:undefined,transport:"antigravity-acp" as const}};
  assert.equal(chatTerminalTarget(c,[adapter],adapter.id,false),undefined);
  const legacy = {...c,live:{...c.live,origin:undefined}};
  assert.equal(chatTerminalTarget(legacy,[adapter],undefined,false),undefined);
  assert.equal(chatTerminalTarget(legacy,[adapter],adapter.id,false),adapter);
  assert.equal(chatTerminalTarget(legacy,[adapter],adapter.id,true),undefined);
  const needed = {...c,status:"waiting" as const,live:{...c.live,canSend:false}};
  assert.equal(chatTerminalTarget(needed,[adapter],undefined,false),adapter);
  assert.equal(chatTerminalTarget(needed,[adapter],undefined,true),undefined);
});
