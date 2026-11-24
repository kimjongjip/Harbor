import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import { build } from "esbuild";
import { _electron } from "playwright";

test(
  "quota, context controls and background jobs stay scoped without rerendering typing",
  { skip: process.platform !== "win32", timeout: 60000 },
  async () => {
    const root = resolve(".cache/host-insights-browser-tests");
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "run-"));
    await build({
      stdin: {
        contents: `import React,{useState} from'react';import{createRoot}from'react-dom/client';import{AccountUsagePanel,CodexContextSettings,CodexSessionContext,TerminalWorkList}from'./src/client/HostInsights';import'./src/client/styles.css';import'./src/client/themes.css';window.renders=0;function Session(){const[windowSize,setWindowSize]=useState(258400);window.setWindowSize=setWindowSize;return <><span data-session-limit>{windowSize}</span><CodexSessionContext hostId="fixture" model="fixture-model" sessionWindow={windowSize} active/></>}function Fixture(){window.renders++;return <main style={{display:'grid',gridTemplateColumns:'290px 1fr 300px',gap:16,padding:16}}><aside><AccountUsagePanel hostId="fixture" hostName="테스트 서버"/></aside><div><textarea aria-label="작성 중 프롬프트" defaultValue="한글 English " style={{width:'100%',height:100}}/><CodexContextSettings hostId="fixture"/><Session/></div><aside><TerminalWorkList terminalId="terminal" active/></aside></main>}createRoot(document.getElementById('root')).render(<Fixture/>);`,
        resolveDir: process.cwd(),
        sourcefile: "insights-fixture.tsx",
        loader: "tsx",
      },
      bundle: true,
      format: "esm",
      outfile: join(dir, "fixture.js"),
      logLevel: "silent",
    });
    let context = {
      model: "fixture-model",
      current: 272000,
      maximum: 872000,
      usable: 258400,
      usablePercent: 95,
      compactAt: null as number | null,
      postTurnPercent: null as number | null,
    };
    const actions: string[] = [];
    let includeFable = true, staleClaude=false;
    const app = express();
    app.use(express.json());
    app.get("/api/hosts/fixture/account-usage", (_req, res) =>
      res.json({
        accounts: [
          {
            provider: "codex",
            plan: "Pro",
            account: "fixture@example.invalid",
            windows: [
              { label: "7일 한도", remaining: 75, resetsAt: 1900000000000 },
            ],
            updatedAt: Date.now(),
          },
          {
            provider: "claude",
            plan: "Max",
            windows: [
              { label: "7일 한도", remaining: 32, resetsAt:1900000000000 },
              ...(includeFable
                ? [{ label: "7일 Fable 한도", remaining: 1 }]
                : []),
            ],
            updatedAt: staleClaude? 1899990000000:Date.now(),
            ...(staleClaude?{stale:true,error:"Claude 요청 제한",retryAt:1900000000000}:{}),
          },
        ],
      }),
    );
    app.get("/api/hosts/fixture/antigravity-quota",(_req,res)=>res.json({provider:"antigravity",updatedAt:Date.now(),windows:[
      {label:"Gemini · 7일",remaining:85.67},{label:"Gemini · 5시간",remaining:95.1},{label:"Claude · GPT · 7일",remaining:100},{label:"Claude · GPT · 5시간",remaining:100}]}));
    app.get("/api/hosts/fixture/codex-context", (_req, res) =>
      res.json(context),
    );
    app.post("/api/hosts/fixture/codex-context", (req, res) => {
      actions.push(req.body.action);
      if (req.body.action === "expand") {
        context.current = 872000;
        context.usable = 828400;
      } else {
        context.compactAt = 784800;
        context.postTurnPercent = 85;
      }
      res.json(context);
    });
    app.get("/api/terminals/terminal/work", (_req, res) =>
      res.json({
        jobs: [
          {
            id: "sim",
            pid: 123,
            kind: "simulator",
            task: "ramulator · simulation.yaml",
            state: "running",
          },
          {
            id: "gpu",
            pid: 124,
            kind: "gpu",
            task: "python · train.py",
            memoryMiB: 4096,
            state: "running",
          },
          {
            id: "watch",
            pid: 125,
            kind: "monitor",
            task: "tail · experiment.log",
            state: "running",
          },
        ],
        updatedAt: Date.now(),
      }),
    );
    app.use(express.static(dir));
    app.get("/", (_req, res) =>
      res
        .type("html")
        .send(
          '<!doctype html><html lang="ko"><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>',
        ),
    );
    const server = createServer(app).listen(0, "127.0.0.1");
    await once(server, "listening");
    const main = join(dir, "electron.cjs");
    await writeFile(
      main,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(dir, "profile"))});app.commandLine.appendSwitch('disable-gpu');app.whenReady().then(()=>new BrowserWindow({show:false,width:1300,height:850,webPreferences:{contextIsolation:true,sandbox:true}}).loadURL('http://127.0.0.1:${(server.address() as any).port}/'));app.on('window-all-closed',()=>app.quit());`,
    );
    let desktop: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      desktop = await _electron.launch({
        args: [main],
        env: env as Record<string, string>,
      });
      const page = await desktop.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.getByText("75%", { exact: true }).waitFor();
      await page.getByText("tail · experiment.log", { exact: true }).waitFor();
      assert.equal(await page.locator("progress.critical").count(), 1);
      const panel = page.locator(".account-usage-panel");
      await panel.getByText("Antigravity",{exact:true}).waitFor();
      await panel.getByText("85.67%",{exact:true}).waitFor();
      assert.equal(
        Math.round((await panel.boundingBox())!.width),
        290,
        "quota fills sidebar width",
      );
      assert.ok(
        (await panel.boundingBox())!.height <= 165,
        "quota panel must leave room for servers",
      );
      const claude=panel.locator('[data-provider="claude"]');
      const weekly=claude.getByRole("progressbar",{name:"Claude 7일 한도 남은 비율"}), fable=claude.getByRole("progressbar",{name:"Claude 7일 Fable 한도 남은 비율"});
      const weekBox=await weekly.boundingBox(),fableBox=await fable.boundingBox();
      assert.ok(weekBox && fableBox && Math.abs(weekBox.y-fableBox.y)<2 && weekBox.x<fableBox.x,"weekly and Fable remain side by side");
      assert.equal(await panel.evaluate(el=>el.scrollHeight<=el.clientHeight+1),true,"all providers fit without inner scrolling");
      const box=await panel.boundingBox();
      console.log("Compact quota panel dimensions:",box!.width,box!.height);
      await panel.screenshot({path:join(dir,"compact-quota.png")});
      await claude.locator("summary").focus();await page.keyboard.press("Enter");
      await claude.getByText(/7일 한도.*초기화/).waitFor();
      await page.keyboard.press("Enter");
      await page.evaluate(()=>{document.querySelector("main")!.style.gridTemplateColumns="202px 1fr 300px";});
      await panel.screenshot({path:join(dir,"compact-quota-narrow.png")});
      assert.equal(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
      await page.evaluate(()=>{document.querySelector("main")!.style.gridTemplateColumns="290px 1fr 300px";});
      assert.equal(
        await panel.getByText("5시간 한도", { exact: true }).count(),
        0,
      );
      const refreshRequest = page.waitForRequest((r) =>
        r.url().endsWith("/account-usage?refresh=1"),
      );
      includeFable = false;
      await panel.getByRole("button", { name: /사용 한도 새로고침/ }).click();
      await refreshRequest;
      await panel.getByText("미제공", { exact: true }).waitFor();
      assert.equal(
        await panel.locator("progress").count(),
        6,
        "missing Fable must never show an invented percentage",
      );
      staleClaude = true;
      includeFable = true;
      await panel.getByRole("button", { name: /사용 한도 새로고침/ }).click();
      await claude.getByText("이전 수치", { exact: true }).waitFor();
      await claude.locator("summary").click();
      await claude.getByText(/Claude 요청 제한/).waitFor();
      await claude.getByText(/마지막 측정/).waitFor();
      assert.match(
        await page.locator(".terminal-work-list").innerText(),
        /4,096 MiB/,
      );
      const input = page.getByRole("textbox", { name: "작성 중 프롬프트" });
      await input.fill("typing 한글 123");
      await page.evaluate(() => {
        (window as any).inputNode = document.querySelector("textarea");
      });
      await page
        .getByRole("button", { name: "컨텍스트 최대 확장 · 872k" })
        .click();
      await page.getByText(/현재 872k \/ 지원 최대 872k/).waitFor();
      await page
        .locator(".codex-session-context")
        .getByText(/적용 대기/)
        .waitFor();
      assert.match(
        await page.locator(".codex-session-context").innerText(),
        /872k.*828.4k/,
      );
      assert.equal(
        await page.locator("[data-session-limit]").innerText(),
        "258400",
        "configuration must not invent a larger live session limit",
      );
      await page.evaluate(() => (window as any).setWindowSize(828400));
      await page.waitForFunction(
        () =>
          !document
            .querySelector(".codex-session-context")
            ?.textContent?.includes("적용 대기"),
      );
      await page.locator(".context-advanced > summary").click();
      await page
        .getByRole("button", { name: "사용량 기준 압축 설정", exact: true })
        .click();
      await page.getByText(/답변 후 압축: 85%/).waitFor();
      assert.deepEqual(actions, ["expand", "compact"]);
      assert.equal(await input.inputValue(), "typing 한글 123");
      assert.equal(
        await page.evaluate(
          () =>
            (window as any).inputNode === document.querySelector("textarea"),
        ),
        true,
      );
      assert.equal(await page.evaluate(() => (window as any).renders), 1);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: join(dir, "insights.png") });
    } finally {
      await desktop?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
