import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import { build } from "esbuild";
import { _electron } from "playwright";

test(
  "native flow keeps one selectable output and existing CLI input while updates preserve selection",
  { skip: process.platform !== "win32", timeout: 60000 },
  async () => {
    const parent = resolve(".cache/terminal-native-flow-tests");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, "run-"));
    await build({
      stdin: {
        contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{Terminal}from'@xterm/xterm';import{TerminalNativeFlow}from'./src/client/TerminalNativeFlow';import{richSelectedText}from'./src/client/TerminalRich';import'@xterm/xterm/css/xterm.css';
const term=window.term=new Terminal({cols:85,rows:20,allowProposedApi:true,fontSize:16});term.open(document.querySelector('#native'));window.sent=[];window.frames=0;window.writes=0;window.resizes=0;
term.onData(value=>window.sent.push(value));const write=term.write.bind(term),resize=term.resize.bind(term);term.write=(...args)=>{window.writes++;return write(...args)};term.resize=(...args)=>{window.resizes++;return resize(...args)};
window.push=text=>new Promise(resolve=>term.write(text,resolve));window.copy=()=>richSelectedText(document.querySelector('#surface'));
function App(){const[blocks,setBlocks]=useState([]);const[start,setStart]=useState(0);window.setStart=setStart;window.setBlocks=setBlocks;return <section id="surface"><article data-rich-block="old-question" data-terminal-rich="true"><p>Previous question before native output</p></article><article data-rich-block="old-answer" data-terminal-rich="true"><p>Previous answer before native output</p></article><TerminalNativeFlow term={term} blocks={blocks} startRow={()=>start} onFrame={()=>window.frames++} renderAnswer={text=><p>{text}</p>}/></section>;}
createRoot(document.querySelector('#root')).render(<App/>);window.push('\\x1b[31;1mRan exact command\\x1b[0m\\r\\n  ORIGINAL RESULT\\r\\n› 미전송🙂');`,
        resolveDir: process.cwd(),
        sourcefile: "native-flow-fixture.tsx",
        loader: "tsx",
      },
      bundle: true,
      outfile: join(directory, "fixture.js"),
      format: "esm",
      logLevel: "silent",
      loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
    });
    const app = express();
    app.use(express.static(directory));
    app.get("/", (_req, res) =>
      res
        .type("html")
        .send(
          '<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"><style>body{margin:0;font:16px Arial}#native{position:absolute;width:800px;height:600px;opacity:0;pointer-events:none}#root{position:relative;z-index:2;background:white}#surface{height:500px;width:760px;overflow:auto;user-select:text;padding:12px}p{margin:8px 0}</style></head><body><div id="native"></div><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
        ),
    );
    const server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const main = join(directory, "electron.cjs");
    await writeFile(
      main,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.commandLine.appendSwitch('disable-gpu');app.whenReady().then(()=>new BrowserWindow({show:false,width:900,height:650,webPreferences:{backgroundThrottling:false,contextIsolation:true,sandbox:true}}).loadURL('http://127.0.0.1:${(server.address() as { port: number }).port}/'));app.on('window-all-closed',()=>app.quit());`,
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
      await page.locator('[data-native-row="2"]').waitFor();
      assert.ok(
        (await page.locator(".terminal-native-flow").innerText()).includes(
          "› 미전송🙂",
        ),
      );
      assert.equal(
        await page
          .locator('[data-native-row="0"] > span')
          .first()
          .evaluate((node) => getComputedStyle(node).fontWeight),
        "700",
      );
      assert.deepEqual(
        await page.evaluate(() => ({
          writes: (window as any).writes,
          resizes: (window as any).resizes,
        })),
        { writes: 1, resizes: 0 },
      );
      await page.locator('[data-native-row="2"]').click();
      assert.equal(
        await page.evaluate(() =>
          document.activeElement?.classList.contains("xterm-helper-textarea"),
        ),
        true,
      );
      await page.keyboard.type(" typed");
      assert.equal(
        await page.evaluate(() => (window as any).sent.join("")),
        " typed",
      );
      assert.equal(await page.evaluate(() => (window as any).writes), 1);
      // History settling changes only the projection boundary, not the native screen.
      await page.evaluate(() => (window as any).setStart(2));
      await page.waitForFunction(
        () =>
          document
            .querySelector(".terminal-native-row")
            ?.getAttribute("data-native-row") === "2",
        undefined,
        { timeout: 2000 },
      );
      assert.equal(await page.evaluate(() => (window as any).writes), 1);
      await page.evaluate(() => (window as any).setStart(0));
      await page.waitForFunction(
        () =>
          document
            .querySelector(".terminal-native-row")
            ?.getAttribute("data-native-row") === "0",
        undefined,
        { timeout: 2000 },
      );
      await page.evaluate(() => {
        const start = document.querySelector(
          '[data-rich-block="old-question"] p',
        )!.firstChild!;
        const finish = document.querySelector(
          '[data-native-row="2"] > span',
        )!.firstChild!;
        const range = document.createRange();
        range.setStart(start, 0);
        range.setEnd(finish, finish.textContent!.length);
        const selection = getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        (window as any).selectionAnchor = selection.anchorNode;
      });
      const selected = await page.evaluate(() => (window as any).copy());
      for (const text of [
        "Previous question",
        "Previous answer",
        "Ran exact command",
        "ORIGINAL RESULT",
        "미전송🙂",
      ])
        assert.ok(selected.includes(text), text);
      await page.evaluate(() => (window as any).push("\r\nNEW LIVE OUTPUT"));
      await page.waitForTimeout(160);
      assert.equal(
        await page
          .locator(".terminal-native-flow")
          .innerText()
          .then((text) => text.includes("NEW LIVE OUTPUT")),
        false,
      );
      assert.equal(
        await page.evaluate(
          () => getSelection()!.anchorNode === (window as any).selectionAnchor,
        ),
        true,
      );
      assert.equal(await page.evaluate(() => (window as any).copy()), selected);
      await page.evaluate(() => getSelection()!.removeAllRanges());
      await page.waitForFunction(() =>
        document
          .querySelector(".terminal-native-flow")
          ?.textContent?.includes("NEW LIVE OUTPUT"),
      );
      const id = "0123456789abcdef0123";
      await page.evaluate((id) => {
        (window as any).setBlocks([
          {
            id,
            marker: "~HBR:" + id + "~",
            requestId: "fixture",
            sessionId: "native",
            text: "Whole canonical final answer",
            columns: 85,
            viewportRows: 20,
            createdAt: 1,
            state: "ready",
            rows: 3,
            renderer: "rows-v2",
          },
        ]);
        return (window as any).push(
          "\r\n~HBR:" + id + ":0~\r\n~HBR:" + id + ":1~\r\n› NEXT INPUT",
        );
      }, id);
      await page.waitForFunction(() =>
        document
          .querySelector(".terminal-native-flow")
          ?.textContent?.includes("Whole canonical final answer"),
      );
      assert.equal(
        (await page.locator(".terminal-native-flow").innerText()).includes(
          "~HBR:",
        ),
        false,
      );
      assert.equal(await page.locator(".terminal-native-answer").count(), 1);
      assert.ok(
        (await page.locator(".terminal-native-flow").innerText()).includes(
          "NEXT INPUT",
        ),
      );
      // A synchronized TUI frame must appear atomically, without a mouse move.
      await page.evaluate(() =>
        (window as any).push("\x1b[?2026h\r\nPARTIAL ATOMIC FRAME"),
      );
      await page.waitForTimeout(160);
      assert.equal(
        (await page.locator(".terminal-native-flow").innerText()).includes(
          "PARTIAL ATOMIC FRAME",
        ),
        false,
      );
      await page.evaluate(() => (window as any).push(" COMPLETED\x1b[?2026l"));
      await page.waitForFunction(() =>
        document
          .querySelector(".terminal-native-flow")
          ?.textContent?.includes("PARTIAL ATOMIC FRAME COMPLETED"),
      );
      assert.equal(await page.evaluate(() => (window as any).resizes), 0);
      assert.deepEqual(errors, []);
    } finally {
      await desktop?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!directory.startsWith(parent + sep))
        throw new Error("Unsafe fixture cleanup");
      await rm(directory, { recursive: true, force: true });
    }
  },
);
