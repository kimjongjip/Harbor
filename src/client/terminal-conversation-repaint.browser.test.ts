import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import { build } from "esbuild";
import { _electron } from "playwright";

for (const provider of ["claude", "codex"])
  test(
    `idle ${provider} repaint fragments cannot alternate saved work and the raw screen`,
    { skip: process.platform !== "win32", timeout: 60000 },
    async () => {
      const prompt = provider === "codex" ? "›" : "❯";
      const root = resolve(".cache/conversation-repaint-tests");
      await mkdir(root, { recursive: true });
      const directory = await mkdtemp(join(root, "run-"));
      await build({
        stdin: {
          contents: `
import React,{useState,useEffect}from'react';import{createRoot}from'react-dom/client';
import{Terminal}from'@xterm/xterm';import{TerminalConversation}from'./src/client/TerminalConversation';
import'@xterm/xterm/css/xterm.css';import'./src/client/styles.css';import'./src/client/themes.css';
Object.defineProperty(document,'visibilityState',{get:()=> 'visible'});
window.inputs=[];window.requests=[];
window.historyReady=new Promise(resolve=>window.releaseHistory=resolve);
window.fetch=async(url,options)=>{window.requests.push({url:String(url),method:options?.method});await window.historyReady;
const timeline=[{id:'question',kind:'user',text:'Update the sample',turnId:'turn'},
{id:'command',kind:'command',text:'python3 sample.py',detail:'SAVED COMMAND OUTPUT',turnId:'turn',status:'completed'}];
return new Response(JSON.stringify({thread:{id:'session',hostId:'fixture',cwd:'/fixture'},items:timeline,timeline,nextCursor:null}),{headers:{'Content-Type':'application/json'}})};
function Fixture(){const[term,setTerm]=useState(null),[info,setInfo]=useState({id:'terminal',hostId:'fixture',cwd:'/fixture',title:'Synthetic repaint',agentKind:'${provider}',agentSessionId:'session',agentState:'working'});
window.setWaiting=(waiting=true)=>setInfo(v=>({...v,agentState:waiting?'waiting':'working'}));
window.refreshHistory=()=>document.dispatchEvent(new Event('visibilitychange'));
useEffect(()=>{const t=new Terminal({cols:90,rows:24,fontSize:14,allowProposedApi:true});t.open(document.getElementById('native'));t.onData(data=>window.inputs.push(data));window.term=t;
window.write=data=>new Promise(done=>t.write(data,done));
window.partial=()=>window.write('\\x1b[2J\\x1b[H${prompt} Update the sample\\r\\n\\x1b[41m184 - OLD RAW DIFF\\x1b[0m\\r\\n\\x1b[42m184 + NEW RAW DIFF\\x1b[0m');
window.footer=()=>window.write('\\x1b[13;1H'+('${provider}'==='claude'?'─'.repeat(90)+'\\r\\n❯ UNSENT DRAFT\\r\\n'+'─'.repeat(90):'• Working\\r\\n› UNSENT DRAFT')+'\\r\\n  ? for shortcuts\\x1b[14;15H');
(async()=>{await window.partial();await window.footer();setTerm(t)})();return()=>t.dispose()},[]);
return <><div style={{position:'relative',height:650,width:1000}}><div id="native"/></div>{term&&<TerminalConversation term={term} info={info}/>}</>}
createRoot(document.getElementById('root')).render(<Fixture/>);`,
          resolveDir: process.cwd(),
          sourcefile: "repaint-fixture.tsx",
          loader: "tsx",
        },
        bundle: true,
        format: "esm",
        outfile: join(directory, "fixture.js"),
        loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
        logLevel: "silent",
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
        `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.commandLine.appendSwitch('disable-gpu');app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:850,webPreferences:{backgroundThrottling:false,contextIsolation:true,sandbox:true}}).loadURL('http://127.0.0.1:${(server.address() as { port: number }).port}'));app.on('window-all-closed',()=>app.quit());`,
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
        const surface = page.getByRole("region", { name: "터미널 출력" });
        const work = page.locator('[data-work-item="command"]');
        // The initial history read must not first expose the entire raw
        // transcript. Keep the real composer usable during that read.
        await surface
          .getByText(`${prompt} UNSENT DRAFT`, { exact: true })
          .waitFor();
        assert.equal(await surface.getByText(/OLD RAW DIFF/).count(), 0);
        assert.equal(await surface.getByText("대화를 불러오는 중…").count(), 1);
        await page.evaluate(() => (window as any).releaseHistory());
        await work.waitFor();
        await page.waitForTimeout(200);
        await page.evaluate(() => {
          (window as any).savedWork = document.querySelector(
            '[data-work-item="command"]',
          );
          (window as any).flashes = 0;
          (window as any).observer = new MutationObserver(() => {
            if (!document.querySelector('[data-work-item="command"]'))
              (window as any).flashes++;
          });
          (window as any).observer.observe(
            document.querySelector(".terminal-conversation")!,
            { subtree: true, childList: true },
          );
        });
        // No mouse or keyboard activity: the CLI clears and redraws its footer
        // in separate output chunks while history continues to poll.
        for (let cycle = 0; cycle < 4; cycle++) {
          await page.evaluate(() => {
            (window as any).refreshHistory();
            return (window as any).partial();
          });
          // SSH redraws can span much longer than the old 160ms grace. Also
          // refresh saved history while the native footer is still absent.
          await page.waitForTimeout(cycle === 0 ? 1000 : 240);
          await page.evaluate(() => (window as any).refreshHistory());
          await page.waitForTimeout(160);
          assert.equal(
            await work.count(),
            1,
            "a repaint fragment must keep the saved work mounted",
          );
          assert.equal(
            await page.evaluate(
              () =>
                (window as any).savedWork ===
                document.querySelector('[data-work-item="command"]'),
            ),
            true,
          );
          assert.notEqual(
            await page
              .locator(".terminal-conversation")
              .getAttribute("data-native-live"),
            null,
          );
          await page.evaluate(() => (window as any).footer());
          await page.waitForTimeout(80);
        }
        assert.equal(
          await page.evaluate(() => {
            (window as any).observer.disconnect();
            return (window as any).flashes;
          }),
          0,
          "no intermediate DOM update may flash the raw screen",
        );
        // A hook's waiting state is not evidence of an approval dialog. A
        // normal composer must keep the same saved work, even on a quiet CLI.
        await page.evaluate(() => (window as any).setWaiting());
        await page.waitForTimeout(300);
        assert.equal(
          await work.count(),
          1,
          "waiting with a composer stays typeset",
        );
        assert.equal(
          await page.evaluate(
            () =>
              (window as any).savedWork ===
              document.querySelector('[data-work-item="command"]'),
          ),
          true,
        );
        await page.evaluate(() => (window as any).setWaiting(false));
        // A real prompt echo must still appear immediately, without the repaint
        // grace period applying to ordinary text/cursor changes.
        await page.evaluate(
          (prompt) =>
            (window as any).write("\x1b[14;1H" + prompt + " FAST ECHO\x1b[K"),
          prompt,
        );
        await surface
          .getByText(`${prompt} FAST ECHO`, { exact: true })
          .waitFor();
        // Missing chrome may also mean a real permission dialog or a CLI exit.
        // Admit a persistent new surface even if it sends no further output.
        await page.evaluate(() => {
          (window as any).setWaiting();
          return (window as any).write(
            "\x1b[2J\x1b[HAllow running this command?\r\n❯ 1. Yes\r\n  2. No",
          );
        });
        await surface
          .getByText("Allow running this command?", { exact: true })
          .waitFor({ timeout: 1500 });
        await page.waitForFunction(
          () =>
            !document
              .querySelector(".terminal-conversation")
              ?.hasAttribute("data-native-live"),
          undefined,
          { timeout: 1500 },
        );
        assert.equal(
          await page
            .locator(".terminal-conversation")
            .getAttribute("data-native-live"),
          null,
        );
        await page.evaluate(() =>
          (window as any).write("\x1b[2J\x1b[HProcess exited.\r\n$ "),
        );
        await surface
          .getByText("Process exited.", { exact: true })
          .waitFor({ timeout: 1500 });
        assert.deepEqual(await page.evaluate(() => (window as any).inputs), []);
        assert.equal(
          await page.evaluate(() =>
            (window as any).requests.every((r: any) => r.method === "GET"),
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
