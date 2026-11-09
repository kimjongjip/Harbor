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
  "mobile history crosses empty bounded pages, preserves notices and clears them for a new session",
  { skip: process.platform !== "win32", timeout: 60000 },
  async () => {
    const root = resolve(".cache/history-notice-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    const notice =
      "An oversized record was omitted; other messages remain readable.";
    const legacyError =
      "이 Claude 기록은 16 MB를 초과합니다. 터미널에서 이어서 확인하세요.";
    await build({
      stdin: {
        contents: `
import React,{useRef,useState}from'react';import{createRoot}from'react-dom/client';
import{MobileConversation}from'./src/client/mobile/MobileConversation';
window.historyRequests=[];
window.historyCompatFailure=true;
const nativeTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>nativeTimeout(fn,ms===10000?20:ms,...args);
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
window.fetch=async input=>{const url=new URL(String(input),location.href),sessionId=url.searchParams.get('sessionId'),cursor=url.searchParams.get('cursor');window.historyRequests.push({sessionId,cursor});
const page={sessionId,provider:'claude',items:[],nextCursor:null};
if(sessionId==='other-error')return new Response(JSON.stringify({error:'Permission denied for this conversation'}),{status:403});
if(sessionId.startsWith('compat-')){
const count=window.historyRequests.filter(entry=>entry.sessionId===sessionId).length;
if(sessionId==='compat-cached'&&count===1)return response({...page,items:[{id:'cached',kind:'assistant',text:'PRESERVED CACHED ANSWER'}]});
if(window.historyCompatFailure)return new Response(JSON.stringify({error:${JSON.stringify(legacyError)}}),{status:500});
return response({...page,items:[{id:'recovered',kind:'assistant',text:'RECOVERED ANSWER'}]});}
if(sessionId==='next')return response({...page,items:[{id:'next-question',kind:'user',text:'NEW SESSION QUESTION'}]});
if(!cursor)return response({...page,nextCursor:'byte:2',notice:${JSON.stringify(notice)}});
if(cursor==='byte:2')return new Promise(resolve=>{window.releaseOlder=()=>resolve(response({...page,items:[{id:'q2',kind:'user',text:'LATEST QUESTION'},{id:'a2',kind:'assistant',text:'LATEST COMPLETE ANSWER'}],nextCursor:'byte:1'}));});
if(cursor==='byte:1')return response({...page,items:[{id:'q1',kind:'user',text:'EARLIEST QUESTION'},{id:'a1',kind:'assistant',text:'EARLIEST ANSWER'},{id:'a2',kind:'assistant',text:'OLD PARTIAL ANSWER'}]});
throw Error('Unexpected cursor');};
function Fixture(){const scroller=useRef(null),following=useRef(false);const[session,setSession]=useState('large'),[revision,setRevision]=useState(0);window.setHistorySession=setSession;window.setHistoryRevision=setRevision;
return <div id="scroller" ref={scroller} style={{height:600,overflowY:'auto'}}><MobileConversation key={session} terminalId="fixture" sessionId={session} active={true} blocks={[{id:'fallback',text:'RICH FALLBACK ANSWER'}]} answerId="" revision={revision} scroller={scroller} following={following} embeddedBefore={session.startsWith('compat-')||session==='other-error'?undefined:[]} renderText={text=><p>{text}</p>}/></div>;}
createRoot(document.getElementById('root')).render(<Fixture/>);`,
        resolveDir: process.cwd(),
        sourcefile: "history-notice-fixture.tsx",
        loader: "tsx",
      },
      bundle: true,
      outfile: join(directory, "fixture.js"),
      format: "esm",
      logLevel: "silent",
    });
    const serverApp = express();
    serverApp.use(express.static(directory));
    serverApp.get("/", (_req, res) =>
      res
        .type("html")
        .send(
          '<!doctype html><html><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
        ),
    );
    const server = createServer(serverApp);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const main = join(directory, "electron.cjs");
    await writeFile(
      main,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.commandLine.appendSwitch('disable-gpu');app.whenReady().then(()=>{new BrowserWindow({show:false,width:390,height:844,webPreferences:{backgroundThrottling:false,contextIsolation:true,sandbox:true}}).loadURL('http://127.0.0.1:${port}/');});app.on('window-all-closed',()=>app.quit());`,
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
      await page.waitForFunction(
        () => typeof (window as any).releaseOlder === "function",
      );
      assert.equal(await page.getByText(notice, { exact: true }).count(), 1);
      assert.equal(
        await page.getByText("대화의 시작", { exact: true }).count(),
        0,
      );
      assert.equal(
        await page.getByText(/아직 저장된 질문과 답변이 없습니다/).count(),
        0,
      );
      await page.evaluate(() => (window as any).releaseOlder());
      await page.getByText("대화의 시작", { exact: true }).waitFor();
      assert.deepEqual(
        await page.locator(".conversation-message").allTextContents(),
        [
          "나EARLIEST QUESTION",
          "ClaudeEARLIEST ANSWER",
          "나LATEST QUESTION",
          "ClaudeLATEST COMPLETE ANSWER",
        ],
      );
      assert.equal(await page.getByText(notice, { exact: true }).count(), 1);
      assert.equal(
        await page.getByText("OLD PARTIAL ANSWER", { exact: true }).count(),
        0,
      );
      assert.deepEqual(
        await page.evaluate(() =>
          (window as any).historyRequests.map((entry: any) => entry.cursor),
        ),
        [null, "byte:2", "byte:1"],
      );
      await page.evaluate(() => (window as any).setHistorySession("next"));
      await page.getByText("NEW SESSION QUESTION", { exact: true }).waitFor();
      assert.equal(await page.getByText(notice, { exact: true }).count(), 0);
      assert.equal(
        await page.getByText("LATEST QUESTION", { exact: true }).count(),
        0,
      );
      await page.evaluate(() =>
        (window as any).setHistorySession("compat-cached"),
      );
      await page
        .getByRole("button", { name: "기록 다시 불러오기", exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByText("PRESERVED CACHED ANSWER", { exact: true })
          .count(),
        1,
      );
      assert.equal(
        await page.getByText(legacyError, { exact: true }).count(),
        0,
      );
      assert.equal(await page.getByRole("alert").count(), 0);
      await page.evaluate(() => (window as any).setHistoryRevision(2));
      await page.waitForTimeout(100);
      assert.equal(
        await page.evaluate(
          () =>
            (window as any).historyRequests.filter(
              (entry: any) => entry.sessionId === "compat-cached",
            ).length,
        ),
        2,
        "old backend failure must stop both timer and revision retries",
      );
      await page.evaluate(() => {
        (window as any).historyCompatFailure = false;
      });
      await page
        .getByRole("button", { name: "기록 다시 불러오기", exact: true })
        .click();
      await page.getByText("RECOVERED ANSWER", { exact: true }).waitFor();
      assert.equal(
        await page
          .getByText("PRESERVED CACHED ANSWER", { exact: true })
          .count(),
        1,
      );
      await page.evaluate(() => {
        (window as any).historyCompatFailure = true;
        (window as any).setHistorySession("compat-empty");
      });
      await page.getByText("RICH FALLBACK ANSWER", { exact: true }).waitFor();
      assert.equal(await page.getByRole("alert").count(), 0);
      assert.equal(
        await page
          .getByText("PRESERVED CACHED ANSWER", { exact: true })
          .count(),
        0,
      );
      await page.waitForTimeout(100);
      assert.equal(
        await page.evaluate(
          () =>
            (window as any).historyRequests.filter(
              (entry: any) => entry.sessionId === "compat-empty",
            ).length,
        ),
        1,
      );
      await page.evaluate(() =>
        (window as any).setHistorySession("other-error"),
      );
      await page
        .getByRole("alert")
        .filter({ hasText: "Permission denied for this conversation" })
        .waitFor();
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
