import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { _electron } from "playwright";

test(
  "restored draft policy waits for its own worker capability and cannot silently send with the switch off",
  { skip: process.platform !== "win32", timeout: 90000 },
  async () => {
    const root = resolve(".cache/chat-worker-capabilities");
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "run-"));
    await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: "tsx",
        contents: `
 import React from 'react';import {createRoot} from 'react-dom/client';
 import Panel from './src/client/ide/IdeChatPanel';
 import {writeManagedTabs} from './src/client/ide/managed-tab-storage';
 import {writeManagedTabDraft} from './src/client/ide/managed-tab-drafts';
 const root=createRoot(document.getElementById('root'));
 const json=(x,s=200)=>new Response(JSON.stringify(x),{status:s});
 const models=[{id:'A',name:'A',efforts:['high'],isDefault:true}];
 window.posts=[];window.fallbackCalls=0;
 const fallback=async p=>{if(p.includes('/models?')){window.fallbackCalls++;return json({models,supportsAutoAccept:true});}return json({});};
 window.fetch=async(raw,opts={})=>{
   const url=new URL(raw,'https://fixture.invalid'),p=url.pathname,b=opts.body?JSON.parse(opts.body):null;
   if(p.endsWith('/workspace-update'))return window.mode==='no-route'
     ? json({phase:'pending',targetVersion:'2.0.7',runningVersion:'2.0.0',stagedVersion:'2.0.7'})
     : json({},404);
   if(window.staleId && !b && p.endsWith('/conversations/'+window.staleId))return json({error:'Saved handle expired'},404);
   if(p.endsWith('/models')){return new Promise(r=>{window.release=()=>r(window.mode==='no-route'?json({},404):json(window.mode==='bare'?{models}:{models,supportsAutoAccept:true}));});}
   if(p.endsWith('/folders'))return json({path:'/fixture',parent:'/',folders:[],truncated:false});
   if(b)window.posts.push({p,b});
   if(p.endsWith('/conversations')){window.c={hostId:'fixture',id:b.resumeId?'new-handle':'fake-'+window.mode,provider:b.provider,nativeId:b.resumeId||'thread-'+window.mode,runtimeId:b.resumeId?'new-runtime':'fake-runtime',title:'fixture',cwd:'/fixture',model:'A',status:'idle',items:[],approvals:[],historyCursor:null,revision:1,updatedAt:1,autoAccept:b.autoAccept??false};return json(window.c);}
   if(p.endsWith('/messages'))return json({ok:true,status:'submitted',requestId:b.requestId});
   if(p.endsWith('/usage'))return json({usage:null,work:null});
   return json(window.c||{});
 };
 window.start=mode=>{
   window.mode=mode;window.posts=[];window.release=undefined;window.c=undefined;window.fallbackCalls=0;
   const scope='chat-window.fixture-'+mode,area=JSON.stringify([scope,'durable:fixture']);
   writeManagedTabs(area,{selected:'draft',tabs:[{key:'draft',provider:'codex',autoAccept:true}]});
   writeManagedTabDraft(area,'draft','유지할 예약 초안');
   root.render(<Panel key={mode} active hostId="fixture" serverWorkspace presentation="terminal" rememberScope={scope} request={fallback}/>);
 };
 `,
      },
      jsx: "automatic",
      platform: "browser",
      target: "es2022",
      bundle: true,
      outfile: join(dir, "fixture.js"),
      loader: {
        ".css": "empty",
        ".woff2": "empty",
        ".woff": "empty",
        ".ttf": "empty",
        ".svg": "empty",
      },
      logLevel: "silent",
    });
    await writeFile(
      join(dir, "index.html"),
      '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="./fixture.js"></script>',
    );
    const main = join(dir, "electron.cjs");
    await writeFile(
      main,
      `const{app,BrowserWindow}=require("electron");app.setPath("userData",${JSON.stringify(join(dir, "profile"))});app.whenReady().then(()=>new BrowserWindow({show:false,width:900,height:740,webPreferences:{sandbox:true}}).loadFile(${JSON.stringify(join(dir, "index.html"))}));`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({
      args: [main],
      env: env as Record<string, string>,
    });
    try {
      const page = await app.firstWindow(),
        send = page.getByRole("button", {
          name: "AI 메시지 전송",
          exact: true,
        }),
        draft = page.getByLabel("AI에게 보낼 메시지");
      await page.waitForFunction(
        () => typeof (window as any).start === "function",
      );
      for (const mode of ["bare", "no-route", "capable"]) {
        await page.evaluate((mode) => (window as any).start(mode), mode);
        await page.waitForFunction(
          () => typeof (window as any).release === "function",
        );
        assert.equal(await draft.inputValue(), "유지할 예약 초안");
        await send.click();
        assert.equal(
          await page.evaluate(() => (window as any).posts.length),
          0,
        );
        await page.evaluate(() => (window as any).release());
        await page
          .getByRole("button", { name: "모델·추론 강도·권한 설정" })
          .click();
        const dialog = page.getByRole("dialog");
        if (mode === "capable") {
          const toggle = dialog.getByRole("switch", {
            name: "Harbor 자동 수락",
          });
          await toggle.waitFor();
          assert.equal(await toggle.getAttribute("aria-checked"), "true");
        } else {
          await dialog
            .getByText(mode==="no-route" ? "업데이트 적용 후 사용" : "서버 업데이트 필요", { exact: true })
            .waitFor();
          assert.equal(await dialog.getByRole("switch").count(), 0);
          if (mode === "no-route") {
            await dialog.getByText("서버 2.0.0 · PC 2.0.7").waitFor();
            await dialog.getByText(/열린 터미널과 AI 프로세스/).waitFor();
          }
          assert.equal(
            await page.evaluate(() => (window as any).fallbackCalls),
            mode === "no-route" ? 1 : 0,
          );
          await dialog
            .getByRole("button", { name: "닫기", exact: true })
            .click();
          await send.click();
          assert.equal(
            await page.evaluate(() => (window as any).posts.length),
            0,
          );
          assert.equal(await draft.inputValue(), "유지할 예약 초안");
          await page
            .getByRole("button", { name: "모델·추론 강도·권한 설정" })
            .click();
          await dialog.getByRole("button", { name: "예약 해제" }).click();
        }
        await dialog.getByRole("button", { name: "닫기", exact: true }).click();
        await send.click();
        await page.waitForFunction(() =>
          (window as any).posts.some((p: any) => p.p.endsWith("/messages")),
        );
        const posts = await page.evaluate(() => (window as any).posts);
        assert.equal(
          posts.find((p: any) => p.p.endsWith("/conversations")).b.autoAccept,
          mode === "capable" ? true : undefined,
        );
        assert.equal(
          posts.filter((p: any) => p.p.endsWith("/messages")).length,
          1,
        );
      }
      await draft.fill("서버를 업데이트하는 동안 쓰던 초안");
      await page.evaluate(() => {
        const fixture = window as any;
        fixture.staleId = fixture.c.id;
        fixture.posts = [];
      });
      const reconnect = page.getByRole("button", { name: "이 대화 다시 연결" });
      await reconnect.waitFor();
      assert.equal(await send.isDisabled(), true);
      assert.equal(await page.evaluate(() => (window as any).posts.length), 0);
      await reconnect.click();
      await reconnect.waitFor({ state: "hidden" });
      assert.equal(await draft.inputValue(), "서버를 업데이트하는 동안 쓰던 초안");
      assert.equal(await send.isEnabled(), true);
      const requests = await page.evaluate(() => (window as any).posts);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].b.resumeId, "thread-capable");
      assert.equal(requests[0].b.autoAccept, undefined);
    } finally {
      await app.close();
    }
  },
);
