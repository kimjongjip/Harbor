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
  "native unsupported Mermaid uses saved answers without terminal input or layout reservations",
  {
    skip: process.platform !== "win32",
    timeout: 90000,
  },
  async () => {
    const root = resolve(".cache/diagram-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    const source = [
      "flowchart TB",
      'subgraph HOST["호스트 CPU"]',
      'A["모델 파일"] --> B["호스트 런타임"]',
      'C["별도 모델 파일"] --> D["실행 관리자"]',
      "end",
      'B -->|"실행 요청"| E',
      'D -->|"초기화 / 큐로 연산 전달"| F',
      'subgraph DSP["가속기 소프트웨어 · 실행 환경"]',
      'E["첫 번째 실행기"]',
      'F["두 번째 실행기"]',
      "end",
      'E --> HW["하드웨어<br/>scalar · vector · DMA"]',
      "F --> HW",
    ].join("\n");
    const text = "설명입니다.\n\n```mermaid\n" + source + "\n```";
    const code = `
import React,{useEffect,useRef,useState}from'react';import{createRoot}from'react-dom/client';
import{Terminal}from'@xterm/xterm';import'@xterm/xterm/css/xterm.css';
import{TerminalRich}from'./src/client/TerminalRich';import{TypographyProvider}from'./src/client/Typography';import{ThemeProvider}from'./src/client/Theme';
import'./src/client/styles.css';import'./src/client/themes.css';import'./src/client/rich-content.css';import'./src/client/typography.css';
window.inputs=[];
function Fixture(){const mount=useRef(null);const[term,setTerm]=useState(null);const[info,setInfo]=useState({id:'terminal',hostId:'fixture',cwd:'/fixture',title:'fixture',agentKind:'codex',agentSessionId:'first',agentState:'idle',connectionState:'connected'});const[blocks,setBlocks]=useState([]);
useEffect(()=>{const t=new Terminal({cols:80,rows:35,fontSize:15,lineHeight:1.4});t.open(mount.current);t.onData(d=>window.inputs.push(d));window.term=t;window.configure=patch=>setInfo(i=>({...i,...patch}));window.setBlocks=setBlocks;window.paint=warning=>new Promise(resolve=>t.write('\\x1bc'+(warning?"This Mermaid diagram uses features the terminal renderer doesn't support.\\r\\n":'Native output\\r\\n')+'Native input > ',resolve));setTerm(t);return()=>t.dispose();},[]);
return <><div ref={mount} className="terminal-mount" style={{position:'relative',width:1000,height:850,margin:10}}/>{term&&<TerminalRich term={term} info={info} blocks={blocks}/>}</>}
createRoot(document.getElementById('root')).render(<ThemeProvider><TypographyProvider><Fixture/></TypographyProvider></ThemeProvider>);
`;
    await build({
      stdin: {
        contents: code,
        resolveDir: process.cwd(),
        sourcefile: "diagram-fixture.tsx",
        loader: "tsx",
      },
      bundle: true,
      outfile: join(directory, "fixture.js"),
      format: "esm",
      external: ["/fonts/*"],
      loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
      logLevel: "silent",
    });
    const app = express();
    app.use("/fonts", express.static(resolve("public/fonts")));
    app.use(express.static(directory));
    app.get("/", (_req, res) =>
      res
        .type("html")
        .send(
          '<!doctype html><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
        ),
    );
    const server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    await writeFile(
      join(directory, "main.cjs"),
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1200,height:1000,webPreferences:{backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadURL(${JSON.stringify(url)});});app.on('window-all-closed',()=>app.quit());`,
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => value !== undefined),
    ) as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    let desktop: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      desktop = await _electron.launch({
        args: [join(directory, "main.cjs")],
        env,
      });
      const page = await desktop.firstWindow();
      const errors: string[] = [],
        requests: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let empty = 0;
      let pending: (() => Promise<void>) | undefined;
      await page.route("**/api/**", async (route) => {
        const request = route.request();
        const sessionId = new URL(request.url()).pathname.split("/").at(-1)!;
        requests.push(`${request.method()}:${sessionId}`);
        const reply = () =>
          route.fulfill({
            json: {
              thread: { id: sessionId, hostId: "fixture", cwd: "/fixture" },
              items:
                empty-- > 0
                  ? []
                  : [
                      {
                        id: sessionId,
                        kind: "assistant",
                        phase: "final_answer",
                        text,
                      },
                    ],
              nextCursor: null,
            },
          });
        if (sessionId === "delayed") pending = reply;
        else await reply();
      });
      await page.waitForFunction(() => !!(window as any).paint);
      await page.evaluate(() => (window as any).paint(false));
      await page.waitForTimeout(250);
      assert.equal(
        requests.length,
        0,
        "ordinary native output must not poll history",
      );
      empty = 1;
      await page.evaluate(() => (window as any).paint(true));
      await page
        .locator('[aria-label="저장된 답변의 Mermaid 그림"] svg')
        .waitFor();
      assert.equal(
        requests.length,
        2,
        "one bounded retry after history flush lag",
      );
      assert.equal(await page.locator(".mermaid-error").count(), 0);
      assert.ok(
        (await page.locator(".mermaid-svg").innerText()).includes("하드웨어"),
      );
      assert.equal(await page.locator(".mermaid-svg .cluster").count(), 2);
      assert.equal(await page.locator(".mermaid-svg .node").count(), 7);
      const bounds = await page.evaluate(() => ({
        card: document
          .querySelector('[aria-label="저장된 답변의 Mermaid 그림"]')!
          .getBoundingClientRect().bottom,
        terminal: document
          .querySelector(".terminal-mount")!
          .getBoundingClientRect().bottom,
      }));
      assert.ok(
        bounds.card < bounds.terminal - 100,
        "diagram must leave the native input area available",
      );
      await page
        .getByRole("button", { name: "흐름도 확대", exact: true })
        .click();
      assert.equal(
        await page
          .getByRole("button", { name: "흐름도 원래 크기" })
          .innerText(),
        "125%",
      );
      await page.getByRole("button", { name: /답변의 다이어그램/ }).click();
      assert.equal(await page.locator(".mermaid-svg").count(), 0);
      await page.getByRole("button", { name: /답변의 다이어그램/ }).click();
      await page.locator(".mermaid-svg svg").waitFor();
      await page.screenshot({ path: join(directory, "diagram.png") });

      // Switching sessions discards old content and ignores a late network reply.
      await page.evaluate(() =>
        (window as any).configure({ agentSessionId: "delayed" }),
      );
      await page.waitForFunction(() => !document.querySelector(".mermaid-svg"));
      await new Promise<void>((resolve) => {
        const poll = () => (pending ? resolve() : setTimeout(poll, 20));
        poll();
      });
      await page.evaluate(() =>
        (window as any).configure({ agentSessionId: "second" }),
      );
      await page.locator('[data-rich-block="diagram-second:0"] svg').waitFor();
      await pending!().catch(() => {});
      assert.equal(
        await page.locator('[data-rich-block="diagram-delayed:0"]').count(),
        0,
      );
      await page.evaluate(() => (window as any).paint(false));
      await page.waitForFunction(
        () =>
          !document.querySelector('[aria-label="저장된 답변의 Mermaid 그림"]'),
      );
      assert.deepEqual(await page.evaluate(() => (window as any).inputs), []);
      assert.ok(
        requests.every((item) => item.startsWith("GET:")),
        "display must never reserve terminal rows or send input",
      );
      assert.deepEqual(errors, []);
    } finally {
      await desktop?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      assert.ok(directory.startsWith(root + sep));
      // Keep only the synthetic screenshot for visual inspection.
      for (const name of ["profile", "fixture.js", "fixture.css", "main.cjs"])
        await rm(join(directory, name), { recursive: true, force: true });
    }
  },
);
