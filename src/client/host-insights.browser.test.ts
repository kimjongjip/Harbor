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
    let includeFable = true;
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
              { label: "7일 한도", remaining: 32 },
              ...(includeFable
                ? [{ label: "7일 Fable 한도", remaining: 1 }]
                : []),
            ],
            updatedAt: Date.now(),
          },
        ],
      }),
    );
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
      await page.getByText("75% 남음", { exact: true }).waitFor();
      await page.getByText("tail · experiment.log", { exact: true }).waitFor();
      assert.equal(await page.locator("progress.critical").count(), 1);
      const panel = page.locator(".account-usage-panel");
      assert.equal(
        Math.round((await panel.boundingBox())!.width),
        290,
        "quota fills sidebar width",
      );
      assert.ok(
        (await panel.boundingBox())!.height < 260,
        "quota panel must leave room for servers",
      );
      await panel.getByText("7일 Fable 한도", { exact: true }).waitFor();
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
        2,
        "missing Fable must never show an invented percentage",
      );
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
        .getByText(/현재 세션에 적용 대기/)
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
