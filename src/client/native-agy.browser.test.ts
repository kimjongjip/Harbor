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
import{Terminal}from"@xterm/xterm";import{TerminalConversation}from"./src/client/TerminalConversation";
import"./src/client/styles.css";import"./src/client/terminal-conversation.css";
Object.defineProperty(document,"visibilityState",{get:()=>"visible"});
const info={id:"fixture",hostId:"test",cwd:"/fixture",title:"Orion",agentKind:"antigravity",agentSessionId:"agy-native",nativeAgySessionId:"agy-native",exited:false};
const table="| Method | Score |\\n|---|---|\\n| Native model | 42 |";
window.nativeWrites=[];window.fetch=async(url)=>{if(!String(url).includes("/history/agy-native?")||!String(url).includes("provider=antigravity"))throw Error("wrong history binding");
return new Response(JSON.stringify({thread:{id:"agy-native",hostId:"test",title:"Fixture",cwd:"/fixture"},items:[{id:"q",kind:"user",text:"Compare values"},{id:"a",kind:"assistant",text:table,phase:"final_answer",turnStatus:"completed"},...(window.work?[{id:"q2",kind:"user",text:"run the fixture"}]:[])],nextCursor:null}));};
function Fixture(){const [term,setTerm]=useState(null);useEffect(()=>{const t=new Terminal({cols:80,rows:18});t.open(document.getElementById("pty"));window.repaint=(s)=>new Promise(done=>t.write(s,done));t.write("Method   Score\\r\\nNative model  42\\r\\n────────────────────────\\r\\n> \\r\\n────────────────────────\\r\\n? for shortcuts   auto · Gemini 4",()=>setTerm(t));t.onData(data=>{window.nativeWrites.push(data);t.write(data);});return()=>t.dispose();},[]);
return <><div style={{height:560,width:850,position:"relative"}}><div id="pty"/></div>{term&&<TerminalConversation term={term} info={info} active/>}</>;}
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
      await paintWork(workText+" step 2","two");
      await page.locator(".terminal-native-flow").getByText(workText+" step 2",{exact:true}).waitFor();
      await paintWork("","two");
      await page.locator(".terminal-native-flow").getByText(workText+" step 2",{exact:true}).waitFor({state:"detached",timeout:2000});
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
