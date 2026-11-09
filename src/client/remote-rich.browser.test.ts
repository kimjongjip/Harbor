import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { createServer } from "node:http";
import { build } from "esbuild";
import express from "express";
import { _electron } from "playwright";

test(
  "remote rich answers cover replay markers without allocating rows or calling local APIs",
  { skip: process.platform !== "win32", timeout: 60000 },
  async () => {
    const root = resolve(".cache/remote-rich-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    const id = "0123456789abcdef0123";
    const text =
      "# Completed answer\n\nA formula $y=x^2$.\n\n| Item | Value |\n| --- | --- |\n| a | 1 |\n\n[Local file](./private.md)";
    await build({
      stdin: {
        contents: `import React,{useEffect,useRef,useState}from'react';import{createRoot}from'react-dom/client';import{Terminal}from'@xterm/xterm';import'@xterm/xterm/css/xterm.css';import RemoteRich from'./src/client/remote-desktop/RemoteRich';
function Fixture(){const mount=useRef(null);const[term,setTerm]=useState();const[blocks,setBlocks]=useState([]);window.showAnswer=()=>setBlocks([{id:${JSON.stringify(id)},requestId:'fixture',sessionId:'native',text:${JSON.stringify(text)},columns:80,viewportRows:20,createdAt:1,state:'ready',rows:15,marker:'',renderer:'rows-v2'}]);useEffect(()=>{const t=new Terminal({cols:80,rows:20,fontSize:15,scrollback:1000,theme:{background:'#ffffff',foreground:'#20242c'}});t.open(mount.current);window.term=t;setTerm(t);t.write('NATIVE HEADER\\r\\n'+Array.from({length:15},(_,i)=>'~HBR:${id}:'+i+'~').join('\\r\\n')+'\\r\\nNATIVE INPUT > draft');return()=>t.dispose()},[]);return <div ref={mount} style={{position:'relative',height:500,width:900}}><RemoteRich term={term} blocks={blocks} sessionId="native"/></div>};createRoot(document.getElementById('root')).render(<Fixture/>);`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      jsx: "automatic",
      bundle: true,
      outfile: join(directory, "fixture.js"),
      format: "esm",
      loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
      logLevel: "silent",
    });
    const fixtureApp = express();
    fixtureApp.use(express.static(directory));
    fixtureApp.get("/", (_req, res) =>
      res
        .type("html")
        .send(
          '<html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
        ),
    );
    const server = createServer(fixtureApp);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = `http://127.0.0.1:${(server.address() as any).port}`;
    const main = join(directory, "main.cjs");
    await writeFile(
      main,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadURL(${JSON.stringify(address)});});app.on('window-all-closed',()=>app.quit());`,
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => value !== undefined),
    ) as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      app = await _electron.launch({ args: [main], env });
      const page = await app.firstWindow();
      page.setDefaultTimeout(15000);
      const errors: string[] = [],
        apiRequests: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (/\/(?:api|mobile-api|desktop-api)\//.test(request.url()))
          apiRequests.push(request.url());
      });
      await page.locator(".remote-rich-pending").waitFor();
      const geometry = await page
        .locator(".remote-rich-block")
        .first()
        .boundingBox();
      assert.ok(geometry && geometry.height > 100);
      await page.evaluate(() => (window as any).showAnswer());
      await page.locator(".remote-rich-block .katex").first().waitFor();
      assert.equal(await page.locator(".remote-rich-block table").count(), 1);
      assert.equal(
        await page.locator(".remote-rich-block a[href='./private.md']").count(),
        0,
      );
      await page.locator(".remote-rich-block").hover();
      await page
        .getByRole("button", { name: "전체 답변", exact: true })
        .click();
      await page.getByRole("dialog", { name: "전체 답변" }).waitFor();
      assert.match(
        await page.getByRole("dialog").innerText(),
        /Completed answer/,
      );
      await page.getByRole("button", { name: "닫기", exact: true }).click();
      const buffer = await page.evaluate(() => {
        const term = (window as any).term;
        return Array.from({ length: term.buffer.active.length }, (_, i) =>
          term.buffer.active.getLine(i)?.translateToString(true),
        ).join("\n");
      });
      assert.match(buffer, /NATIVE INPUT > draft/);
      assert.match(
        buffer,
        /~HBR:/,
        "overlay never mutates the source terminal buffer",
      );
      assert.deepEqual(apiRequests, []);
      assert.deepEqual(errors, []);
    } finally {
      await app?.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      assert.ok(
        relative(root, directory) &&
          !relative(root, directory).startsWith(".."),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
);
