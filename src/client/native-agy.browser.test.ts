import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import { build } from "esbuild";
import { _electron } from "playwright";

test(
  "native Antigravity saved Markdown renders in the existing tmux terminal",
  { skip: process.platform !== "win32", timeout: 90000 },
  async () => {
    const root = resolve(".cache/native-agy-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    await build({
      stdin: {
        contents: `
import React,{useState,useEffect} from "react";import{createRoot}from"react-dom/client";
import{TerminalUsageBar}from"./src/client/TerminalUsageBar";import{Terminal}from"@xterm/xterm";import{TerminalConversation}from"./src/client/TerminalConversation";
import"./src/client/styles.css";import"./src/client/terminal-conversation.css";
Object.defineProperty(document,"visibilityState",{get:()=>"visible"});
const info={id:"fixture",hostId:"test",cwd:"/fixture",title:"Orion",agentKind:"antigravity",agentSessionId:"agy-native",nativeAgySessionId:"agy-native",exited:false};
const table="| Method | Score |\\n|---|---|\\n| Native model | 42 |";
window.nativeWrites=[];window.fetch=async(url)=>{if(!String(url).includes("/history/agy-native?")||!String(url).includes("provider=antigravity"))throw Error("wrong history binding");
return new Response(JSON.stringify({thread:{id:"agy-native",hostId:"test",title:"Fixture",cwd:"/fixture"},items:[{id:"q",kind:"user",text:"Compare values"},{id:"a",kind:"assistant",text:table,phase:"final_answer",turnStatus:"completed"},...(window.work?[{id:"q2",kind:"user",text:"run the fixture"},...(window.finished?[{id:"a2",kind:"assistant",text:"Finished fixture",phase:"final_answer",turnStatus:"completed"}]:[])]:[]),...(window.third?[{id:"q3",kind:"user",text:"third turn"},...(window.done3?[{id:"a3",kind:"assistant",text:"Stable final",phase:"final_answer",turnStatus:"completed"}]:[])]:[])],nextCursor:null}));};
function Fixture(){const [nativeWork,setNativeWork]=useState(false),[agentState,setAgentState]=useState("idle");window.nativeWork=setNativeWork;window.agentState=setAgentState;const [term,setTerm]=useState(null),[roster,setRoster]=useState();useEffect(()=>{const t=new Terminal({cols:80,rows:18});t.open(document.getElementById("pty"));window.repaint=(s)=>new Promise(done=>t.write(s,done));t.write("Method   Score\\r\\nNative model  42\\r\\n────────────────────────\\r\\n> \\r\\n────────────────────────\\r\\n? for shortcuts   auto · Gemini 4",()=>setTerm(t));t.onData(data=>{window.nativeWrites.push(data);t.write(data);});return()=>t.dispose();},[]);
return <><div style={{height:560,width:850,position:"relative"}}><div id="pty"/></div>{term&&<><TerminalUsageBar terminal={term} terminalId="fixture" provider="antigravity" active working onRosterShown={setRoster}/><TerminalConversation term={term} info={{...info,agentState}} nativeWhileWorking={nativeWork} active mirroredCrew={roster}/></>}</>;}
createRoot(document.getElementById("root")).render(<Fixture/>);`,
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
      const table=page.locator(".terminal-conversation table");
      await table.getByRole("cell",{name:"Native model",exact:true}).waitFor();
      assert.equal(await table.getByRole("cell",{name:"42",exact:true}).count(),1);
      // A resized tmux client can present only the lower separator while the
      // working editor already has its draft and cursor. The old reader hid it.
      const redraw = async (draft:string,extra:string) => page.evaluate(async({draft,extra})=>{
        const data="\x1b[2J\x1b[HMethod    Score\r\nNative model   42\r\n"+draft+"\r\n"+extra+
          "────────────────────────\r\nauto · Gemini 4\r\nmedium\x1b[3;4H";
        await (window as any).repaint(data);
      },{draft,extra});
      const composer=page.locator(".terminal-flow-composer");
      await redraw("> ","");
      await composer.getByText(">",{exact:true}).waitFor();
      await redraw("> keep this draft","continued on next row\r\n");
      await composer.getByText(/keep this draft/).waitFor();
      await composer.getByText("continued on next row",{exact:true}).waitFor();
      assert.equal(await table.isVisible(),true);
      assert.deepEqual(await page.evaluate(()=>(window as any).nativeWrites),[]);
      const observed = await page.evaluate(async()=>{
        const surface=document.querySelector<HTMLElement>(".terminal-conversation")!;
        const editor=surface.querySelector<HTMLElement>(".terminal-flow-composer")!;
        const row=Array.from(editor.querySelectorAll(".terminal-native-row")).find(n=>n.textContent?.includes("keep this draft"))!;
        const issues=new Set<string>();
        const observer=new MutationObserver(()=>{
          if(surface.hidden || !editor.textContent?.includes("keep this draft")) issues.add("draft disappeared");
          if(!row.isConnected) issues.add("prompt row remounted");
          if(!row.querySelector("[data-native-cursor]")) issues.add("caret disappeared during output");
        });
        observer.observe(surface,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:["hidden"]});
        const w=window as any;
        const rule="────────────────────────";
        for(let i=0;i<4;i++){
          const output="rendering "+i+"\r\n".repeat(i+1);
          await w.repaint("\x1b[2J\x1b[H"+output);
          await new Promise(done=>setTimeout(done,90));
          await w.repaint("\x1b[2J\x1b[H"+output+rule+"\r\n> keep this draft\r\n"+rule+"\r\nauto · Gemini 4\x1b[1;1H");
          await new Promise(done=>setTimeout(done,90));
        }
        observer.disconnect();return [...issues];
      });
      assert.deepEqual(observed,[],"streaming redraws must preserve the prompt row and draft continuously");
      await redraw("> keep this draft","");
      await composer.getByText(/keep this draft/).click();
      await page.keyboard.type("Z");
      await composer.getByText(/Z/).waitFor();
      assert.deepEqual(await page.evaluate(()=>(window as any).nativeWrites),["Z"]);
      await page.evaluate(()=>{(window as any).work=true;document.dispatchEvent(new Event("visibilitychange"));});
      await page.getByText("run the fixture",{exact:true}).waitFor();
      const paintWork=async (body:string,draft:string)=>page.evaluate(async({body,draft})=>{
        const rule="────────────────────────";
        await (window as any).repaint("\x1b[2J\x1b[H> run the fixture\r\n"+body+"\r\n"+rule+"\r\n> "+draft+"\r\n"+rule+"\r\nauto · Gemini 4 Carbon · high\x1b[4;5H");
      },{body,draft});
      const workText="Evaluating the synthetic model";
      await paintWork(workText,"one");
      const live=page.locator(".terminal-native-flow").getByText(workText,{exact:true});
      await live.waitFor();
      await paintWork("","two");
      await composer.getByText(/two/).waitFor();
      assert.equal(await live.count(),1,"an intact editor must not publish an erased work area");
      for (let cycle = 0; cycle < 3; cycle++) {
        await paintWork("", "two");
        await page.waitForTimeout(650);
        assert.equal(await live.isVisible(), true, "slow repeated clears must retain the running output");
        await paintWork(workText, "two");
        await live.waitFor();
      }
      await paintWork(workText+" step 2","two");
      await page.locator(".terminal-native-flow").getByText(workText+" step 2",{exact:true}).waitFor();
      await paintWork("","two");
      await page.evaluate(()=>{(window as any).finished=true;document.dispatchEvent(new Event("visibilitychange"));});
      await page.getByText("Finished fixture", {exact:true}).waitFor();
      await page.locator(".terminal-native-flow").getByText(workText+" step 2",{exact:true}).waitFor({state:"detached"});
      await page.evaluate(async()=>{
        await (window as any).repaint("\x1b[2J\x1b[H────────────────────────\r\n> \r\n────────────────────────\r\nauto · Gemini 4 Carbon · high · 4 task(s) · /tasks");
      });
      await page.getByText("작업 4개 · /tasks",{exact:true}).waitFor();
      const footer = page.locator(".terminal-conversation .terminal-flow-composer");
      await page.waitForFunction(()=>!document.querySelector(".terminal-conversation .terminal-flow-composer")?.textContent?.includes("/tasks"));
      assert.match(await footer.innerText(), /Gemini 4 Carbon/);
      await page.getByRole("button",{name:"상태 패널 접기"}).click();
      await footer.getByText(/4 task\(s\)/).waitFor();
      const previousTable = await table.elementHandle();
      await page.evaluate(()=>{(window as any).nativeWork(true);(window as any).agentState("working");});
      await page.locator("[data-native-work]").waitFor({state:"attached"});
      const originalPty = await page.locator("#pty .xterm").elementHandle();
      const flashes = await page.evaluate(async()=>{
        let flashes=0;
        const observe = new MutationObserver(() => {
          const reader = document.querySelector<HTMLElement>("[data-native-work]");
          if (!reader || reader.hidden || !reader.querySelector("table") || reader.innerText.includes("~HBR:")) flashes++;
        });
        observe.observe(document.querySelector("#root")!,{subtree:true,childList:true,attributes:true});
        const w=window as any;
        w.third=true;
        document.dispatchEvent(new Event("visibilitychange"));
        for(const state of ["waiting","working","idle","working","waiting","idle"]) {
          w.agentState(state);
          await w.repaint("\x1b[2J\x1b[H~HBR:9e6782ee44794b9596ef:21~\r\n~HBR:9e6782ee44794b9596ef:22~\r\n"+(state==="working"?"\x1b[32mworking\x1b[0m":"> /menu"));
          await new Promise(done=>setTimeout(done,250));
        }
        observe.disconnect();return flashes;
      });
      assert.equal(flashes,0,"no intermediate repaint or idle/wait notification may re-enable the reader");
      assert.ok(await previousTable?.evaluate(node=>node.isConnected));
      const generation = page.getByRole("status").filter({hasText:"Generating…"});
      for (let i=0;i<3;i++) {
        await page.evaluate(()=>(window as any).repaint("\x1b[2J\x1b[H────────────────────────\r\n> third turn\r\n⠿ Generating...\r\n────────────────────────"));
        await generation.waitFor();
        assert.equal(await page.locator(".terminal-native-flow").getByText("> third turn",{exact:true}).count(),0);
        await page.evaluate(()=>(window as any).repaint("\x1b[2J\x1b[H────────────────────────\r\n> \r\n────────────────────────\r\n? for shortcuts    auto · Gemini 4 Carbon · high"));
        await page.waitForTimeout(350);
        assert.equal(await generation.isVisible(),true);
        assert.equal(await table.isVisible(),true);
      }
      await page.evaluate(()=>(window as any).repaint("\x1b[2J\x1b[H~HBR:9e6782ee44794b9596ef:29~\r\n> third turn\r\n● Explored 5 files (sample.py)\r\n● Ran 2 commands (2 failed)\r\nWorking on the third turn\r\n────────────────────────\r\n> \r\n────────────────────────\r\nauto · Gemini 4"));
      await page.getByText("● Ran 2 commands (2 failed)",{exact:true}).waitFor();
      await page.evaluate(()=>(window as any).repaint("\x1b[2J\x1b[H"));
      await page.waitForTimeout(500);
      assert.equal(await page.locator(".agy-work-summary-row").filter({hasText:"Explored 5 files"}).count(),1);
      assert.equal(await table.isVisible(), true);
      assert.ok(await originalPty?.evaluate(el=>el.isConnected));
      await page.evaluate(()=>(window as any).repaint("\x1b[2J\x1b[H────────────────────────\r\n> \r\n────────────────────────\r\nesc to cancel                            auto · Gemini 4 Carbon ·\r\nhigh"));
      const settings = page.locator(".terminal-agy-settings");
      await settings.getByText(/Gemini 4 Carbon · high/).waitFor();
      assert.equal(await settings.evaluate(el=>getComputedStyle(el).whiteSpace),"nowrap");
      await page.evaluate(()=>(window as any).repaint("\x1b[2J\x1b[H────────────────────────\r\n> \r\n────────────────────────\r\n? for shortcuts    auto · Gemini 4 Carbon · high"));
      await page.waitForTimeout(350);
      await page.evaluate(()=>{(window as any).done3=true;}); // disk update only, no PTY or browser event
      await page.getByText("Stable final",{exact:true}).waitFor();
      await generation.waitFor({state:"detached"});
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
