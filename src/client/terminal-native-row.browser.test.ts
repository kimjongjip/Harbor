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
  "native prompt backgrounds retain blank cells without copy padding or horizontal overflow",
  { skip: process.platform !== "win32", timeout: 60000 },
  async () => {
    const parent = resolve(".cache/terminal-native-row-tests");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, "run-"));
    await build({
      stdin: {
        contents: `import React from'react';import{createRoot}from'react-dom/client';import{Terminal}from'@xterm/xterm';import{NativeRow}from'./src/client/TerminalNativeRow';import{nativeRow}from'./src/client/mobile/terminal-flow';import{nativeFlowCursorOffset}from'./src/client/terminal-native-flow';import{richSelectedText}from'./src/client/TerminalRich';import'@xterm/xterm/css/xterm.css';
const term=window.term=new Terminal({cols:100,rows:8,allowProposedApi:true,fontSize:20,fontFamily:'Consolas,monospace',theme:{foreground:'#123456',background:'#fffdf7'}});term.open(document.querySelector('#native'));
term.write('Regular output\\r\\n\\x1b[48;2;238;238;238m\\x1b[2K\\r\\n› 질문🙂 é\\x1b[K\\r\\n\\x1b[0m한🙂\\x1b[48;2;200;220;240m  MIXED\\x1b[K\\r\\n\\x1b[48;2;238;238;238m        \\x1b[0m\\x1b[K\\x1b[3;7H',()=>{
const rows=[0,1,2,3,4].map(row=>nativeRow(term.buffer.active.getLine(row),term.cols,0,term.options.theme));window.rows=rows;
const cursor=nativeFlowCursorOffset(term.buffer.active.getLine(2),term.buffer.active.cursorX);
createRoot(document.querySelector('#surface')).render(<>{rows.map((runs,row)=><NativeRow key={row} row={row} runs={runs} lineHeight={28} cursorOffset={row===2?cursor:row===4?4:undefined}/>)}</>);
});window.copy=()=>richSelectedText(document.querySelector('#surface'));`,
        resolveDir: process.cwd(),
        sourcefile: "native-row-fixture.tsx",
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
          '<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"><style>body{margin:0;background:#fffdf7}#native{position:absolute;width:1200px;height:250px;opacity:0;pointer-events:none}#surface{position:relative;font:20px Consolas,monospace;width:600px;user-select:text;margin:20px;color:#123456}</style></head><body><div id="native"></div><section id="surface"></section><script type="module" src="/fixture.js"></script></body></html>',
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
      await page.locator('[data-native-row="3"]').waitFor();
      const grayRows = await page.evaluate(() =>
        [1, 2].map((index) => {
          const row = document.querySelector<HTMLElement>(
            `[data-native-row="${index}"]`,
          )!;
          const fill = row.querySelector<HTMLElement>(
            ".terminal-native-row-fill > span",
          )!;
          return {
            text: row.textContent,
            color: getComputedStyle(fill).backgroundColor,
            height: fill.getBoundingClientRect().height,
            width: fill.getBoundingClientRect().width,
            rowWidth: row.clientWidth,
            rowHeight: row.clientHeight,
          };
        }),
      );
      assert.equal(grayRows[0].text, "");
      assert.equal(grayRows[1].text, "› 질문🙂 é");
      for (const row of grayRows) {
        assert.equal(row.color, "rgb(238, 238, 238)");
        assert.equal(row.height, 28);
        assert.equal(row.rowHeight, 28);
        assert.ok(
          row.width >= row.rowWidth,
          "native blank cells paint the whole composer",
        );
      }
      assert.equal(
        await page
          .locator('[data-native-row="2"] [data-native-cursor="true"]')
          .textContent(),
        "🙂",
      );
      assert.equal(
        await page
          .locator('[data-native-row="4"] [data-native-cursor="true"]')
          .evaluate(
            (cursor) => getComputedStyle(cursor.parentElement!).backgroundColor,
          ),
        "rgb(238, 238, 238)",
        "cursor padding keeps its original gray cells before the default background suffix",
      );
      assert.equal(
        await page.locator('[data-native-row="4"]').textContent(),
        "     ",
      );
      // Mixed backgrounds start at the same Unicode boundary as foreground text,
      // including the wide Korean glyph and supplementary-plane emoji.
      const mixed = await page
        .locator('[data-native-row="3"]')
        .evaluate((row) => {
          const fills = row.querySelectorAll(
            ".terminal-native-row-fill > span",
          );
          const foreground = row.querySelectorAll(":scope > span");
          return {
            fillLeft: fills[1].getBoundingClientRect().left,
            textLeft: foreground[1].getBoundingClientRect().left,
            color: getComputedStyle(fills[1]).backgroundColor,
            defaultColor: getComputedStyle(fills[0]).backgroundColor,
          };
        });
      assert.ok(Math.abs(mixed.fillLeft - mixed.textLeft) < 0.5);
      assert.equal(mixed.color, "rgb(200, 220, 240)");
      assert.equal(mixed.defaultColor, "rgb(255, 253, 247)");
      await page.screenshot({
        path: join(parent, "native-prompt-background.png"),
      });
      await page.evaluate(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector("#surface")!);
        range.setStart(
          document.querySelector('[data-native-row="0"] > span')!.firstChild!,
          0,
        );
        const last = document.querySelector('[data-native-row="3"]')!;
        range.setEnd(last, last.childNodes.length);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
      });
      assert.equal(
        await page.evaluate(() => (window as any).copy()),
        "Regular output\n\n› 질문🙂 é\n한🙂  MIXED",
      );
      const nativeSelection = await page.evaluate(() =>
        getSelection()!.toString(),
      );
      assert.equal((nativeSelection.match(/질문/g) || []).length, 1);
      assert.ok(
        !/ {4}/.test(nativeSelection),
        "paint padding is absent from browser selection",
      );
      await page.evaluate(() => {
        getSelection()!.removeAllRanges();
        document.querySelector<HTMLElement>("#surface")!.style.width = "90px";
      });
      const narrow = await page.evaluate(() => {
        const surface = document.querySelector<HTMLElement>("#surface")!;
        const blank = document.querySelector<HTMLElement>(
          '[data-native-row="1"]',
        )!;
        const prompt = document.querySelector<HTMLElement>(
          '[data-native-row="2"]',
        )!;
        return {
          width: surface.clientWidth,
          scroll: surface.scrollWidth,
          blankHeight: blank.clientHeight,
          promptHeight: prompt.clientHeight,
          text: prompt.textContent,
        };
      });
      assert.equal(
        narrow.scroll,
        narrow.width,
        "background padding does not add horizontal scrolling",
      );
      assert.equal(narrow.blankHeight, 28, "empty padding never wraps");
      assert.ok(
        narrow.promptHeight > 28,
        "meaningful text can still wrap in a narrow pane",
      );
      assert.equal(narrow.text, "› 질문🙂 é");
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
