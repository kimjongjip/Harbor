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
  async (context) => {
    const parent = resolve(".cache/terminal-native-flow-tests");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, "run-"));
    await build({
      stdin: {
        contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{Terminal}from'@xterm/xterm';import{TerminalNativeFlow}from'./src/client/TerminalNativeFlow';import{richSelectedText}from'./src/client/TerminalRich';import'@xterm/xterm/css/xterm.css';
const term=window.term=new Terminal({cols:85,rows:20,allowProposedApi:true,fontSize:16});term.open(document.querySelector('#native'));window.sent=[];window.frames=0;window.writes=0;window.resizes=0;
term.onData(value=>window.sent.push(value));const write=term.write.bind(term),resize=term.resize.bind(term);term.write=(...args)=>{window.writes++;return write(...args)};term.resize=(...args)=>{window.resizes++;return resize(...args)};
window.push=text=>new Promise(resolve=>term.write(text,resolve));window.copy=()=>richSelectedText(document.querySelector('#surface'));
function App(){const[blocks,setBlocks]=useState([]);const[start,setStart]=useState(0);const[composer,setComposer]=useState(true);window.setComposer=setComposer;window.setStart=setStart;window.setBlocks=setBlocks;return <section id="surface"><article data-rich-block="old-question" data-terminal-rich="true"><p>Previous question before native output</p></article><article data-rich-block="old-answer" data-terminal-rich="true"><p>Previous answer before native output</p></article><TerminalNativeFlow term={term} codexComposer={composer} blocks={blocks} startRow={()=>start} onFrame={()=>window.frames++} renderAnswer={text=><p>{text}</p>}/></section>;}
createRoot(document.querySelector('#root')).render(<App/>);window.push('\\x1b[?2004h\\x1b[31;1mRan exact command\\x1b[0m\\r\\n  ORIGINAL RESULT\\r\\n› 미전송🙂');`,
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
      const fallback = await page.evaluate(() => {
        const row = document.querySelector('[data-native-row="2"]')!;
        const fill = row.querySelector(".terminal-native-row-fill > span")!;
        return {
          color: getComputedStyle(fill).backgroundColor,
          rowColor: getComputedStyle(row).backgroundColor,
          ordinary: getComputedStyle(
            document.querySelector(
              '[data-native-row="1"] .terminal-native-row-fill > span',
            )!,
          ).backgroundColor,
          width: fill.getBoundingClientRect().width,
          rowWidth: row.getBoundingClientRect().width,
          text: row.textContent,
        };
      });
      assert.notEqual(
        fallback.color,
        fallback.ordinary,
        "only the live composer receives the fallback fill",
      );
      assert.equal(
        fallback.rowColor,
        fallback.color,
        "fallback fills the whole visible input row",
      );
      assert.equal(fallback.text?.trimEnd(), "› 미전송🙂");
      await page.screenshot({
        path: join(parent, "codex-composer-fallback.png"),
      });
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
      // Exercise actual xterm input and a simulated PTY echo with long history.
      // Count public cell reads and scheduled delays as deterministic guards;
      // parsed-to-DOM timings are recorded as evidence, not a fragile 16 ms SLA.
      await page.evaluate(async () => {
        const state = window as any;
        state.setComposer(false);
        state.setBlocks([]);
        state.term.options.scrollback = 6000;
        state.term.reset();
        await state.push(
          Array.from({ length: 5000 }, (_, i) => `history ${i}\r\n`).join("") +
            "› ",
        );
      });
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-native-row="5000"]')
            ?.textContent?.trim() === "›",
      );
      await page.evaluate(() => {
        const state = window as any,
          term = state.term;
        state.probe = {
          target: "",
          parsed: 0,
          samples: [],
          perKeyCells: [],
          historyCells: 0,
          liveCells: 0,
          echoDelays: [],
        };
        const buffer = term.buffer.active,
          originalGetLine = buffer.getLine.bind(buffer);
        buffer.getLine = (row: number) => {
          const line = originalGetLine(row);
          if (!line) return line;
          const getCell = line.getCell.bind(line);
          line.getCell = (...args: unknown[]) => {
            if (row < buffer.baseY) state.probe.historyCells++;
            else state.probe.liveCells++;
            return getCell(...args);
          };
          return line;
        };
        const originalTimeout = window.setTimeout;
        window.setTimeout = ((
          handler: TimerHandler,
          delay?: number,
          ...args: unknown[]
        ) => {
          if (state.probe.target && delay && delay >= 50 && delay <= 70)
            state.probe.echoDelays.push(delay);
          return originalTimeout(handler, delay, ...args);
        }) as typeof window.setTimeout;
        const parsed = term.onWriteParsed(
          () => (state.probe.parsed = performance.now()),
        );
        const echo = term.onData((value: string) => term.write(value));
        const observer = new MutationObserver(() => {
          const probe = state.probe;
          if (
            probe.target &&
            probe.parsed &&
            document
              .querySelector('[data-native-row="5000"]')
              ?.textContent?.trimEnd() === probe.target
          ) {
            probe.samples.push(performance.now() - probe.parsed);
            probe.perKeyCells.push(probe.liveCells - probe.beforeKeyCells);
            probe.target = "";
          }
        });
        observer.observe(document.querySelector(".terminal-native-flow")!, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        state.stopProbe = () => {
          observer.disconnect();
          echo.dispose();
          parsed.dispose();
          buffer.getLine = originalGetLine;
          window.setTimeout = originalTimeout;
        };
        term.focus();
      });
      await page.evaluate(async () => {
        // Empty/caret-only selection changes are common during textarea input.
        // They must not schedule projection work when no text range was held.
        document.dispatchEvent(new Event("selectionchange"));
        document.dispatchEvent(new Event("selectionchange"));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(
        await page.evaluate(() => (window as any).probe.liveCells),
        0,
        "caret-only changes must not capture the terminal",
      );
      const typed = "responsive";
      for (let index = 0; index < typed.length; index++) {
        await page.evaluate(
          (target) => {
            (window as any).probe.target = target;
            (window as any).probe.parsed = 0;
            (window as any).probe.beforeKeyCells = (
              window as any
            ).probe.liveCells;
          },
          "› " + typed.slice(0, index + 1),
        );
        await page.keyboard.type(typed[index]);
        await page.waitForFunction(
          (length) => (window as any).probe.samples.length === length,
          index + 1,
        );
      }
      const timing = await page.evaluate(() => {
        const state = window as any;
        state.stopProbe();
        return {
          ...state.probe,
          sent: state.sent.join(""),
          columns: state.term.cols,
          rows: state.term.rows,
        };
      });
      assert.equal(
        timing.historyCells,
        0,
        "echo must not restyle 5,000 historical rows",
      );
      assert.ok(
        timing.liveCells <=
          typed.length * (timing.columns * timing.rows + timing.columns),
        JSON.stringify(timing),
      );
      assert.ok(
        timing.perKeyCells.every(
          (cells: number) =>
            cells <= timing.columns * timing.rows + timing.columns,
        ),
        JSON.stringify(timing.perKeyCells),
      );
      assert.deepEqual(
        timing.echoDelays,
        [],
        "normal echo must not wait behind a fixed 60 ms timer",
      );
      assert.ok(timing.sent.endsWith(typed));
      assert.equal(timing.samples.length, typed.length);
      context.diagnostic(
        `5,000-row parsed-to-DOM latency ms: ${timing.samples.map((ms: number) => ms.toFixed(1)).join(", ")}; historical cell reads: ${timing.historyCells}; live cell reads: ${timing.liveCells}; per key: ${timing.perKeyCells.join(", ")}`,
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
