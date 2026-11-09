import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import { build } from "esbuild";
import { _electron } from "playwright";

test(
  "one terminal surface retains native live output, folds original work and preserves cross-turn selection and session identity",
  { skip: process.platform !== "win32", timeout: 90000 },
  async () => {
    const root = resolve(".cache/terminal-conversation-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    await build({
      stdin: {
        contents: `
import React,{useEffect,useState}from'react';import{createRoot}from'react-dom/client';
import{Terminal}from'@xterm/xterm';import'@xterm/xterm/css/xterm.css';
import{TerminalConversation}from'./src/client/TerminalConversation';import{richSelectedText}from'./src/client/TerminalRich';
import'./src/client/styles.css';import'./src/client/themes.css';import'./src/client/history.css';
Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});
const nativeTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>nativeTimeout(fn,ms===5000?120:ms,...args);
window.requests=[];window.stage=0;window.nativeMounts=0;window.nativeWrites=[];window.copies=[];
window.readRichSelection=()=>richSelectedText(document.getElementById('native-mount'));
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
const message=(id,kind,text,turnId,extra={})=>({id,kind,text,turnId,...extra});
window.fetch=async(input,options={})=>{const url=new URL(String(input),location.href),sessionId=url.pathname.split('/').at(-1);window.requests.push({url:url.href,method:options.method,stage:window.stage});
if(!url.pathname.startsWith('/api/hosts/fixture/history/'))throw Error('Unexpected non-history operation '+url.pathname);
const first=[message('q1','user','QUESTION ONE','one'),message('thought1','assistant','INTERMEDIATE THOUGHT ONE','one',{phase:'commentary',turnStatus:'completed'}),message('tool1','command','SECRET TOOL ONE','one',{turnStatus:'completed'}),message('a1','assistant','ANSWER ONE middle message','one',{phase:'final_answer',turnStatus:'completed'})];
const second=[message('q2','user','QUESTION TWO','two'),message('tool2','change','SECRET TOOL TWO','two',{turnStatus:window.stage?'completed':'inProgress'}),message('a2','assistant',window.stage===0?'PARTIAL ANSWER TWO':window.stage===2?'UPDATED FINAL ANSWER TWO':'FINAL ANSWER TWO','two',{phase:'final_answer',turnStatus:window.stage?'completed':'inProgress'})];
const legacy=[message('legacy-q','user','LEGACY QUESTION'),message('legacy-tool','command','LEGACY WORK STILL SELECTED'),message('legacy-a','assistant','LEGACY FINAL',undefined,{turnStatus:'unknown'})];
const timeline=window.stage===5?[message('wrong','user','WRONG SESSION RESPONSE')]:sessionId==='next'?[message('next-q','user','NEXT SESSION ONLY')]:sessionId==='legacy'?legacy.map(item=>({...item,turnId:undefined})):[...first,...second];
const payload={thread:{id:window.stage===5?'unrelated':sessionId,hostId:'fixture',title:'Synthetic task',cwd:'/fixture'},items:timeline.filter(item=>item.kind==='user'||item.kind==='assistant'),timeline,nextCursor:null};
if(window.holdNext){window.holdNext=false;return new Promise(resolve=>{window.releaseHeldHistory=()=>resolve(response(payload));});}return response(payload);};
function Fixture(){const[term,setTerm]=useState(null),[mode,setMode]=useState('auto'),[blocks,setBlocks]=useState([]),[info,setInfo]=useState({id:'same-pty',hostId:'fixture',cwd:'/fixture',title:'Synthetic task',exited:false,agentKind:'codex',agentSessionId:'native',agentState:'working'});
window.setReaderMode=setMode;window.advanceHistory=(stage,agentState='idle')=>{window.stage=stage;window.seedNative(stage);setInfo(previous=>({...previous,agentState}));setBlocks(stage===4?[{id:'proof',requestId:'proof',sessionId:'legacy',text:'LEGACY FINAL',columns:80,viewportRows:24,createdAt:1,state:'ready',marker:''}]:[]);};
window.unknownAgent=()=>setInfo(previous=>({...previous,agentState:undefined}));
window.useLegacy=()=>{window.stage=3;window.seedNative(3);setMode('conversation');setBlocks([]);setInfo(previous=>({...previous,agentSessionId:'legacy',agentKind:'claude',agentState:'idle'}));};
window.useNext=()=>{window.stage=7;window.seedNative(7);setMode('conversation');setBlocks([]);setInfo(previous=>({...previous,agentSessionId:'next',agentKind:'claude',agentState:'idle'}));};
window.completeLegacy=async(sessionId='legacy',text='LEGACY FINAL')=>{const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));const textHash=Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');setInfo(previous=>({...previous,agentCompletion:{sessionId,textHash}}));};
useEffect(()=>{window.nativeMounts++;const native=new Terminal({cols:100,rows:35,fontSize:14,convertEol:true});native.open(document.getElementById('native-terminal'));const write=native.write.bind(native);window.seedNative=stage=>write('\\x1b[2J\\x1b[H'+(stage<3?'› QUESTION TWO\\r\\nLIVE NATIVE WORK OUTPUT\\r\\n'+(stage===0?'PARTIAL ANSWER TWO':stage===2?'UPDATED FINAL ANSWER TWO':'FINAL ANSWER TWO')+'\\r\\n':'')+'❯ UNSENT DRAFT');window.seedNative(0);window.fixtureTerm=native;native.write=data=>window.nativeWrites.push(data);setTerm(native);const copy=event=>{if(event.ctrlKey&&event.key.toLowerCase()==='c'){const text=richSelectedText(document.getElementById('native-mount'));if(text){event.preventDefault();window.copies.push(text);}}};document.addEventListener('keydown',copy);return()=>{document.removeEventListener('keydown',copy);native.dispose();};},[]);
return <><div id="native-mount" style={{position:'relative',width:980,height:720,border:'1px solid gray'}}><div id="native-terminal" style={{height:'100%'}}/></div>{term&&<TerminalConversation term={term} info={info} mode={mode} blocks={blocks} onClose={()=>setMode('terminal')}/>}</>;}
createRoot(document.getElementById('root')).render(<Fixture/>);`,
        resolveDir: process.cwd(),
        sourcefile: "terminal-conversation-fixture.tsx",
        loader: "tsx",
      },
      bundle: true,
      outfile: join(directory, "fixture.js"),
      format: "esm",
      logLevel: "silent",
      loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
    });
    const app = express();
    app.use(express.static(directory));
    app.get("/", (_req, res) =>
      res
        .type("html")
        .send(
          '<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
        ),
    );
    const server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const main = join(directory, "electron.cjs");
    await writeFile(
      main,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.commandLine.appendSwitch('disable-gpu');app.whenReady().then(()=>{new BrowserWindow({show:false,width:1050,height:850,webPreferences:{backgroundThrottling:false,contextIsolation:true,sandbox:true}}).loadURL('http://127.0.0.1:${(server.address() as { port: number }).port}/');});app.on('window-all-closed',()=>app.quit());`,
    );
    let desktop: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      delete env.ELECTRON_RUN_AS_NODE;
      desktop = await _electron.launch({ args: [main], env });
      const page = await desktop.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.waitForFunction(() => (window as any).requests?.length > 0);
      assert.equal(
        await page.locator(".terminal-conversation").isVisible(),
        true,
      );
      await page
        .locator(".terminal-native-flow")
        .getByText("LIVE NATIVE WORK OUTPUT", { exact: true })
        .waitFor();
      assert.equal(
        await page.locator(".terminal-conversation > header").count(),
        0,
      );
      assert.equal(
        await page
          .locator(".terminal-conversation")
          .getByText("입력은 아래 터미널에서 계속하세요.", { exact: false })
          .count(),
        0,
      );
      await page.evaluate(() => (window as any).advanceHistory(0, "idle"));
      await page.waitForTimeout(260);
      assert.equal(
        await page.locator(".terminal-conversation").isVisible(),
        true,
        "native state changes must not switch to a separate conversation screen",
      );
      assert.equal(
        await page.locator('[data-turn-id="two"] .conversation-work').count(),
        0,
        "an idle process and final_answer phase alone must not mark an in-progress turn complete",
      );
      const secondWork = page.locator('[data-work-item="tool2"]');
      assert.equal(
        await secondWork.count(),
        1,
        "Individual original work can be expanded independently of completion",
      );
      await secondWork.locator("summary").click();
      assert.equal(await secondWork.locator("pre").isVisible(), true);
      await secondWork.locator("summary").click();
      // Only state/API events change here: no scrolling or mouse movement to trigger rendering.
      await page.evaluate(() => (window as any).advanceHistory(1));
      await page
        .locator(".terminal-conversation")
        .waitFor({ state: "visible" });
      await page
        .locator(".terminal-conversation")
        .getByText("FINAL ANSWER TWO", { exact: true })
        .waitFor();
      await page.evaluate(() => (window as any).unknownAgent());
      assert.equal(
        await page.locator(".terminal-conversation").isVisible(),
        true,
        "Unknown agent state does not hide the unified output",
      );
      await page.evaluate(() => {
        (window as any).advanceHistory(1);
        (window as any).setReaderMode("auto");
      });
      assert.equal(await page.locator(".conversation-work").count(), 2);
      assert.equal(await page.locator(".conversation-work[open]").count(), 0);
      assert.equal(await secondWork.locator("pre").isVisible(), false);
      await page
        .locator('[data-turn-id="two"] > .conversation-work > summary')
        .click();
      await secondWork.locator("summary").click();
      assert.equal(await secondWork.locator("pre").isVisible(), true);
      await page
        .locator('[data-turn-id="two"] > .conversation-work > summary')
        .click();
      await page.screenshot({ path: join(root, "completed-reader.png") });
      await page.evaluate(() => {
        const start = document.querySelector(
          '[data-rich-block="conversation-user-q1"] .conversation-question',
        )!.firstChild!;
        const end = document.querySelector(
          '[data-rich-block="conversation-assistant-a2"] .markdown p',
        )!.firstChild!;
        const range = document.createRange();
        range.setStart(start, 0);
        range.setEnd(end, end.textContent!.length);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        (window as any).selectedAnswerNode = end;
      });
      await page.keyboard.press("Control+c");
      const copied = await page.evaluate(() => (window as any).copies.at(-1));
      assert.ok(
        copied.includes("QUESTION ONE") &&
          copied.includes("ANSWER ONE middle message") &&
          copied.includes("QUESTION TWO") &&
          copied.includes("FINAL ANSWER TWO"),
      );
      assert.ok(
        !copied.includes("SECRET TOOL") &&
          !copied.includes("INTERMEDIATE THOUGHT"),
      );
      const before = await page.evaluate(() =>
        (window as any).readRichSelection(),
      );
      await page.evaluate(() => (window as any).advanceHistory(2));
      await page.waitForFunction(() =>
        (window as any).requests.some((request: any) => request.stage === 2),
      );
      await page.waitForTimeout(200);
      assert.equal(
        await page
          .locator(".terminal-conversation")
          .getByText("UPDATED FINAL ANSWER TWO", { exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page.evaluate(() => (window as any).readRichSelection()),
        before,
      );
      assert.equal(await page.locator(".conversation-work[open]").count(), 0);
      assert.equal(
        await page.locator('[data-work-item="tool1"] pre').isVisible(),
        false,
      );
      assert.equal(
        await page.evaluate(
          () =>
            document.querySelector(
              '[data-rich-block="conversation-assistant-a2"] .markdown p',
            )!.firstChild === (window as any).selectedAnswerNode,
        ),
        true,
      );
      await page.evaluate(() => window.getSelection()!.removeAllRanges());
      await page
        .locator(".terminal-conversation")
        .getByText("UPDATED FINAL ANSWER TWO", { exact: true })
        .waitFor();
      // Rich completion notifications must not restructure selected legacy content either.
      await page.evaluate(() => (window as any).useLegacy());
      const legacyWork = page.locator('[data-work-item="legacy-tool"]');
      await legacyWork.locator("summary").waitFor();
      assert.equal(
        await legacyWork.locator("pre").isVisible(),
        false,
        "Historic unknown-state work still offers manual expand/collapse",
      );
      await legacyWork.locator("summary").click();
      await legacyWork.locator("pre").waitFor();
      await page.evaluate(() => {
        const start = document.querySelector(
          '[data-rich-block="conversation-user-legacy-q"] .conversation-question',
        )!.firstChild!;
        const end = document.querySelector(
          '[data-rich-block="conversation-assistant-legacy-a"] .markdown p',
        )!.firstChild!;
        const range = document.createRange();
        range.setStart(start, 0);
        range.setEnd(end, end.textContent!.length);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        (window as any).selectedLegacyNode = end;
      });
      await page.evaluate(() => (window as any).advanceHistory(4));
      await page.waitForFunction(() =>
        (window as any).requests.some((request: any) => request.stage === 4),
      );
      await page.waitForTimeout(150);
      assert.equal(
        await legacyWork.locator("pre").isVisible(),
        true,
        "new completion blocks must not collapse selected DOM",
      );
      assert.equal(
        await page.evaluate(
          () =>
            document.querySelector(
              '[data-rich-block="conversation-assistant-legacy-a"] .markdown p',
            )!.firstChild === (window as any).selectedLegacyNode,
        ),
        true,
      );
      await page.evaluate(() => window.getSelection()!.removeAllRanges());
      await page.waitForTimeout(150);
      assert.equal(
        await page.locator(".conversation-work").count(),
        0,
        "a rich block alone is not a whole-turn completion proof",
      );
      await page.evaluate(() =>
        (window as any).completeLegacy("different-session"),
      );
      await page.waitForTimeout(200);
      assert.equal(
        await page.locator(".conversation-work").count(),
        0,
        "completion from a different native conversation must be ignored",
      );
      await page.evaluate(() =>
        (window as any).completeLegacy("legacy", "different answer"),
      );
      await page.waitForTimeout(200);
      assert.equal(
        await page.locator(".conversation-work").count(),
        0,
        "the Stop hook must identify the actual last answer",
      );
      await page.evaluate(() => {
        const start = document.querySelector(
          '[data-rich-block="conversation-user-legacy-q"] .conversation-question',
        )!.firstChild!;
        const end = document.querySelector(
          '[data-rich-block="conversation-assistant-legacy-a"] .markdown p',
        )!.firstChild!;
        const range = document.createRange();
        range.setStart(start, 0);
        range.setEnd(end, end.textContent!.length);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        (window as any).selectedLegacyNode = end;
      });
      await page.evaluate(() => (window as any).completeLegacy());
      await page.waitForTimeout(250);
      assert.equal(
        await legacyWork.locator("pre").isVisible(),
        true,
        "a verified Stop event must wait to fold while its turn is selected",
      );
      assert.equal(
        await page.evaluate(
          () =>
            document.querySelector(
              '[data-rich-block="conversation-assistant-legacy-a"] .markdown p',
            )!.firstChild === (window as any).selectedLegacyNode,
        ),
        true,
      );
      await page.evaluate(() => window.getSelection()!.removeAllRanges());
      await page.waitForFunction(
        () => !!document.querySelector(".conversation-work:not([open])"),
      );
      assert.equal(
        await page.locator(".terminal-conversation").isVisible(),
        true,
      );
      await page.evaluate(() => (window as any).advanceHistory(5));
      await page.waitForFunction(() =>
        (window as any).requests.some((request: any) => request.stage === 5),
      );
      await page.waitForTimeout(150);
      assert.equal(
        await page
          .locator(".terminal-conversation")
          .getByText("WRONG SESSION RESPONSE", { exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page
          .locator(".terminal-conversation")
          .getByText("LEGACY FINAL", { exact: true })
          .count(),
        1,
      );
      await page.evaluate(() => {
        (window as any).holdNext = true;
        (window as any).advanceHistory(6);
      });
      await page.waitForFunction(
        () => typeof (window as any).releaseHeldHistory === "function",
      );
      await page.evaluate(() => (window as any).useNext());
      await page
        .locator(".terminal-conversation")
        .getByText("NEXT SESSION ONLY", { exact: true })
        .waitFor();
      await page.evaluate(() => (window as any).releaseHeldHistory());
      await page.waitForTimeout(200);
      assert.equal(
        await page
          .locator(".terminal-conversation")
          .getByText("NEXT SESSION ONLY", { exact: true })
          .count(),
        1,
      );
      assert.equal(
        await page
          .locator(".terminal-conversation")
          .getByText("LEGACY FINAL", { exact: true })
          .count(),
        0,
        "late aborted history response must not leak the previous conversation",
      );
      assert.equal(
        await page
          .getByRole("button", { name: "현재 대화 기록 닫기", exact: true })
          .count(),
        0,
      );
      await page.evaluate(() => (window as any).setReaderMode("terminal"));
      await page.locator(".terminal-conversation").waitFor({ state: "hidden" });
      assert.equal(
        await page.evaluate(() =>
          (window as any).fixtureTerm.buffer.active
            .getLine(0)
            ?.translateToString(true),
        ),
        "❯ UNSENT DRAFT",
      );
      assert.equal(await page.evaluate(() => (window as any).nativeMounts), 1);
      assert.deepEqual(
        await page.evaluate(() => (window as any).nativeWrites),
        [],
      );
      assert.equal(
        await page.evaluate(() =>
          (window as any).requests.every(
            (request: any) =>
              request.method === "GET" &&
              new URL(request.url).searchParams.get("includeActivity") === "1",
          ),
        ),
        true,
      );
      assert.deepEqual(errors, []);
    } finally {
      await desktop?.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      assert.ok(resolve(directory).startsWith(root + sep));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
