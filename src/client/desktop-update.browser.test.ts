import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import { build } from "esbuild";
import { _electron } from "playwright";
test(
  "manual update is explicit, reports preparation and protects drafts; SSH dialogs default to tmux",
  { skip: process.platform !== "win32", timeout: 60000 },
  async () => {
    const root = resolve(".cache/desktop-update-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    await build({
      stdin: {
        contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{UpdateButton}from'./src/client/UpdateButton';import{NewTerminalDialog}from'./src/client/TerminalWorkspace';import'./src/client/styles.css';import'./src/client/themes.css';
window.actions=[];let listener;let state={phase:'idle',currentVersion:'1.0.0'};window.emit=v=>{state={...state,...v};listener?.(state)};
window.harborDesktop={version:'1.0.0',updateState:async()=>state,onUpdateState:fn=>{listener=fn;return()=>listener=undefined},checkUpdate:async()=>{window.actions.push('check');window.emit({phase:window.pcCurrent?'current':'available',version:window.pcCurrent?'1.0.0':'2.0.0',notes:'## 2.0.0\\n- Example fix'});return state},installUpdate:async()=>{window.actions.push('install');window.emit({phase:'preparing',step:'building'});return state},restartUpdate:async()=>{window.actions.push('restart');window.emit({phase:'restarting'});return state}};
function Fixture(){const[open,setOpen]=useState(false);return <><textarea aria-label="unsent draft" defaultValue="keep my draft"/><UpdateButton sshHosts={[{id:"one",name:"One"},{id:"two",name:"Two"}]} onSetup={id=>window.setup=id}/><button onClick={()=>setOpen(true)}>새 터미널 테스트</button>{open&&<NewTerminalDialog hosts={[{id:'remote',kind:'ssh',name:'Fixture SSH',address:'fixture.invalid'},{id:'local',kind:'local',name:'Fixture local'}]} initialHostId="remote" credentialStorageAvailable={false} onClose={()=>setOpen(false)} onCreated={()=>{}}/>}</>};createRoot(document.getElementById('root')).render(<Fixture/>);`,
        resolveDir: process.cwd(),
        loader: "tsx",
        sourcefile: "update-fixture.tsx",
      },
      bundle: true,
      format: "esm",
      outfile: join(directory, "fixture.js"),
      logLevel: "silent",
      loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
    });
    const app = express();
    app.use(express.json());
    let handoff = "";
    let enrolled = true;
    let synchronize = 0;
    const applied: string[] = [];
    const snapshot = () => ({
      handoff, targetVersion: "1.0.0",
      hosts: (enrolled ? ["alpha", "beta"] : []).map(id => ({
        id, name: id, targetVersion: "1.0.0", stagedVersion: "1.0.0",
        runningVersion: applied.includes(id) ? "1.0.0" : "0.9.0",
        phase: applied.includes(id) ? "current" : "pending",
      })),
    });
    app.get("/api/update/workspaces", (_req, res) => res.json(snapshot()));
    app.post("/api/update/workspaces", (_req, res) => {
      synchronize++;
      res.json(snapshot());
    });
    app.post("/api/hosts/:id/server-workspace/apply", (req, res) => {
      assert.deepEqual(req.body, {runningVersion:"0.9.0", stagedVersion:"1.0.0", confirmStop:true});
      applied.push(req.params.id);
      res.json({ok:true});
    });
    app.use(express.static(directory));
    app.get("/", (_req, res) =>
      res
        .type("html")
        .send(
          '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script></html>',
        ),
    );
    const server = createServer(app).listen(0, "127.0.0.1");
    await once(server, "listening");
    const main = join(directory, "electron.cjs");
    await writeFile(
      main,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:900}).loadURL('http://127.0.0.1:${(server.address() as any).port}'));app.on('window-all-closed',()=>app.quit());`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const desktop = await _electron.launch({
      args: [main],
      env: env as Record<string, string>,
    });
    try {
      const page = await desktop.firstWindow();
      await page
        .getByRole("button", { name: "Harbor 업데이트", exact: true })
        .waitFor();
      assert.deepEqual(await page.evaluate(() => (window as any).actions), []);
      await page
        .getByRole("button", { name: "Harbor 업데이트", exact: true })
        .click();
      await page.getByText("변경 내역", { exact: true }).click();
      await page.getByText("Example fix", { exact: true }).waitFor();
      await page.getByText("alpha", {exact:true}).waitFor();
      assert.equal(synchronize, 0, "a newer PC release is staged before servers are updated");
      await page.screenshot({ path: join(directory, "update-ready.png") });
      assert.deepEqual(await page.evaluate(() => (window as any).actions), [
        "check",
      ]);
      await page
        .getByRole("button", { name: "PC·서버 업데이트", exact: true })
        .click();
      await page
        .getByRole("status")
        .getByText("새 버전 준비 중", { exact: true })
        .waitFor();
      await page.evaluate(() =>
        (window as any).emit({
          phase: "ready",
          error: "IDE 편집 내용을 저장한 뒤 다시 시작을 눌러주세요.",
        }),
      );
      await page.getByRole("alert").waitFor();
      assert.equal(
        await page.getByRole("textbox", { name: "unsent draft" }).inputValue(),
        "keep my draft",
      );
      assert.deepEqual(await page.evaluate(() => (window as any).actions), [
        "check",
        "install",
      ]);
      await page
        .getByRole("button", { name: "다시 시작", exact: true })
        .click();
      assert.deepEqual(await page.evaluate(() => (window as any).actions), [
        "check",
        "install",
        "restart",
      ]);
      await page.evaluate(() =>
        (window as any).emit({ phase: "current", error: undefined }),
      );
      await page.getByRole("button", { name: "닫기", exact: true }).click();
      await page.evaluate(() => { (window as any).pcCurrent = true; });
      await Promise.all([
        page.waitForResponse(r => r.request().method()==="POST" && r.url().endsWith("/api/update/workspaces")),
        page.getByRole("button", {name:"Harbor 업데이트", exact:true}).click(),
      ]);
      assert.equal(synchronize,1,"the current PC must still update enrolled servers");
      const apply = page.getByRole("button",{name:"대기 중인 서버 지금 적용"});
      await apply.click();
      await page.getByRole("button",{name:"취소",exact:true}).click();
      assert.deepEqual(applied,[]);
      await apply.click();
      await page.getByRole("button",{name:"작업 중단 후 서버 재시작"}).click();
      await page.waitForFunction(()=>document.querySelectorAll(".desktop-update-phase[data-phase=current]").length===2);
      assert.deepEqual(applied,["alpha","beta"]);
      await page.getByRole("button", { name: "닫기", exact: true }).click();
      await page
        .getByRole("button", { name: "새 터미널 테스트", exact: true })
        .click();
      assert.equal(
        await page
          .getByRole("combobox", { name: "SSH 세션 방식", exact: true })
          .inputValue(),
        "tmux",
      );
      await page
        .getByRole("combobox", { name: "SSH 세션 방식", exact: true })
        .selectOption("direct");
      await page
        .getByRole("combobox", { name: "서버", exact: true })
        .selectOption("local");
      assert.equal(
        await page
          .getByRole("combobox", { name: "SSH 세션 방식", exact: true })
          .count(),
        0,
      );
      await page
        .getByRole("combobox", { name: "서버", exact: true })
        .selectOption("remote");
      assert.equal(
        await page
          .getByRole("combobox", { name: "SSH 세션 방식", exact: true })
          .inputValue(),
        "tmux",
      );
      await page.screenshot({ path: join(directory, "tmux-default.png") });
      handoff = "a".repeat(40);
      await page.reload();
      await page.getByRole("dialog", {name:"Harbor 업데이트"}).waitFor();
      await page.getByText("alpha",{exact:true}).waitFor();
      assert.deepEqual(await page.evaluate(()=>(window as any).actions),[]);
      await page.getByRole("button", { name: "닫기", exact: true }).click();
      enrolled = false;
      await page.getByRole("button", {name:"Harbor 업데이트", exact:true}).click();
      await page.getByLabel("작업 공간을 설정할 SSH 서버").selectOption("two");
      await page.getByRole("button", {name:"서버 작업 공간 설정", exact:true}).click();
      assert.equal(await page.evaluate(()=>(window as any).setup),"two");
    } finally {
      await desktop.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
);
