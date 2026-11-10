import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import { build } from "esbuild";
import { _electron } from "playwright";

for (const provider of ["codex", "claude"]) test(
  `native ${provider} completion rereads history without peer events, input fetches or completion guesses`,
  { skip: process.platform !== "win32", timeout: 60000 },
  async () => {
    const root = resolve(".cache/terminal-completion-refresh-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    await build({
      stdin: {
        contents: `
import React,{useEffect,useState}from'react';import{createRoot}from'react-dom/client';
import{Terminal}from'@xterm/xterm';import'@xterm/xterm/css/xterm.css';
import{TerminalConversation}from'./src/client/TerminalConversation';
import'./src/client/styles.css';import'./src/client/themes.css';import'./src/client/history.css';
Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});
window.requests=[];window.stage=0;window.nativeWrites=[];
const info={id:'fixture-pty',hostId:'fixture',cwd:'/fixture',title:'Completion fixture',exited:false,agentKind:'${provider}',agentSessionId:'fixture-history',agentState:'idle',peerDelivery:'poll'};
window.fetch=async(input,options={})=>{const url=new URL(String(input),location.href);window.requests.push({url:url.href,method:options.method,stage:window.stage});
if(url.pathname!=='/api/hosts/fixture/history/fixture-history')throw Error('Unexpected operation '+url.pathname);
const turnStatus=window.stage>=2?'completed':'inProgress';const text=window.stage===0?'PARTIAL NATIVE ANSWER':'VERIFIED COMPLETE FINAL ANSWER';
const timeline=[{id:'q',kind:'user',text:'SYNTHETIC QUESTION',turnId:'turn'},{id:'work',kind:'command',text:'SYNTHETIC ORIGINAL WORK',turnId:'turn',turnStatus},{id:'a',kind:'assistant',text,turnId:'turn',phase:'final_answer',turnStatus}];
if(window.stage===5)timeline.push({id:'next-q',kind:'user',text:'NEW TURN ARRIVED AFTER BUSY EVENT',turnId:'next-turn'});
return new Response(JSON.stringify({thread:{id:'fixture-history',hostId:'fixture',title:'Fixture',cwd:'/fixture'},timeline,items:timeline.filter(item=>item.kind!=='command'),nextCursor:null}),{status:200,headers:{'Content-Type':'application/json'}});};
function Fixture(){const[term,setTerm]=useState(null),[active,setActive]=useState(true),[working,setWorking]=useState(false);window.setActive=setActive;window.setWorking=setWorking;
useEffect(()=>{const native=new Terminal({cols:100,rows:24,fontSize:14,convertEol:true});native.open(document.getElementById('native'));const write=native.write.bind(native);
window.echo=text=>new Promise(resolve=>write(text,resolve));window.frame=text=>window.echo('\\x1b[2J\\x1b[H'+text);window.frame('› SYNTHETIC QUESTION\\r\\nLIVE NATIVE WORK\\r\\nPARTIAL NATIVE ANSWER\\r\\n• Working (2s • esc to interrupt)');
native.write=data=>window.nativeWrites.push(data);setTerm(native);return()=>native.dispose();},[]);
return <><div style={{position:'relative',width:900,height:700}}><div id="native" style={{height:'100%'}}/></div>{term&&<TerminalConversation term={term} info={{...info,agentState:working?'working':'idle'}} active={active}/>}</>;}
createRoot(document.getElementById('root')).render(<Fixture/>);`,
        resolveDir: process.cwd(),
        sourcefile: "completion-refresh-fixture.tsx",
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
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.commandLine.appendSwitch('disable-gpu');app.whenReady().then(()=>new BrowserWindow({show:false,width:1000,height:800,webPreferences:{backgroundThrottling:false,contextIsolation:true,sandbox:true}}).loadURL('http://127.0.0.1:${(server.address() as { port: number }).port}/'));app.on('window-all-closed',()=>app.quit());`,
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
      await page
        .locator(".terminal-native-flow")
        .getByText("LIVE NATIVE WORK", { exact: true })
        .waitFor();
      await page.waitForTimeout(400);
      assert.equal(await page.locator(".conversation-work").count(), 0);

      // Toggling visibility with an unchanged frame must retain the cue baseline.
      await page.evaluate(() => (window as any).setActive(false));
      await page.waitForTimeout(200);
      await page.evaluate(() => (window as any).setActive(true));
      await page.waitForTimeout(400);
      const initial = await page.evaluate(
        () => (window as any).requests.length,
      );
      await page.evaluate(async (footer) => {
        (window as any).stage = 1;
        await (window as any).frame(
          "› SYNTHETIC QUESTION\r\nLIVE NATIVE WORK\r\nVERIFIED COMPLETE FINAL ANSWER\r\n" + footer + "\r\n› DRAFT",
        );
      }, provider === "claude" ? "✻ Cooked for 2s · done Monday 7:58 PM" : "• Worked for 2s");
      await page.waitForFunction(
        (count) => (window as any).requests.length === count + 1,
        initial,
        { timeout: 2500 },
      );
      await page.waitForTimeout(250);
      assert.equal(
        await page
          .locator('.conversation-work[data-work-state="done"]')
          .count(),
        0,
        "the footer cannot turn in-progress history into a completed answer",
      );
      // Unverified saved work stays visible as a record of the running turn.
      assert.match(
        await page
          .locator('.conversation-work[data-work-state="live"] > summary')
          .innerText(),
        /^작업 기록/,
      );
      assert.ok(
        (await page.locator(".terminal-native-flow").last().innerText()).includes(
          "› DRAFT",
        ),
      );

      // Persistence catches up without changing the answer or footer. A bounded
      // follow-up read must fold it without another terminal write or peer event.
      await page.evaluate(() => {
        (window as any).stage = 2;
      });
      // The unverified answer is already readable inside the running record;
      // completion is the moment its work folds into a closed group.
      await page
        .locator('.conversation-work[data-work-state="done"]')
        .waitFor({ timeout: 2500 });
      await page
        .locator('.conversation-turn > .transcript-items [data-rich-block="conversation-assistant-a"]')
        .getByText("VERIFIED COMPLETE FINAL ANSWER", { exact: true })
        .waitFor({ timeout: 2500 });
      assert.equal(await page.locator(".conversation-work").count(), 1);
      assert.equal(await page.locator(".conversation-work[open]").count(), 0);
      await page.waitForTimeout(4500);
      const afterComplete = await page.evaluate(
        () => (window as any).requests.length,
      );
      assert.equal(afterComplete, initial + 4, "completion retries are bounded");
      for (const character of "abcdefghijklmnopqrst")
        await page.evaluate((text) => (window as any).echo(text), character);
      await page.waitForTimeout(400);
      assert.equal(
        await page.evaluate(() => (window as any).requests.length),
        afterComplete,
        "typing below an unchanged footer never fetches history",
      );
      await page.evaluate(() => {
        (window as any).stage = 4;
        (window as any).setWorking(true);
      });
      await page.waitForFunction(() => (window as any).requests.some((r: any) => r.stage === 4));
      await page.evaluate(() => { (window as any).stage = 5; });
      await page.locator('[data-rich-block="conversation-user-next-q"]').waitFor({ timeout: 3000 });
      await page.evaluate(() => (window as any).setWorking(false));
      assert.deepEqual(
        await page.evaluate(() => (window as any).nativeWrites),
        [],
        "read-only completion observation never sends PTY input",
      );
      assert.ok(
        (await page.evaluate(() => (window as any).requests)).every(
          (request: { method: string }) => request.method === "GET",
        ),
      );
      assert.deepEqual(errors, []);
    } finally {
      await desktop?.close();
      server.close();
      if (!directory.startsWith(root + sep))
        throw new Error("Unsafe fixture cleanup path");
      await rm(directory, { recursive: true, force: true });
    }
  },
);
