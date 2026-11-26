import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { build } from "vite";
import { createServer } from "node:http";
import express from "express";
import react from "@vitejs/plugin-react";
import { _electron } from "playwright";

test(
  "IDE starts fresh without a terminal, resumes provider history and sends bound structured messages",
  { skip: process.platform !== "win32", timeout: 150000 },
  async () => {
    const root = resolve(".cache/ide-chat-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    await writeFile(
      join(directory, "fixture.tsx"),
      String.raw`
import React,{useState}from'react';import{createRoot}from'react-dom/client';
import IdeChatPanel from'/src/client/ide/IdeChatPanel';
import IdeWorkspace from'/src/client/ide/IdeWorkspace';
import'/src/client/styles.css';import'/src/client/themes.css';
window.calls=[];window.snapshots={};window.nextStatus='submitted';window.afterSendStatus='idle';window.created=new Map();window.sequence=0;window.deferSend=false;window.liveSources={};window.terminalActions=[];
const json=(value,status=200)=>new Response(JSON.stringify(value),{status});
const items=id=>[{id:id+'-q',kind:'user',text:'기존 질문 '+id},{id:id+'-tool',kind:'command',text:'echo synthetic',detail:'synthetic tool output',status:'completed'},{id:id+'-a',kind:'assistant',text:'# Answer '+id+'\n\n| Check | Value |\n| --- | --- |\n| Native | yes |\n\n~~~ts\nconst answer = 42;\n~~~'.replaceAll('\\n','\n')}];
function conversation(body){const id=body.resumeId?'resumed-'+body.hostId+'-'+body.provider+'-'+body.resumeId:'created-'+(++window.sequence);return{id,runtimeId:'runtime-fixture',hostId:body.hostId,provider:body.provider,nativeId:body.resumeId||'native-'+id,title:body.resumeId?'이전 대화 이어가기':'새 대화',cwd:body.cwd||'/fixture/home',model:body.model||'default',status:'idle',items:body.resumeId?items(id):[],approvals:[],historyCursor:body.resumeId?'older':null,revision:1,updatedAt:1,...(window.liveSources[body.resumeId]?{live:window.liveSources[body.resumeId]}:{})};}
async function request(path,init){const body=init?.body?JSON.parse(init.body):undefined;window.calls.push({path,body,headers:Object.fromEntries(new Headers(init?.headers))});
 if(path.startsWith('/hosts/')){const url=new URL(path,'http://fixture');const provider=url.searchParams.get('provider'),older=url.searchParams.has('cursor');return json({data:[{id:older?'old-thread':'history-thread',hostId:url.pathname.split('/')[2],provider,title:older?'Older history':'Saved '+provider+' conversation',preview:'이전 대화 내용',cwd:'/fixture/project',updatedAt:1700000000000,source:'cli',active:false}],nextCursor:older?null:'history-cursor'});}
 if(path==='/conversations'){if(window.created.has(body.requestId))return json(window.created.get(body.requestId));const value=conversation(body);window.created.set(body.requestId,value);window.snapshots[value.id]=value;if(window.deferResumeId&&body.resumeId===window.deferResumeId)return new Promise(resolve=>window.releaseResume=()=>{window.deferResumeId='';resolve(json(value));});return json(value);}
 const [, ,id,action]=path.split('/');const value=window.snapshots[id];if(!value)return json({error:'No such conversation'},404);
 if(!body)return json(value);
 if(action==='messages'){const finish=()=>{if(window.nextStatus==='submitted'){value.items.push({id:body.requestId,kind:'user',text:body.text},{id:body.requestId+'-a',kind:'assistant',text:'# 직접 대화 응답\n\n| 결과 | 값 |\n| --- | --- |\n| 확인 | 성공 |\n\n~~~ts\nconst answer = 42;\n~~~'.replaceAll('\\n','\n')},{id:body.requestId+'-tool',kind:'command',text:'echo synthetic',detail:'synthetic tool output',status:'completed'});value.status=window.afterSendStatus;value.revision++;}return json({ok:true,requestId:body.requestId,status:window.nextStatus});};if(window.deferSend)return new Promise(resolve=>window.resolveSend=()=>{window.deferSend=false;resolve(finish());});return finish();}
 if(action==='history'){value.items.unshift({id:id+'-older',kind:'user',text:'더 오래된 질문'});value.historyCursor=null;value.revision++;return json(value);}
 if(action==='interrupt'){value.status='idle';value.approvals=[];value.revision++;return json({ok:true});}
 if(action==='approvals'){value.status='idle';value.approvals=[];value.revision++;return json({ok:true});}
 return json({error:'Unknown route'},404);
}
const file={terminalId:'fixture-terminal',hostId:'host-a',root:'/fixture',cwd:'/fixture',path:'/fixture/example.ts',content:'// 코드와 AI 대화\nexport function answer(): number {\n  return 42;\n}\n'.replaceAll('\\n','\n'),version:'1',binding:'fixture-binding',encoding:'utf-8',bom:false};
const editorApi={tree:async()=>({...file,path:'/fixture',parent:null,entries:[{name:'example.ts',path:file.path,kind:'file',size:100,modifiedAt:0,mode:0}],truncated:false}),read:async()=>({...file}),save:async(_old,content)=>({...file,content})};
function Fixture(){const[host,setHost]=useState('host-a');const[workspace,setWorkspace]=useState(false);const[attachment,setAttachment]=useState();const[terminal,setTerminal]=useState();const[active,setActive]=useState(true);window.setHost=setHost;window.setAttachment=setAttachment;window.setTerminal=setTerminal;window.setActive=setActive;window.showWorkspace=()=>setWorkspace(true);return <div style={{width:workspace?'100vw':520,height:workspace?'100vh':740,display:'flex',background:'#f4f6fa',color:'#15243c'}}>{workspace&&<div style={{flex:1,minWidth:0}}><IdeWorkspace api={editorApi} terminalId="fixture-terminal" hostId="host-a" hostLabel="Fixture" workspaceCwd="/fixture" visible={true}/></div>}<div style={{width:workspace?420:520,minWidth:0,height:'100%',display:'flex',flexDirection:'column'}}><IdeChatPanel hostId={host} terminal={terminal} hostName={host==='host-a'?'Fixture A':'Fixture B'} active={active} request={request} attachment={attachment} onAttachmentConsumed={()=>setAttachment(undefined)} onShowTerminal={()=>window.terminalActions.push('show')} onFocusTerminal={id=>window.terminalActions.push(id)}/></div></div>}
createRoot(document.getElementById('root')).render(<Fixture/>);
`,
    );
    await writeFile(
      join(directory, "index.html"),
      '<html><body style="margin:0"><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>',
    );
    let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    const fixtureApp = express(),
      server = createServer(fixtureApp);
    try {
      await build({
        configFile: false,
        root: directory,
        cacheDir: join(directory, "vite"),
        plugins: [react()],
        logLevel: "error",
        resolve: { alias: { "/src": resolve("src") } },
        build: { outDir: join(directory, "compiled"), minify: false },
      });
      fixtureApp.use(express.static(join(directory, "compiled")));
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const address = `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
        main = join(directory, "electron.cjs");
      await writeFile(
        main,
        `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:780,height:820,webPreferences:{backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadURL(${JSON.stringify(address)});});app.on('window-all-closed',()=>app.quit());`,
      );
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([, value]) => value !== undefined),
      ) as Record<string, string>;
      delete env.ELECTRON_RUN_AS_NODE;
      app = await _electron.launch({ args: [main], env });
      const page = await app.firstWindow();
      page.setDefaultTimeout(15000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const input = page.getByRole("textbox", { name: "AI에게 보낼 메시지" }),
        send = page.getByRole("button", { name: "AI 메시지 전송" }),
        provider = page.getByRole("combobox", { name: "AI 제공자" });
      const posts = () =>
        page.evaluate(() =>
          (window as any).calls.filter((call: any) => call.body),
        );
      const messages = () =>
        page.evaluate(() =>
          (window as any).calls.filter((call: any) =>
            call.path.endsWith("/messages"),
          ),
        );
      const host = async (id: string) => {
        await page.evaluate((value) => (window as any).setHost(value), id);
        await page
          .getByText(id === "host-a" ? "Fixture A" : "Fixture B", {
            exact: true,
          })
          .waitFor();
      };
      await input.waitFor();
      assert.equal(
        (await posts()).length,
        0,
        "opening the panel must not create an AI process",
      );
      assert.equal(
        await page.getByText("같은 CLI 입력에 추가해 전송").count(),
        0,
      );
      await input.fill("Codex draft A");
      await provider.selectOption("claude");
      assert.equal(await input.inputValue(), "");
      await input.fill("Claude draft A");
      await provider.selectOption("codex");
      assert.equal(await input.inputValue(), "Codex draft A");
      await host("host-b");
      assert.equal(await input.inputValue(), "");
      await input.fill("Host B draft");
      await host("host-a");
      assert.equal(await input.inputValue(), "Codex draft A");
      await send.click();
      await page
        .getByRole("heading", { name: "직접 대화 응답", exact: true })
        .waitFor();
      assert.equal(await input.inputValue(), "");
      const first = await posts();
      assert.equal(first[0].path, "/conversations");
      assert.deepEqual(
        Object.keys(first[0].body).sort(),
        ["hostId", "provider", "requestId"].sort(),
      );
      assert.equal(first[0].body.hostId, "host-a");
      assert.equal(first[0].body.provider, "codex");
      assert.equal(first[1].path, "/conversations/created-1/messages");
      assert.deepEqual(
        Object.keys(first[1].body).sort(),
        ["runtimeId", "requestId", "text"].sort(),
      );
      assert.equal(first[1].body.text, "Codex draft A");
      assert.equal(
        await page.locator(".ide-chat-message.assistant table").count(),
        1,
      );
      assert.match(
        await page.locator(".ide-chat-message.assistant pre").innerText(),
        /const answer = 42/,
      );
      await page.locator(".ide-chat-tool summary").click();
      assert.match(
        await page.locator(".ide-chat-tool pre").innerText(),
        /synthetic tool output/,
      );

      await provider.selectOption("claude");
      assert.equal(await input.inputValue(), "Claude draft A");
      await page
        .getByRole("button", { name: "대화 기록", exact: true })
        .click();
      await page
        .getByRole("button", { name: /Saved claude conversation/ })
        .waitFor();
      await page.getByRole("button", { name: "기록 더 보기" }).click();
      await page.getByRole("button", { name: /Older history/ }).waitFor();
      await page.getByRole("textbox", { name: "대화 기록 검색" }).fill("Saved");
      await page.waitForFunction(() =>
        (window as any).calls.some((call: any) =>
          call.path.includes("query=Saved"),
        ),
      );
      await page
        .getByRole("button", { name: /Saved claude conversation/ })
        .click();
      await page
        .getByRole("heading", {
          name: "Answer resumed-host-a-claude-history-thread",
          exact: true,
        })
        .waitFor();
      const resumed = (await posts()).find((call: any) => call.body.resumeId);
      assert.equal(resumed.body.provider, "claude");
      assert.equal(resumed.body.resumeId, "history-thread");
      await page.getByRole("button", { name: "이전 메시지 더 보기" }).click();
      await page.getByText("더 오래된 질문", { exact: true }).waitFor();
      assert.equal(
        await page
          .getByRole("heading", {
            name: "Answer resumed-host-a-claude-history-thread",
            exact: true,
          })
          .count(),
        1,
      );

      await page.evaluate(() => {
        const value = (window as any).snapshots[
          "resumed-host-a-claude-history-thread"
        ];
        value.status = "waiting";
        value.approvals = [
          {
            id: "approval-1",
            kind: "question",
            title: "작업 방향",
            detail: "선택해 주세요",
            questions: [
              {
                id: "q",
                question: "어떤 범위인가요?",
                options: [{ label: "작은 변경" }, { label: "전체 변경" }],
              },
            ],
          },
        ];
        value.revision++;
      });
      await page
        .getByRole("button", { name: "작은 변경", exact: true })
        .click();
      await page
        .getByRole("button", { name: "답변 보내기", exact: true })
        .click();
      await page.waitForFunction(() =>
        (window as any).calls.some((call: any) =>
          call.path.endsWith("/approvals/approval-1"),
        ),
      );
      assert.deepEqual(
        (await posts()).find((call: any) =>
          call.path.endsWith("/approvals/approval-1"),
        ).body,
        { runtimeId: "runtime-fixture", answers: { q: "작은 변경" } },
      );
      await page.evaluate(() => {
        const value = (window as any).snapshots[
          "resumed-host-a-claude-history-thread"
        ];
        value.status = "running";
        value.revision++;
      });
      await page.getByRole("button", { name: "AI 작업 중단" }).click();
      await send.waitFor();
      assert.ok(
        (await posts()).some((call: any) => call.path.endsWith("/interrupt")),
      );

      await input.fill("uncertain draft");
      await page.evaluate(() => {
        (window as any).nextStatus = "uncertain";
      });
      await send.click();
      await page
        .getByRole("status")
        .filter({ hasText: "전송 확인이 지연" })
        .waitFor();
      assert.equal(await input.inputValue(), "uncertain draft");
      await send.click();
      await page.waitForFunction(
        () =>
          (window as any).calls.filter((call: any) =>
            call.path.endsWith("/messages"),
          ).length === 3,
      );
      const attempts = await messages();
      assert.deepEqual(
        attempts[1].body,
        attempts[2].body,
        "uncertain retry uses the identical idempotency key and input",
      );
      await page.evaluate(() => {
        (window as any).nextStatus = "submitted";
        (window as any).deferSend = true;
      });
      await input.fill("delayed Claude question");
      await send.click();
      await page.waitForFunction(
        () => typeof (window as any).resolveSend === "function",
      );
      await host("host-b");
      await input.fill("untouched Claude B");
      await page.evaluate(() => (window as any).resolveSend());
      assert.equal(await input.inputValue(), "untouched Claude B");
      await host("host-a");
      await page.waitForFunction(
        () =>
          (
            document.querySelector(
              ".ide-chat-compose textarea",
            ) as HTMLTextAreaElement
          ).value === "",
      );

      await page.getByRole("button", { name: "새 대화", exact: true }).click();
      assert.equal(await input.inputValue(), "");
      const beforeAttachment = (await posts()).length;
      await page.evaluate(() =>
        (window as any).setAttachment({
          id: "selection-1",
          selection: {
            terminalId: "editor-only",
            hostId: "host-a",
            path: "/fixture/example.ts",
            root: "/fixture",
            text: "const original = 42;",
            startLine: 2,
            endLine: 3,
            startColumn: 1,
            endColumn: 20,
            unsaved: true,
          },
        }),
      );
      await page.locator(".ide-chat-attachment").waitFor();
      assert.equal(
        (await posts()).length,
        beforeAttachment,
        "quoting only attaches context; it never submits",
      );
      assert.equal(await input.inputValue(), "");
      await input.fill("이 부분을 설명해 줘");
      await send.click();
      await page.locator(".ide-chat-quoted summary").waitFor();
      assert.equal(
        await page.locator(".ide-chat-quoted").getAttribute("open"),
        null,
      );
      assert.equal(
        await page.locator(".ide-chat-message.user .markdown").innerText(),
        "이 부분을 설명해 줘",
      );
      const selectedMessage = (await messages()).at(-1);
      assert.match(selectedMessage.body.text, /const original = 42;/);
      assert.match(
        selectedMessage.body.text,
        /"path": "\/fixture\/example.ts"/,
      );
      assert.ok(
        !(await page.evaluate(() => (window as any).calls)).some((call: any) =>
          /terminal|paste|input/.test(call.path),
        ),
        "managed chat must never fall back to PTY input",
      );
      await mkdir(resolve("artifacts"), { recursive: true });
      await page.screenshot({
        path: resolve("artifacts/ide-chat-fixture.png"),
      });
      await page.setViewportSize({ width: 1360, height: 860 });
      await page.evaluate(() => (window as any).showWorkspace());
      await page
        .getByRole("button", { name: "example.ts", exact: true })
        .click();
      await page
        .locator(".monaco-editor textarea")
        .waitFor({ state: "attached" });
      await page.screenshot({
        path: resolve("artifacts/ide-chat-workspace-fixture.png"),
      });
      // A selected, already-running native AI is rendered in-place on first IDE use.
      await page.evaluate(() => {
        const fixture = window as any;
        fixture.setHost("live-host");
        fixture.liveSources["live-codex"] = {
          terminalId: "running-codex",
          canSend: true,
          canInterrupt: false,
          transport: "codex-native",
        };
        fixture.setTerminal({
          id: "running-codex",
          hostId: "live-host",
          title: "Running Codex",
          agentKind: "codex",
          agentSessionId: "live-codex",
          agentState: "idle",
          connectionState: "connected",
          exited: false,
        });
      });
      await page
        .getByRole("heading", {
          name: "Answer resumed-live-host-codex-live-codex",
          exact: true,
        })
        .waitFor();
      await page.getByText("열린 터미널과 연결됨", { exact: true }).waitFor();
      assert.equal(await provider.inputValue(), "codex");
      assert.equal((await posts()).at(-1).body.resumeId, "live-codex");
      await page.evaluate(() => {
        const fixture = window as any;
        fixture.snapshots["resumed-live-host-codex-live-codex"].status =
          "running";
        fixture.snapshots["resumed-live-host-codex-live-codex"].revision++;
        fixture.nextStatus = "queued";
      });
      await page.getByText("Codex가 작업 중입니다.", { exact: true }).waitFor();
      await input.fill("작업 중인 같은 Codex에 질문합니다.");
      await send.click();
      await page
        .getByText("열린 대화에 전달했습니다. AI가 순서대로 처리합니다.", {
          exact: true,
        })
        .waitFor();
      assert.equal(await input.inputValue(), "");
      const liveSend = (await messages()).at(-1);
      assert.equal(
        liveSend.path,
        "/conversations/resumed-live-host-codex-live-codex/messages",
      );
      assert.equal(liveSend.headers["x-harbor-terminal"], "running-codex");
      assert.equal(
        await page.getByRole("button", { name: "AI 작업 중단" }).count(),
        0,
      );
      await page
        .getByRole("button", { name: "터미널 보기", exact: true })
        .click();
      assert.deepEqual(
        await page.evaluate(() => (window as any).terminalActions),
        ["show", "running-codex"],
      );

      // Explicitly choosing New must survive hiding/reopening the same IDE.
      await page.getByRole("button", { name: "새 대화", exact: true }).click();
      await page.getByText("Codex와 새 대화", { exact: true }).waitFor();
      const beforeReopen = (await posts()).length;
      await page.evaluate(() => (window as any).setActive(false));
      await page.evaluate(() => (window as any).setActive(true));
      await input.fill("새 대화 초안 유지");
      assert.equal((await posts()).length, beforeReopen);
      await page
        .getByRole("button", { name: "현재 터미널 대화", exact: true })
        .click();
      await page
        .getByRole("heading", {
          name: "Answer resumed-live-host-codex-live-codex",
          exact: true,
        })
        .waitFor();

      // Claude without its optional live channel still renders; it does not ask for restart.
      await page.evaluate(() => {
        const fixture = window as any;
        fixture.liveSources["live-claude"] = {
          terminalId: "running-claude",
          canSend: false,
          canInterrupt: false,
          transport: "unavailable",
          reason: "이 대화의 입력은 열린 터미널에서 계속할 수 있습니다.",
        };
        fixture.setTerminal({
          id: "running-claude",
          hostId: "live-host",
          title: "Running Claude",
          agentKind: "claude",
          agentSessionId: "live-claude",
          connectionState: "connected",
          exited: false,
        });
      });
      await page
        .getByRole("button", { name: "현재 터미널 대화", exact: true })
        .click();
      await page
        .getByRole("heading", {
          name: "Answer resumed-live-host-claude-live-claude",
          exact: true,
        })
        .waitFor();
      assert.equal(await input.isDisabled(), true);
      await page
        .getByRole("button", { name: "터미널에서 입력", exact: true })
        .click();
      assert.deepEqual(
        (await page.evaluate(() => (window as any).terminalActions)).slice(-2),
        ["show", "running-claude"],
      );
      assert.equal(await page.getByText(/종료한 뒤|닫고|다시 실행/).count(), 0);
      assert.ok(
        (await posts())
          .filter((call: any) => call.body.hostId === "live-host")
          .every((call: any) => !!call.body.resumeId),
        "attaching never creates a second native writer",
      );
      assert.ok(
        !(await page.evaluate(() => (window as any).calls)).some((call: any) =>
          /\/terminals\/.+\/(?:input|close|resize)/.test(call.path),
        ),
        "rendering live conversations never pastes into or closes a terminal",
      );
      await page.screenshot({
        path: resolve("artifacts/ide-chat-live-fixture.png"),
      });
      // A delayed automatic attachment cannot hide text typed while it loads.
      await page.evaluate(() => {
        const fixture = window as any;
        fixture.releaseResume = undefined;
        fixture.deferResumeId = "live-slow";
        fixture.liveSources["live-slow"] = {
          terminalId: "slow-terminal",
          canSend: true,
          canInterrupt: false,
          transport: "codex-native",
        };
        fixture.setHost("slow-host");
        fixture.setTerminal({
          id: "slow-terminal",
          hostId: "slow-host",
          title: "Slow session",
          agentKind: "codex",
          agentSessionId: "live-slow",
          connectionState: "connected",
          exited: false,
        });
      });
      await page.waitForFunction(
        () => typeof (window as any).releaseResume === "function",
      );
      await input.fill("연결을 기다리는 동안 쓴 초안");
      await page.evaluate(() => (window as any).releaseResume());
      await page
        .getByRole("button", { name: "현재 터미널 대화", exact: true })
        .waitFor();
      assert.equal(await input.inputValue(), "연결을 기다리는 동안 쓴 초안");
      assert.equal(await page.locator(".ide-chat-live").count(), 0);

      // Fast selection changes attach only the newest terminal after an older read settles.
      await page.evaluate(() => {
        const fixture = window as any;
        fixture.releaseResume = undefined;
        fixture.deferResumeId = "live-first";
        fixture.liveSources["live-first"] = {
          terminalId: "first-terminal",
          canSend: true,
          canInterrupt: false,
          transport: "codex-native",
        };
        fixture.liveSources["live-second"] = {
          terminalId: "second-terminal",
          canSend: true,
          canInterrupt: false,
          transport: "codex-native",
        };
        fixture.setHost("fast-host");
        fixture.setTerminal({
          id: "first-terminal",
          hostId: "fast-host",
          title: "First session",
          agentKind: "codex",
          agentSessionId: "live-first",
          connectionState: "connected",
          exited: false,
        });
      });
      await page.waitForFunction(
        () => typeof (window as any).releaseResume === "function",
      );
      await page.evaluate(() =>
        (window as any).setTerminal({
          id: "second-terminal",
          hostId: "fast-host",
          title: "Second session",
          agentKind: "codex",
          agentSessionId: "live-second",
          connectionState: "connected",
          exited: false,
        }),
      );
      await page.evaluate(() => (window as any).releaseResume());
      await page
        .getByRole("heading", {
          name: "Answer resumed-fast-host-codex-live-second",
          exact: true,
        })
        .waitFor();
      assert.equal(
        await page
          .getByRole("heading", {
            name: "Answer resumed-fast-host-codex-live-first",
            exact: true,
          })
          .count(),
        0,
      );
      assert.deepEqual(errors, []);
    } catch (error) {
      if (app) {
        const page = await app.firstWindow();
        console.error(
          await page.evaluate(() => ({
            text: document.body.innerText,
            calls: (window as any).calls.slice(-12),
            snapshots: (window as any).snapshots,
          })),
        );
      }
      throw error;
    } finally {
      await app
        ?.evaluate(({ BrowserWindow }) => {
          for (const window of BrowserWindow.getAllWindows()) window.destroy();
        })
        .catch(() => {});
      await app?.close();
      if (server.listening)
        await new Promise<void>((done) => server.close(() => done()));
      const rel = relative(root, directory);
      if (!rel || rel.startsWith(".."))
        throw new Error("Unsafe fixture directory");
      await rm(directory, { recursive: true, force: true });
    }
  },
);
