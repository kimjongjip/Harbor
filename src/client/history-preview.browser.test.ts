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
  "history opens newest question/answer first without resuming, pages older turns and preserves explicit SSH actions",
  { skip: process.platform !== "win32", timeout: 90000 },
  async () => {
    const root = resolve(".cache/history-preview-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    await build({
      stdin: {
        contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';
import './src/client/styles.css';import './src/client/themes.css';
import CodexHistory from'./src/client/CodexHistory';
localStorage.setItem('harbor-history-expanded-claude','true');
localStorage.setItem('harbor-history-expanded-codex','true');
window.historyRequests=[];window.resumed=[];window.historyDrops=[];
window.addEventListener('harbor-history-drop',event=>window.historyDrops.push(event.detail));
const thread=hostId=>({id:'same-native-id',hostId,title:hostId==='remote'?'Investigate task':'Local task',preview:'Initial task description',cwd:'/home/fixture/project',updatedAt:hostId==='remote'?2000:1000,source:'cli',active:false});
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
window.fetch=async(input,options={})=>{const url=new URL(String(input),location.href),cursor=url.searchParams.get('cursor'),provider=url.searchParams.get('provider'),hostId=url.pathname.split('/')[3];
window.historyRequests.push({path:url.pathname,cursor,provider,includeActivity:url.searchParams.get('includeActivity'),method:options.method,body:options.body?JSON.parse(options.body):null});
if(url.pathname.includes('/activity/')){const text='Ran rg --files\\nFIRST ORIGINAL TOOL LINE\\nSECOND ORIGINAL TOOL LINE\\nLAST ORIGINAL TOOL LINE',offset=Number(url.searchParams.get('offset')||0),end=Math.min(offset+48,text.length);return response({text:text.slice(offset,end),offset,nextOffset:end<text.length?end:null,total:text.length});}
if(url.pathname.endsWith('/resume'))return response({id:'resumed-terminal',hostId});
if(url.pathname.endsWith('/history'))return response({data:[thread(hostId)],nextCursor:null});
const base={thread:thread(hostId),items:[],nextCursor:null};
if(hostId==='local')return response({...base,items:[{id:'local-q',kind:'user',text:'LOCAL QUESTION'}]});
if(provider==='codex')return response({...base,items:[{id:'codex-q',kind:'user',text:'CODEX QUESTION'},{id:'codex-a',kind:'assistant',text:'CODEX ANSWER'}]});
if(!cursor)return response({...base,nextCursor:'latest-bounded-page'});
if(cursor==='latest-bounded-page')return response({...base,items:[{id:'q2',kind:'user',text:'PREVIOUS QUESTION'},{id:'a2',kind:'assistant',text:'PREVIOUS COMPLETE ANSWER'},{id:'q3',kind:'user',text:'LATEST QUESTION'},{id:'a3',kind:'assistant',text:'LATEST COMPLETE ANSWER'+('\\n\\nMore explanation to exercise a long readable conversation.').repeat(22)}],activity:[{id:'old-work',kind:'tool',text:'Interacted with peer',detail:'ORIGINAL PEER RESULT\\nUnmodified historical output',turnStatus:'unknown'},{id:'new-work',kind:'command',text:'Ran rg --files',detail:'FIRST ORIGINAL TOOL',activityRef:'a'.repeat(64),activityTruncated:true}],timelineIds:['user:q2','tool:old-work','assistant:a2','user:q3','command:new-work','assistant:a3'],nextCursor:'older-page'});
if(cursor==='older-page')return response({...base,items:[{id:'q1',kind:'user',text:'EARLIEST QUESTION'},{id:'a1',kind:'assistant',text:'EARLIEST ANSWER'},{id:'a3',kind:'assistant',text:'STALE PARTIAL ANSWER'}]});
throw Error('Unexpected request '+url);};
const hosts=[{id:'remote',name:'Fixture remote',kind:'ssh',status:'connected'},{id:'local',name:'Fixture local',kind:'local',status:'connected'}];
function Fixture(){const[provider,setProvider]=useState('claude');window.setHistoryProvider=setProvider;return <div style={{width:350,height:740,display:'flex'}}><CodexHistory hosts={hosts} provider={provider} onResume={terminal=>window.resumed.push(terminal)} onConnect={()=>{throw Error('Unexpected connection')}}/></div>;}
createRoot(document.getElementById('root')).render(<Fixture/>);`,
        resolveDir: process.cwd(),
        sourcefile: "history-preview-fixture.tsx",
        loader: "tsx",
      },
      bundle: true,
      outfile: join(directory, "fixture.js"),
      format: "esm",
      logLevel: "silent",
      loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
    });
    const serverApp = express();
    serverApp.use(express.static(directory));
    serverApp.get("/", (_req, res) =>
      res
        .type("html")
        .send(
          '<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
        ),
    );
    const server = createServer(serverApp);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const main = join(directory, "electron.cjs");
    await writeFile(
      main,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.commandLine.appendSwitch('disable-gpu');app.whenReady().then(()=>{new BrowserWindow({show:false,width:1050,height:850,webPreferences:{backgroundThrottling:false,contextIsolation:true,sandbox:true}}).loadURL('http://127.0.0.1:${port}/');});app.on('window-all-closed',()=>app.quit());`,
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
        .locator(".history-row-main")
        .filter({ hasText: "Investigate task" })
        .click();
      await page.locator('[data-history-message="a3"]').waitFor();
      const transcriptOrder = () =>
        page
          .locator("[data-history-message], [data-work-item]")
          .evaluateAll((elements) =>
            elements.map(
              (element) =>
                element.getAttribute("data-history-message") ||
                element.getAttribute("data-work-item"),
            ),
          );
      assert.deepEqual(await transcriptOrder(), [
        "q3",
        "new-work",
        "a3",
        "q2",
        "old-work",
        "a2",
      ]);
      assert.equal(
        (await page.locator(".history-recent-question").innerText()).replace(
          /\s+/g,
          " ",
        ),
        "최근 질문 LATEST QUESTION",
      );
      assert.equal(
        await page
          .locator(".history-transcript")
          .evaluate((element) => element.scrollTop),
        0,
      );
      assert.equal(
        await page.evaluate(() =>
          (window as any).historyRequests.some(
            (request: any) => request.method !== "GET",
          ),
        ),
        false,
      );
      assert.deepEqual(
        await page.evaluate(() => (window as any).historyDrops),
        [],
      );
      assert.deepEqual(await page.evaluate(() => (window as any).resumed), []);
      assert.equal(
        await page.evaluate(() =>
          (window as any).historyRequests
            .filter((request: any) =>
              /\/history\/same-native-id$/.test(request.path),
            )
            .every((request: any) => request.includeActivity === "1"),
        ),
        true,
      );
      // Old work records are independently foldable without completion metadata.
      const historicalWork = page.locator('[data-work-item="old-work"]');
      assert.equal(
        await historicalWork.evaluate(
          (element) => (element as HTMLDetailsElement).open,
        ),
        false,
      );
      await historicalWork.locator("summary").click();
      // A CLI-like step: the record names the step, its output stays verbatim.
      assert.equal(
        await historicalWork.locator(".transcript-step-title").innerText(),
        "Interacted with peer",
      );
      assert.equal(
        await historicalWork.locator("pre").innerText(),
        "ORIGINAL PEER RESULT\nUnmodified historical output",
      );
      await historicalWork.locator("summary").focus();
      await page.keyboard.press("Enter");
      assert.equal(
        await historicalWork.evaluate(
          (element) => (element as HTMLDetailsElement).open,
        ),
        false,
      );
      // Long work bodies are fetched only when expanded, as exact chunks.
      const latestWork = page.locator('[data-work-item="new-work"]');
      assert.equal(
        await page.evaluate(() =>
          (window as any).historyRequests.some((request: any) =>
            request.path.includes("/activity/"),
          ),
        ),
        false,
      );
      await latestWork.locator("summary").click();
      await latestWork
        .getByRole("button", { name: "원문 더 보기", exact: true })
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector('[data-work-item="new-work"] pre')
          ?.textContent?.endsWith("LAST ORIGINAL TOOL LINE"),
      );
      assert.equal(
        await latestWork.locator("pre").innerText(),
        "FIRST ORIGINAL TOOL LINE\nSECOND ORIGINAL TOOL LINE\nLAST ORIGINAL TOOL LINE",
      );
      assert.ok(
        (await latestWork.locator("summary").innerText()).includes(
          "Ran rg --files",
        ),
      );
      await latestWork.locator("summary").click();
      await page
        .locator(".history-transcript")
        .evaluate((element) => (element.scrollTop = 0));
      await page.screenshot({ path: join(root, "latest-preview.png") });
      // A single browser selection can cross user, answer and another turn;
      // scrolling the shared container must not reset it.
      const selectedText = await page.evaluate(() => {
        const first = document.querySelector(
          '[data-history-message="q3"] .conversation-question',
        )!;
        const last = document.querySelector(
          '[data-history-message="a2"] .markdown',
        )!;
        const range = document.createRange();
        range.setStartBefore(first);
        range.setEndAfter(last);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        return selection.toString();
      });
      assert.ok(
        selectedText.includes("LATEST QUESTION") &&
          selectedText.includes("PREVIOUS COMPLETE ANSWER"),
      );
      const copiedText = await page.evaluate(() => {
        const transfer = new DataTransfer();
        document
          .querySelector(".history-transcript")!
          .dispatchEvent(
            new ClipboardEvent("copy", {
              bubbles: true,
              cancelable: true,
              clipboardData: transfer,
            }),
          );
        return transfer.getData("text/plain");
      });
      assert.ok(
        copiedText.includes("LATEST QUESTION") &&
          copiedText.includes("PREVIOUS COMPLETE ANSWER"),
      );
      assert.equal(
        copiedText.includes("ORIGINAL TOOL LINE") ||
          copiedText.includes("ORIGINAL PEER RESULT"),
        false,
      );
      await page.locator(".history-transcript").hover();
      await page.mouse.wheel(0, 350);
      await page.waitForFunction(
        () => document.querySelector(".history-transcript")!.scrollTop > 0,
      );
      assert.equal(
        await page.evaluate(() => window.getSelection()?.toString()),
        selectedText,
      );
      await page
        .getByRole("button", { name: "이전 대화 더 읽기", exact: true })
        .click();
      await page.locator('[data-history-message="a1"]').waitFor();
      assert.deepEqual(await transcriptOrder(), [
        "q3",
        "new-work",
        "a3",
        "q2",
        "old-work",
        "a2",
        "q1",
        "a1",
      ]);
      assert.equal(
        await page.getByText("STALE PARTIAL ANSWER", { exact: true }).count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "이전 대화 더 읽기", exact: true })
          .count(),
        0,
      );
      await page.getByRole("button", { name: "창 닫기", exact: true }).click();
      assert.equal(
        await page
          .locator(".history-row-preview")
          .filter({ hasText: "최근 질문 · LATEST QUESTION" })
          .count(),
        1,
      );
      // Same native ID on a different host must stay a different conversation.
      await page
        .locator(".history-row-main")
        .filter({ hasText: "Local task" })
        .click();
      await page.getByText("LOCAL QUESTION", { exact: true }).last().waitFor();
      assert.equal(
        await page.locator('[data-history-message="a3"]').count(),
        0,
      );
      assert.equal(
        await page.getByRole("dialog").getByRole("combobox").count(),
        0,
      );
      await page.getByRole("button", { name: "창 닫기", exact: true }).click();
      await page
        .locator(".history-row-main")
        .filter({ hasText: "Investigate task" })
        .click();
      await page.locator('[data-history-message="a3"]').waitFor();
      await page.getByRole("dialog").getByRole("combobox").selectOption("tmux");
      await page
        .getByRole("button", { name: "옆에 열기", exact: true })
        .click();
      assert.deepEqual(
        await page.evaluate(() => (window as any).historyDrops),
        [
          {
            hostId: "remote",
            threadId: "same-native-id",
            provider: "claude",
            sshSessionMode: "tmux",
            edge: "right",
            scope: "pane",
          },
        ],
      );
      await page
        .locator(".history-row-main")
        .filter({ hasText: "Investigate task" })
        .click();
      await page.locator('[data-history-message="a3"]').waitFor();
      await page
        .getByRole("button", { name: "터미널에서 이어가기", exact: true })
        .click();
      await page.waitForFunction(() => (window as any).resumed.length === 1);
      const resume = await page.evaluate(() =>
        (window as any).historyRequests.find((request: any) =>
          request.path.endsWith("/resume"),
        ),
      );
      assert.equal(
        resume.path,
        "/api/hosts/remote/history/same-native-id/resume",
      );
      assert.equal(resume.body.provider, "claude");
      assert.equal(resume.body.sshSessionMode, "tmux");
      await page.evaluate(() => (window as any).setHistoryProvider("codex"));
      await page.waitForFunction(() =>
        (window as any).historyRequests.some(
          (request: any) =>
            request.provider === "codex" && request.path.endsWith("/history"),
        ),
      );
      await page
        .locator(".history-row-main")
        .filter({ hasText: "Investigate task" })
        .click();
      await page.locator('[data-history-message="codex-a"]').waitFor();
      assert.equal(
        await page.getByRole("dialog").getByRole("combobox").inputValue(),
        "direct",
      );
      assert.equal(
        await page.locator('[data-history-message="a3"]').count(),
        0,
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
