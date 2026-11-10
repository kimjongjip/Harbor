import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { build } from "esbuild";
import { _electron } from "playwright";

test(
  "Crew demo uses the real artwork and facts components without agents, network calls or parent/input changes",
  { skip: process.platform !== "win32", timeout: 60000 },
  async () => {
    const root = resolve(".cache/crew-demo-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    const initial = {
      agents: [
        {
          id: "reviewer",
          name: "general-purpose",
          state: "working",
          task: "키보드 입력과 화면 갱신을 검토해요",
          activity: "Read",
          model: "synthetic-model",
          tokens: {
            total: 12000,
            input: 10000,
            output: 2000,
            cached: 8000,
            scope: "observed",
          },
        },
        {
          id: "waiting",
          name: "general-purpose",
          state: "waiting",
          task: "검토 결과를 기다려요",
        },
      ],
      source: "native",
      updatedAt: Date.now(),
      detailVersion: 1,
    };
    await build({
      stdin: {
        contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{TerminalCrew}from'./src/client/TerminalCrew';import'./src/client/themes.css';window.renders=0;window.visibility='visible';Object.defineProperty(document,'visibilityState',{get:()=>window.visibility});function App(){window.renders++;const[state,setState]=useState('idle'),[active,setActive]=useState(true);window.setState=setState;window.setActive=setActive;return <main style={{display:'flex',gap:32,padding:24}}><section style={{flex:1,minWidth:0}}><h2>Harbor Crew · 테스트 화면</h2><textarea aria-label="작성 중 입력" defaultValue="한글 English 작성 중" style={{width:'95%',height:100}}/></section><aside style={{width:320,maxWidth:'50vw'}}><TerminalCrew provider="codex" state={state} active={active} crew={${JSON.stringify(initial)}}/></aside></main>}createRoot(document.getElementById('root')).render(<App/>);`,
        resolveDir: process.cwd(),
        sourcefile: "crew-fixture.tsx",
        loader: "tsx",
      },
      bundle: true,
      format: "esm",
      outfile: join(directory, "fixture.js"),
      logLevel: "silent",
    });
    let apiCalls = 0;
    const app = express();
    app.use("/api", (_req, res) => {
      apiCalls++;
      res.sendStatus(403);
    });
    app.use(express.static(directory));
    app.get("/", (_req, res) =>
      res
        .type("html")
        .send(
          '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>body{margin:0;font-family:Arial,sans-serif}button,input,textarea{font:inherit}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
        ),
    );
    const server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const main = join(directory, "electron.cjs");
    await writeFile(
      main,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.commandLine.appendSwitch('disable-gpu');app.whenReady().then(()=>new BrowserWindow({show:false,width:1180,height:940,webPreferences:{backgroundThrottling:false,contextIsolation:true,sandbox:true}}).loadURL('http://127.0.0.1:${(server.address() as any).port}/'));app.on('window-all-closed',()=>app.quit());`,
    );
    let desktop: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      desktop = await _electron.launch({
        args: [main],
        env: env as Record<string, string>,
      });
      const page = await desktop.firstWindow(),
        errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.waitForSelector(".crew-main .crew-robot");
      assert.equal(await page.locator(".crew-agent .crew-robot").count(), 2);
      assert.deepEqual(
        await page.locator(".crew-agent-title").allTextContents(),
        ["키보드 입력과 화면 갱신을 검토해요", "검토 결과를 기다려요"],
      );
      assert.equal(
        await page.locator(".crew-agent-task").count(),
        0,
        "task is the title, not repeated below",
      );
      assert.match(
        await page.locator(".crew-agent-name > span").first().innerText(),
        /general-purpose.*synthetic-model/,
      );
      assert.equal(await page.locator(".crew-main .crew-crown").count(), 1);
      assert.equal(await page.locator(".crew-agent .crew-crown").count(), 0);
      assert.equal(
        await page
          .locator(".crew-main .crew-coffee")
          .evaluate((e) => getComputedStyle(e).display),
        "block",
      );
      assert.match(
        await page.locator(".crew-agent").first().innerText(),
        /키보드 입력.*화면 갱신/s,
      );
      assert.match(
        await page.locator(".crew-agent-tokens").first().innerText(),
        /관측 누적 12k/,
      );
      assert.match(
        await page.locator(".crew-agent-tokens").last().innerText(),
        /수신 대기/,
      );
      const parentRenders = await page.evaluate(() => (window as any).renders);
      await page.evaluate(
        () => ((window as any).inputNode = document.querySelector("textarea")),
      );
      const demo = page.getByRole("button", { name: "데모", exact: true });
      await demo.click();
      const dialog = page.getByRole("dialog", { name: "Harbor Crew 미리보기" });
      await dialog.waitFor();
      assert.match(await dialog.innerText(), /샘플 작업 · 가상 토큰/);
      assert.equal(await dialog.locator(".crew-demo-card").count(), 8);
      assert.equal(await dialog.locator(".crew-crown").count(), 1);
      assert.equal(
        await dialog.locator(".crew-robot").count(),
        8,
        "demo follows the selected team character",
      );
      assert.match(
        await dialog.locator(".crew-demo-card-heading").nth(1).innerText(),
        /입력 성능 분석/,
      );
      await dialog
        .getByRole("button", { name: "일시정지", exact: true })
        .click();
      const frame = await dialog
        .locator(".crew-demo")
        .getAttribute("data-frame");
      await page.waitForTimeout(2700);
      assert.equal(
        await dialog.locator(".crew-demo").getAttribute("data-frame"),
        frame,
      );
      await dialog.getByRole("button", { name: "다음 장면" }).click();
      assert.equal(
        Number(await dialog.locator(".crew-demo").getAttribute("data-frame")),
        Number(frame) + 1,
      );
      await dialog.screenshot({ path: join(directory, "crew-demo-light.png") });
      await page.evaluate(() => {
        document.documentElement.style.cssText =
          "--bg:#1d242d;--panel:#272f3a;--text:#e0e7eb;--muted:#a6b0bb;--border:#3e4954;--success:#92c6a2;--warning:#e5c184;--accent:#a3bdd5;--overlay:#060c14aa";
      });
      await dialog.screenshot({ path: join(directory, "crew-demo-dark.png") });
      await page.setViewportSize({ width: 360, height: 740 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await dialog.screenshot({
        path: join(directory, "crew-demo-narrow.png"),
      });
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      assert.equal(
        await page.evaluate(
          () =>
            (window as any).inputNode === document.querySelector("textarea"),
        ),
        true,
      );
      assert.equal(
        await page.getByRole("textbox").inputValue(),
        "한글 English 작성 중",
      );
      assert.equal(
        await page.evaluate(() => (window as any).renders),
        parentRenders,
        "demo frames never render the parent or real agent list",
      );
      assert.equal(
        await demo.evaluate((e) => e === document.activeElement),
        true,
        "focus returns to the demo button",
      );
      assert.match(
        await page.locator(".crew-agent-tokens").first().innerText(),
        /관측 누적 12k/,
        "demo never overwrites real counters",
      );
      await page.setViewportSize({ width: 1180, height: 940 });
      await page.getByRole("button", { name: "캐릭터 설정" }).click();
      for (const [label, character] of [
        ["고양이", "cat"],
        ["로봇", "robot"],
        ["여우", "fox"],
        ["사람", "human"],
        ["펭귄", "penguin"],
        ["강아지", "dog"],
        ["개구리", "frog"],
      ]) {
        await page.getByRole("button", { name: label, exact: true }).click();
        assert.equal(
          await page.locator(".crew-main .crew-" + character).count(),
          1,
        );
        assert.equal(
          await page.locator(".crew-agent .crew-" + character).count(),
          2,
        );
      }
      await page.getByRole("button", { name: "고양이", exact: true }).click();
      await page.getByRole("button", { name: "캐릭터 설정" }).click();
      await page
        .locator(".terminal-crew")
        .screenshot({ path: join(directory, "cat-team-tasks.png") });
      await page.evaluate(() => (window as any).setState("working"));
      await page.waitForFunction(
        () =>
          document.querySelector(".crew-main")?.getAttribute("data-state") ===
          "working",
      );
      assert.equal(
        await page
          .locator(".crew-main .crew-coffee")
          .evaluate((e) => getComputedStyle(e).display),
        "none",
      );
      await demo.click();
      assert.equal(await dialog.locator(".crew-cat").count(), 8);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.waitForFunction(
        () =>
          document.querySelector(".crew-demo")?.getAttribute("data-motion") ===
          "off",
      );
      assert.equal(
        await dialog
          .locator(".crew-coffee")
          .first()
          .evaluate((e) => getComputedStyle(e).animationName),
        "none",
      );
      await page.keyboard.press("Escape");
      assert.equal(
        await page.evaluate(() => (window as any).renders),
        parentRenders + 1,
        "character changes never rerender the parent; only the fixture's work-state change does",
      );
      // Restore preferences only in this isolated fixture; never reload Harbor.
      await page.reload();
      await page.waitForSelector(".crew-main .crew-cat");
      assert.equal(await page.locator(".crew-agent .crew-cat").count(), 2);
      assert.equal(apiCalls, 0);
      assert.deepEqual(errors, []);
      console.log(`Crew demo preview: ${directory}`);
    } finally {
      await desktop?.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }

    // Portable preview uses the production demo and needs no running Harbor/server.
    await build({
      stdin: {
        contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{CrewDemo}from'./src/client/CrewDemo';import'./src/client/terminal-crew.css';import'./src/client/themes.css';function App(){const[open,setOpen]=useState(true);return <><button style={{margin:24,padding:12}} onClick={()=>setOpen(true)}>Harbor Crew 데모 열기</button>{open&&<CrewDemo motion={true} onClose={()=>setOpen(false)}/>}</>}createRoot(document.getElementById('root')).render(<App/>);`,
        sourcefile: "standalone-demo.tsx",
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      format: "esm",
      minify: true,
      define: { "process.env.NODE_ENV": '"production"' },
      outfile: join(directory, "standalone.js"),
      logLevel: "silent",
    });
    const js = await readFile(join(directory, "standalone.js"), "utf8"),
      css = await readFile(join(directory, "standalone.css"), "utf8");
    await writeFile(
      join(directory, "Harbor-Crew-Demo.html"),
      `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Harbor Crew Demo</title><style>body{margin:0;font-family:Arial,sans-serif}button{font:inherit}${css.replaceAll("</style", "<\\/style")}</style><body><div id="root"></div><script type="module">${js.replaceAll("</script", "<\\/script")}</script></body></html>`,
    );
  },
);
