import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { build } from "esbuild";
import { _electron } from "playwright";

test(
  "Harbor's right status panel keeps input and parent renders stable, collapses without remounting, and rejects stale usage",
  { skip: process.platform !== "win32", timeout: 60000 },
  async () => {
    const root = resolve(".cache/terminal-usage-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    const first = "11111111-2222-4333-8444-555555555555",
      second = "22222222-2222-4333-8444-555555555555";
    await build({
      stdin: {
        contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{TerminalUsageBar}from'./src/client/TerminalUsageBar';import'./src/client/terminal-layout.css';
window.renders=0;window.visibility='visible';Object.defineProperty(document,'visibilityState',{get:()=>window.visibility});
function App(){window.renders++;const[session,setSession]=useState('${first}'),[active,setActive]=useState(true);window.setSession=setSession;window.setActive=setActive;return <main className="terminal-instance terminal-with-footer active" style={{height:'100vh'}}><div className="terminal-surface"><div className="terminal-mount" style={{position:'relative',padding:16}}><h3>Harbor</h3><p>Claude · Codex 공통 상태 표시</p><textarea aria-label="입력" defaultValue="작성 중인 프롬프트" style={{width:'100%',height:90,boxSizing:'border-box'}}/><p>/ 명령 목록을 열어도 오른쪽 패널을 유지합니다.</p></div><TerminalUsageBar terminalId="fixture" hostId="fixture" provider="claude" sessionId={session} active={active} working={true}/></div><div className="terminal-footer">세션 연결됨</div></main>}createRoot(document.getElementById('root')).render(<App/>);`,
        resolveDir: process.cwd(),
        sourcefile: "usage-fixture.tsx",
        loader: "tsx",
      },
      bundle: true,
      outfile: join(directory, "fixture.js"),
      format: "esm",
      logLevel: "silent",
    });
    let reads = 0,
      used = 42000,
      hold = false,
      partial = false,
      nativeCache = false,
      release: (() => void) | undefined;
    const app = express();
    app.get("/api/terminals/fixture/usage", (req, res) => {
      reads++;
      const usage = {
        provider: "claude",
        sessionId: req.query.sessionId,
        usedTokens: used,
        contextWindow: partial ? null : 1000000,
        usedPercent: partial ? null : used / 10000,
        costUsd: partial ? null : 3.25,
        updatedAt: Date.now(),
        source: partial ? "history" : "native",
      };
      if (hold && req.query.sessionId === first) {
        hold = false;
        release = () => res.json({ usage });
      } else res.json({ usage: req.query.sessionId === first ? usage : null });
    });
    app.get("/api/hosts/fixture/files/preview", (_req, res) =>
      res.json({
        kind: "text",
        text: nativeCache
          ? JSON.stringify({
              session_id: first,
              harbor_updated_at: Date.now() + 1,
              model: { id: "claude-opus-5-5" },
              context_window: {
                context_window_size: 1000000,
                current_usage: { input_tokens: 51000 },
              },
              cost: { total_cost_usd: 47.8 },
            })
          : '{"partial":',
      }),
    );
    app.use(express.static(directory));
    app.get("/", (_req, res) =>
      res
        .type("html")
        .send(
          '<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"><style>:root{--border:#dce1e9;--muted:#667184;--text:#273247;--panel:#f4f6f9;--ui-font-size:14px}body{margin:0;font-family:Arial,sans-serif;background:white;color:var(--text)}h3{margin-top:0}textarea{font:inherit}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
        ),
    );
    const server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const main = join(directory, "electron.cjs");
    await writeFile(
      main,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.commandLine.appendSwitch('disable-gpu');app.whenReady().then(()=>new BrowserWindow({show:false,width:850,height:400,webPreferences:{backgroundThrottling:false,contextIsolation:true,sandbox:true}}).loadURL('http://127.0.0.1:${(server.address() as any).port}/'));app.on('window-all-closed',()=>app.quit());`,
    );
    let desktop: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (v): v is [string, string] => v[1] !== undefined,
        ),
      );
      delete env.ELECTRON_RUN_AS_NODE;
      desktop = await _electron.launch({ args: [main], env });
      const page = await desktop.firstWindow(),
        errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.waitForFunction(
        () =>
          document.querySelector(".terminal-usage-tokens")?.textContent ===
          "42k/1M",
      );
      assert.equal(
        await page.locator(".terminal-usage-percent").innerText(),
        "약 4%",
      );
      assert.match(
        await page.locator(".terminal-usage-cost").innerText(),
        /\$3\.25/,
      );
      assert.ok(
        await page.evaluate(() => {
          const terminal = document
              .querySelector(".terminal-mount")!
              .getBoundingClientRect(),
            panel = document
              .querySelector(".terminal-usage")!
              .getBoundingClientRect();
          return (
            terminal.right <= panel.left + 1 &&
            Math.abs(terminal.top - panel.top) < 1
          );
        }),
        "usage is a right column, never a bottom row or an overlay",
      );
      const renders = await page.evaluate(() => (window as any).renders);
      await page.getByRole("textbox").fill("한글 English 즉시 입력 /");
      await page.evaluate(
        () => ((window as any).inputNode = document.querySelector("textarea")),
      );
      await page.getByRole("button", { name: "상태 패널 접기" }).click();
      assert.ok(
        (await page.locator(".terminal-usage").boundingBox())!.width <= 36,
      );
      await page.getByRole("button", { name: "상태 패널 펼치기" }).click();
      assert.equal(
        await page.evaluate(
          () =>
            (window as any).inputNode === document.querySelector("textarea"),
        ),
        true,
      );
      used = 780000;
      await page.waitForFunction(
        () =>
          document.querySelector(".terminal-usage-percent")?.textContent ===
          "약 78%",
      );
      assert.equal(
        await page.evaluate(() => (window as any).renders),
        renders,
        "usage ticks do not render the parent/transcript",
      );
      assert.equal(
        await page.getByRole("textbox").inputValue(),
        "한글 English 즉시 입력 /",
      );
      assert.equal(
        await page.locator(".terminal-usage-meter.warning").count(),
        1,
      );
      const warning = await page
        .locator(".terminal-usage-percent")
        .evaluate((e) => getComputedStyle(e).color);
      used = 910000;
      await page.waitForFunction(() =>
        document.querySelector(".terminal-usage-meter.critical"),
      );
      assert.match(
        await page.locator(".terminal-usage-remaining").innerText(),
        /압축 권장/,
      );
      assert.notEqual(
        await page
          .locator(".terminal-usage-percent")
          .evaluate((e) => getComputedStyle(e).color),
        warning,
      );
      used = 42000;
      await page.waitForFunction(
        () =>
          document.querySelector(".terminal-usage-tokens")?.textContent ===
          "42k/1M",
      );
      await page.screenshot({ path: join(directory, "light.png") });
      await page.setViewportSize({ width: 360, height: 500 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        "narrow IDE pane has no horizontal overflow",
      );
      assert.ok(
        await page.evaluate(
          () =>
            document.querySelector(".terminal-usage")!.getBoundingClientRect()
              .left >=
            document.querySelector("textarea")!.getBoundingClientRect().right,
        ),
      );
      await page.evaluate(() => {
        document.documentElement.style.cssText =
          "--border:#343a48;--muted:#a4adbf;--text:#e1e5ee;--panel:#252b36";
        document.body.style.background = "#1c212a";
      });
      await page.screenshot({ path: join(directory, "dark-narrow.png") });
      partial = true;
      await page.waitForFunction(() =>
        document
          .querySelector(".terminal-usage-note")
          ?.textContent?.includes("마지막 수치"),
      );
      assert.equal(
        await page.locator(".terminal-usage-tokens").innerText(),
        "42k/1M",
        "an incomplete cache write never erases a measured denominator",
      );
      nativeCache = true;
      await page.waitForFunction(
        () =>
          document.querySelector(".terminal-usage-tokens")?.textContent ===
          "51k/1M",
      );
      assert.match(
        await page.locator(".terminal-usage-cost").innerText(),
        /\$47\.80/,
      );
      assert.match(
        await page.locator(".terminal-usage-model").innerText(),
        /claude-opus/,
      );
      await page.evaluate(() => (window as any).setActive(false));
      await page.waitForTimeout(100);
      const paused = reads;
      await page.waitForTimeout(2200);
      assert.equal(reads, paused, "inactive panes stop polling");
      hold = true;
      await page.evaluate(() => (window as any).setActive(true));
      for (let i = 0; i < 50 && !release; i++) await page.waitForTimeout(20);
      assert.ok(release);
      await page.evaluate((id) => (window as any).setSession(id), second);
      await page.waitForFunction(
        () =>
          document.querySelector(".terminal-usage-tokens")?.textContent ===
          "측정 중/한도 연결 중",
      );
      release();
      await page.waitForTimeout(100);
      assert.equal(
        await page.locator(".terminal-usage-tokens").innerText(),
        "측정 중/한도 연결 중",
      );
      assert.equal(
        await page.locator("[role=progressbar]").getAttribute("aria-valuenow"),
        null,
        "missing data is not zero",
      );
      assert.deepEqual(errors, []);
      console.log(`Usage preview: ${directory}`);
    } finally {
      release?.();
      await desktop?.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
);
