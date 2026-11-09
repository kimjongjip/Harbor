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
  "held drag crosses older pages and a partial turn without losing selection or applying queued live edits",
  { skip: process.platform !== "win32", timeout: 90000 },
  async () => {
    const root = resolve(".cache/conversation-pagination-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    await build({
      stdin: {
        contents: `
import React,{useState,useEffect}from'react';import{createRoot}from'react-dom/client';import{TerminalConversation}from'./src/client/TerminalConversation';import{richSelectedText}from'./src/client/TerminalRich';
import{Terminal}from'@xterm/xterm';import'@xterm/xterm/css/xterm.css';
import{captureConversationSelection,restoreConversationSelection}from'./src/client/conversation-selection-snapshot';window.captureSelection=captureConversationSelection;window.restoreSelection=restoreConversationSelection;
import'./src/client/styles.css';import'./src/client/themes.css';import'./src/client/history.css';
Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});
window.requests=[];window.revision=1;window.readSelection=()=>richSelectedText(document.getElementById('mount'));
// These are completed historical replies. An idle CLI alone is intentionally
// insufficient to project an unknown latest turn into the finished transcript.
const message=(number,kind)=>({id:(kind==='user'?'q':'a')+number,kind,text:(kind==='user'?'QUESTION ':'ANSWER ')+number+' '+('Readable conversation content. ').repeat(4),...(kind==='assistant'?{phase:'final_answer',turnStatus:'completed'}:{})});
const pairs=(first,last)=>Array.from({length:last-first+1},(_,index)=>[message(first+index,'user'),message(first+index,'assistant')]).flat();
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
window.fetch=async(input,options={})=>{const url=new URL(String(input),location.href),cursor=url.searchParams.get('cursor'),sessionId=url.pathname.split('/').at(-1);window.requests.push({cursor,sessionId,revision:window.revision,method:options.method});let items=[],nextCursor=null;
if(sessionId==='cycle'){items=cursor?[]:pairs(1,2);nextCursor=!cursor?'cycle-A':cursor==='cycle-A'?'cycle-B':'cycle-A';}
else if(!cursor){items=[message(5,'assistant'),...pairs(6,30)];if(window.revision===2)items=items.map(item=>item.id==='a30'?{...item,text:'UPDATED LAST ANSWER'}:item);nextCursor='older';}
else if(cursor==='older'){items=[...pairs(1,4),message(5,'user'),{...message(30,'assistant'),text:'STALE DUPLICATE'}];nextCursor='empty';}
else if(cursor==='empty'){nextCursor='earliest';}
else if(cursor==='earliest'){items=[message(0,'user'),message(0,'assistant')];}
const payload={thread:{id:sessionId,hostId:'fixture',title:'Long synthetic conversation',cwd:'/fixture'},items,activity:[],timelineIds:items.map(item=>item.kind+':'+item.id),nextCursor};
if(cursor==='older')return new Promise(resolve=>{window.releaseOlder=()=>resolve(response(payload));});return response(payload);};
function Fixture(){const[term,setTerm]=useState(null),[blocks,setBlocks]=useState([]),[session,setSession]=useState('long');window.queueRefresh=()=>{window.revision=2;setBlocks([])};window.useCycle=()=>setSession('cycle');useEffect(()=>{const native=new Terminal({cols:95,rows:32,fontSize:14,convertEol:true});native.open(document.getElementById('native'));native.write('❯ NATIVE PROMPT REMAINS',()=>setTerm(native));return()=>native.dispose();},[]);return <><div id="mount" style={{position:'relative',width:850,height:650}}><div id="native" style={{height:'100%'}}/></div>{term&&<TerminalConversation term={term} info={{id:'fixture',hostId:'fixture',cwd:'/fixture',title:'Fixture',exited:false,agentKind:'claude',agentSessionId:session,agentState:'idle'}} blocks={blocks} mode="conversation" onClose={()=>{}}/>}</>};createRoot(document.getElementById('root')).render(<Fixture/>);`,
        resolveDir: process.cwd(),
        sourcefile: "conversation-pagination-fixture.tsx",
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
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.commandLine.appendSwitch('disable-gpu');app.whenReady().then(()=>{new BrowserWindow({show:false,width:950,height:800,webPreferences:{backgroundThrottling:false,contextIsolation:true,sandbox:true}}).loadURL('http://127.0.0.1:${(server.address() as { port: number }).port}/');});app.on('window-all-closed',()=>app.quit());`,
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
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      const answer = page.locator(
        '[data-rich-block="conversation-assistant-a30"] .markdown p',
      );
      await answer.waitFor();
      await answer.scrollIntoViewIfNeeded();
      const box = (await answer.boundingBox())!,
        body = (await page
          .locator(".terminal-conversation-body")
          .boundingBox())!;
      await page.mouse.move(
        box.x + 220,
        Math.min(box.y + 18, body.y + body.height - 40),
      );
      await page.mouse.down();
      await page.mouse.move(body.x + 80, body.y + 80, { steps: 8 });
      await page.evaluate(() => {
        (window as any).savedAnchor = window.getSelection()!.anchorNode;
        (window as any).queueRefresh();
      });
      await page.waitForFunction(() =>
        (window as any).requests.some(
          (request: any) => request.cursor === null && request.revision === 2,
        ),
      );
      await page.waitForTimeout(80);
      assert.equal(
        await page.getByText("UPDATED LAST ANSWER", { exact: true }).count(),
        0,
      );
      await page.mouse.wheel(0, -20000);
      await page.waitForFunction(
        () => typeof (window as any).releaseOlder === "function",
      );
      const firstAnswer = (await page
        .locator('[data-rich-block="conversation-assistant-a5"] .markdown p')
        .boundingBox())!;
      await page.mouse.move(firstAnswer.x + 1, firstAnswer.y + 8, { steps: 4 });
      const before = await page.evaluate(() => (window as any).readSelection());
      assert.ok(before.includes("ANSWER 30"));
      assert.ok(before.includes("ANSWER 5"));
      await page.evaluate(() => (window as any).releaseOlder());
      await page.locator('[data-rich-block="conversation-user-q5"]').waitFor();
      assert.equal(
        await page.evaluate(() => (window as any).readSelection()),
        before,
        "prepending a missing question must preserve the old selection until the next wheel",
      );
      assert.equal(
        await page.evaluate(
          () =>
            window.getSelection()!.anchorNode === (window as any).savedAnchor,
        ),
        true,
      );
      assert.equal(
        await page.getByText("UPDATED LAST ANSWER", { exact: true }).count(),
        0,
      );
      assert.equal(
        await page.getByText("STALE DUPLICATE", { exact: true }).count(),
        0,
      );
      await page.mouse.move(body.x + 100, body.y + 5, { steps: 4 });
      await page.mouse.wheel(0, -20000);
      await page.locator('[data-rich-block="conversation-user-q0"]').waitFor();
      await page.mouse.wheel(0, -20000);
      await page.waitForTimeout(80);
      const earliestQuestion = (await page
        .locator(
          '[data-rich-block="conversation-user-q0"] .conversation-question',
        )
        .boundingBox())!;
      await page.mouse.move(earliestQuestion.x + 1, earliestQuestion.y + 8, {
        steps: 4,
      });
      const crossed = await page.evaluate(() =>
        (window as any).readSelection(),
      );
      assert.ok(
        crossed.includes("QUESTION 0") && crossed.includes("ANSWER 30"),
        "held drag must reach earlier pages without mouseup",
      );
      assert.equal(
        await page.evaluate(
          () =>
            window.getSelection()!.anchorNode === (window as any).savedAnchor,
        ),
        true,
      );
      await page.mouse.up();
      await page.evaluate(() => window.getSelection()!.removeAllRanges());
      assert.equal(
        await page.getByText("UPDATED LAST ANSWER", { exact: true }).count(),
        0,
        "reading older output keeps live redraws deferred after the drag ends",
      );
      await page
        .getByRole("button", { name: "맨 아래로", exact: true })
        .click();
      await page.getByText("UPDATED LAST ANSWER", { exact: true }).waitFor();
      assert.equal(
        await page.locator('[data-rich-block="conversation-user-q0"]').count(),
        1,
        "queued refresh retains all older pages",
      );
      assert.deepEqual(
        await page.evaluate(() =>
          (window as any).requests
            .filter((request: any) => request.cursor)
            .map((request: any) => request.cursor),
        ),
        ["older", "empty", "earliest"],
      );
      const remapped = await page.evaluate(() => {
        const root = document.createElement("div");
        root.innerHTML =
          '<article data-rich-block="snapshot-one">First message text</article><article data-rich-block="snapshot-two">Second message text</article>';
        document.body.append(root);
        const first = root.firstElementChild!.firstChild!,
          last = root.lastElementChild!.firstChild!;
        const selection = window.getSelection()!;
        selection.setBaseAndExtent(last, 9, first, 3);
        const before = selection.toString(),
          snapshot = (window as any).captureSelection(root);
        root.replaceChildren(
          ...[...root.children].map((child) => child.cloneNode(true)),
        );
        const restored = (window as any).restoreSelection(root, snapshot);
        const sameText = selection.toString() === before;
        const backwards =
          selection.anchorNode === root.lastElementChild!.firstChild &&
          selection.anchorOffset === 9 &&
          selection.focusOffset === 3;
        const changedSnapshot = (window as any).captureSelection(root);
        root.innerHTML =
          '<article data-rich-block="snapshot-one">Changed content</article><article data-rich-block="snapshot-two">Second message text</article>';
        const rejectsChanged = !(window as any).restoreSelection(
          root,
          changedSnapshot,
        );
        selection.removeAllRanges();
        root.remove();
        return { restored, sameText, backwards, rejectsChanged };
      });
      assert.deepEqual(remapped, {
        restored: true,
        sameText: true,
        backwards: true,
        rejectsChanged: true,
      });
      await page.evaluate(() => (window as any).useCycle());
      await page
        .locator('[data-rich-block="conversation-assistant-a2"]')
        .waitFor();
      await page
        .getByRole("button", { name: "이전 메시지 더 보기", exact: true })
        .click();
      await page.waitForFunction(() =>
        (window as any).requests.some(
          (request: any) => request.cursor === "cycle-A",
        ),
      );
      await page
        .getByRole("button", { name: "이전 메시지 더 보기", exact: true })
        .click();
      await page.waitForFunction(() =>
        (window as any).requests.some(
          (request: any) => request.cursor === "cycle-B",
        ),
      );
      await page
        .getByRole("button", { name: "이전 메시지 더 보기", exact: true })
        .click();
      await page.getByRole("alert").waitFor();
      await page.waitForTimeout(150);
      assert.deepEqual(
        await page.evaluate(() =>
          (window as any).requests
            .filter(
              (request: any) => request.sessionId === "cycle" && request.cursor,
            )
            .map((request: any) => request.cursor),
        ),
        ["cycle-A", "cycle-B"],
      );
      assert.ok(
        await page.evaluate(() =>
          (window as any).requests.every(
            (request: any) => request.method === "GET",
          ),
        ),
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
