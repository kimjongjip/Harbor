import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import { build } from "esbuild";
import { _electron } from "playwright";
import { TerminalScreen } from "../server/terminal-screen";

test(
  "long Korean tables stay in flow and clipped native reservations remain readable",
  { skip: process.platform !== "win32", timeout: 90000 },
  async () => {
    const root = resolve(".cache/rich-layout-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    const text = [
      "# 긴 답변",
      "",
      "수식 $y=\\frac{a+b}{c}$ 와 한글을 함께 읽습니다.",
      "",
      "```text",
      "NPU → DRAM → PIM",
      "행마다 다른 길이의 설명을 포함합니다.",
      "```",
      "",
      "| 무엇 | 형식 | scale은 어디서 언제 |",
      "| --- | --- | --- |",
      ...Array.from(
        { length: 12 },
        (_, i) =>
          `| ${i % 2 ? "PIM 연산" : "가중치"} | INT8 × INT8 → INT32 누산, 형 변환과 길이가 긴 한국어 설명 ${i + 1} | 오프라인에서 만들어 계산에 사용하며 이 문장은 셀 너비에 맞추어 자연스럽게 줄바꿈되어야 합니다. |`,
      ),
      "",
      "표 바로 다음 문장입니다. 앞의 마지막 행과 겹치면 안 됩니다.",
      "",
      "## 다음 절",
      "",
      "마지막 문장입니다.",
    ].join("\n");
    const code = `
import React,{useEffect,useRef,useState}from'react';import{createRoot}from'react-dom/client';
import{Terminal}from'@xterm/xterm';import'@xterm/xterm/css/xterm.css';
import{TerminalRich,richSelectedText}from'./src/client/TerminalRich';
import{restoreTerminalReplay}from'./src/client/terminalReplay';
import{TypographyProvider,useTypography}from'./src/client/Typography';import{terminalFontFamily}from'./src/client/typography-settings';import{ThemeProvider}from'./src/client/Theme';import{installTerminalSelection}from'./src/client/terminalSelection';
import'./src/client/styles.css';import'./src/client/themes.css';import'./src/client/rich-content.css';import'./src/client/typography.css';
const text=${JSON.stringify(text)};window.richSelectedText=richSelectedText;window.inputs=[];window.layouts=[];
function Fixture(){const mount=useRef(null),blockRef=useRef(null),offset=useRef(0);const[term,setTerm]=useState(null),[block,setBlock]=useState(null);const{updateSettings}=useTypography();
useEffect(()=>{const t=new Terminal({cols:100,rows:35,fontSize:15,fontFamily:terminalFontFamily('d2coding'),lineHeight:1.45,scrollback:1000});t.open(mount.current);t.onData(d=>window.inputs.push(d));const dispose=installTerminalSelection(mount.current,t,()=>true);window.term=t;window.settings=updateSettings;
let current={id:'0123456789abcdef0123',requestId:'fixture',sessionId:'native',text,columns:100,viewportRows:35,cwd:'/fixture',createdAt:1,state:'pending',marker:'~HBR:0123456789abcdef0123~',renderer:'rows-v2'};blockRef.current=current;setBlock(current);setTerm(t);
let paintMode='normal';
const writeScreen=data=>t.write('\\x1bc'+data);
const paint=()=>{const b=blockRef.current;if(!b.rows||paintMode==='snapshot')return;
if(paintMode==='empty'){writeScreen('NATIVE HEADER\\r\\nCompacted while idle\\r\\nNATIVE INPUT > ');return;}
if(paintMode==='split'){const m=n=>'  ~HBR:'+b.id+':'+n+'~';writeScreen(['NATIVE HEADER',...Array.from({length:5},(_,i)=>m(i)),m(5).padEnd(78)+'SUFFIX','NATIVE WRAPPED CONTINUATION',...Array.from({length:7},(_,i)=>m(i+6)),'NATIVE STATUS',...Array.from({length:6},(_,i)=>m(i+13)),'NATIVE INPUT >'].join('\\r\\n'));return;}
const start=Math.max(0,Math.min(offset.current,b.rows-1)),count=Math.min(t.rows-5,b.rows-start);writeScreen('NATIVE HEADER\\r\\n'+Array.from({length:count},(_,i)=>'  ~HBR:'+b.id+':'+(start+i)+'~').join('\\r\\n')+'\\r\\nNATIVE INPUT > ');};window.paintOffset=n=>{paintMode='normal';offset.current=n;paint();};window.clearAnswer=()=>{paintMode='empty';paint();};window.resizeFixture=(cols)=>{paintMode='normal';t.resize(cols,35);current={...blockRef.current,columns:cols,rows:undefined};blockRef.current=current;setBlock(current);};
const nativeFetch=window.fetch;window.fetch=(input,options)=>{if(typeof input==='string'&&input.includes('/rich/')){const body=JSON.parse(options.body);window.layouts.push(body);if(body.available){current={...blockRef.current,rows:blockRef.current.rows||body.rows,state:'ready'};blockRef.current=current;setBlock(current);paint();}return Promise.resolve(new Response('{}',{status:200,headers:{'Content-Type':'application/json'}}));}return nativeFetch(input,options);};
window.reflowExisting=cols=>{t.resize(cols,35);paint();};
window.paintSplit=()=>{paintMode='split';paint();};
window.restoreSnapshot=packet=>{paintMode='snapshot';return restoreTerminalReplay(t,packet.data,packet.replay,()=>true);};
return()=>{dispose();window.fetch=nativeFetch;t.dispose();};},[]);
return <><div ref={mount} className="terminal-mount" style={{position:'relative',width:1000,height:850,margin:10}}/>{term&&block&&<TerminalRich term={term} info={{id:'fixture',hostId:'fixture',cwd:'/fixture',title:'fixture',agentKind:'claude',agentSessionId:'native'}} blocks={[block]}/>}</>;}
createRoot(document.getElementById('root')).render(<ThemeProvider><TypographyProvider><Fixture/></TypographyProvider></ThemeProvider>);
`;
    await build({
      stdin: {
        contents: code,
        resolveDir: process.cwd(),
        sourcefile: "rich-layout-fixture.tsx",
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
          '<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
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
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => value !== undefined),
    ) as Record<string, string>;
    delete environment.ELECTRON_RUN_AS_NODE;
    let desktop: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      desktop = await _electron.launch({
        args: [join(directory, "main.cjs")],
        env: environment,
      });
      const page = await desktop.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.waitForFunction(() =>
        (window as any).layouts?.some((body: any) => body.available),
      );
      const article = page.locator('article[data-terminal-rich="true"]');
      await article.waitFor();
      await page.waitForFunction(
        () =>
          !!document.querySelector('article[data-terminal-rich="true"] .katex'),
      );
      const flow = await article
        .locator(".terminal-rich-content")
        .evaluate((element) => {
          const table = element.querySelector("table")!;
          const rows = [...table.querySelectorAll("tr")].map((row) =>
            row.getBoundingClientRect(),
          );
          const after = [...element.querySelectorAll("p")].find((p) =>
            p.textContent?.startsWith("표 바로 다음"),
          )!;
          return {
            rowsDoNotOverlap: rows.every(
              (row, i) => i === 0 || row.top >= rows[i - 1].bottom - 1,
            ),
            tableBottom: table.getBoundingClientRect().bottom,
            afterTop: after.getBoundingClientRect().top,
          };
        });
      assert.equal(flow.rowsDoNotOverlap, true);
      assert.ok(flow.afterTop >= flow.tableBottom - 1, JSON.stringify(flow));
      assert.equal(
        await page.locator(".terminal-rich-image").count(),
        0,
        "no SVG clone can freeze stale row heights",
      );
      // Exercise the actual backend snapshot and browser replay path, not just
      // drawing pre-arranged markers. Old wrap flags previously tore tables.
      const expected = Array.from({ length: 35 }, (_, row) =>
        row === 0
          ? "NATIVE HEADER"
          : row <= 30
            ? `~HBR:0123456789abcdef0123:${row - 1}~`
            : row === 32
              ? "NATIVE INPUT > unsent draft"
              : "",
      );
      const screenState = new TerminalScreen();
      screenState.resize(100, 35);
      let packet;
      try {
        screenState.append(
          "DIRECTORY ".repeat(500) +
            "\x1b[?1049h\x1b[H" +
            "old wrapped page ".repeat(400) +
            expected
              .map((line, row) => `\x1b[${row + 1};3H\x1b[1K${line}\x1b[K`)
              .join(""),
        );
        packet = await screenState.snapshot();
      } finally {
        screenState.dispose();
      }
      await page.evaluate(
        async (value) => (window as any).restoreSnapshot(value),
        packet,
      );
      const restoredLines = await page.evaluate(() =>
        Array.from({ length: 35 }, (_, row) =>
          (window as any).term.buffer.active
            .getLine(row)
            .translateToString(true)
            .trimStart(),
        ),
      );
      assert.deepEqual(
        restoredLines,
        expected,
        "restored screen must match every native row",
      );
      await page.waitForFunction(() => {
        const a = document.querySelector('article[data-terminal-rich="true"]');
        const t = (window as any).term;
        return (
          !!a &&
          Math.abs(
            a.getBoundingClientRect().height -
              (t.element.querySelector(".xterm-screen").getBoundingClientRect()
                .height /
                t.rows) *
                30,
          ) < 1
        );
      });
      const repairedCoverage = await page.evaluate(() => {
        const t = (window as any).term,
          rect = t.element
            .querySelector(".xterm-screen")
            .getBoundingClientRect();
        return [1, 12, 24, 30, 32].map(
          (row) =>
            !!document
              .elementFromPoint(
                rect.left + (rect.width / t.cols) * 3,
                rect.top + (rect.height / t.rows) * (row + 0.5),
              )
              ?.closest('[data-terminal-rich="true"]'),
        );
      });
      assert.deepEqual(
        repairedCoverage,
        [true, true, true, true, false],
        "all answer rows are covered while the native input stays visible",
      );
      // Simulate native virtualization: only the last reservation rows exist.
      const allocation = await page.evaluate(
        () => (window as any).layouts.find((b: any) => b.available).rows,
      );
      assert.ok(allocation > 35, "fixture must exceed a native viewport");
      await page.evaluate(
        (rows) => (window as any).paintOffset(rows - 10),
        allocation,
      );
      await page.waitForFunction(() => {
        const article = document.querySelector(
          'article[data-terminal-rich="true"]',
        );
        const t = (window as any).term;
        const cell =
          t.element.querySelector(".xterm-screen").getBoundingClientRect()
            .height / t.rows;
        return (
          !!article &&
          article.getBoundingClientRect().height > 0 &&
          article.getBoundingClientRect().height <= cell * 11
        );
      });
      const tail = await page.evaluate(() => {
        const t = (window as any).term;
        const lines = Array.from(
          { length: t.rows },
          (_, i) =>
            t.buffer.active
              .getLine(t.buffer.active.viewportY + i)
              ?.translateToString(true) || "",
        );
        const article = document
          .querySelector('article[data-terminal-rich="true"]')!
          .getBoundingClientRect();
        const screen = t.element
          .querySelector(".xterm-screen")
          .getBoundingClientRect();
        const inputRow = lines.findIndex((line: string) =>
          line.includes("NATIVE INPUT"),
        );
        return {
          noFirstMarker: !lines.some((line: string) => line.includes(":0~")),
          inputTop: screen.top + (inputRow * screen.height) / t.rows,
          bottom: article.bottom,
        };
      });
      assert.equal(tail.noFirstMarker, true);
      assert.ok(tail.bottom <= tail.inputTop + 1, JSON.stringify(tail));
      await article
        .locator(".terminal-rich-source-toggle")
        .click({ force: true });
      assert.equal(
        await article.locator(".terminal-rich-source").innerText(),
        text,
      );
      await article
        .locator(".terminal-rich-source-toggle")
        .click({ force: true });
      await page.evaluate(() => (window as any).paintOffset(0));
      const copied = await article
        .locator(".terminal-rich-content p")
        .first()
        .evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const selected = getSelection()!;
          selected.removeAllRanges();
          selected.addRange(range);
          return (window as any).richSelectedText(
            document.querySelector(".terminal-mount"),
          );
        });
      assert.equal((copied.match(/\\frac/g) || []).length, 1);
      const copiedRow = await article
        .locator("tbody tr")
        .first()
        .evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const selection = getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
          return (window as any).richSelectedText(
            document.querySelector(".terminal-mount"),
          );
        });
      assert.ok(copiedRow.includes("\t"));
      await page.evaluate(() => {
        getSelection()?.removeAllRanges();
        (window as any).paintSplit();
      });
      await page
        .waitForFunction(
          () =>
            document.querySelectorAll('article[data-terminal-rich="true"]')
              .length === 4,
          undefined,
          { timeout: 5000 },
        )
        .catch(async (error) => {
          const detail = await page.evaluate(() => ({
            articles: [...document.querySelectorAll("[data-rich-block]")].map(
              (a) => ({
                visible: a.getAttribute("data-terminal-rich"),
                slot: a.getAttribute("data-rich-fragment"),
              }),
            ),
            lines: Array.from({ length: 35 }, (_, row) =>
              (window as any).term.buffer.active
                .getLine(row)
                ?.translateToString(true),
            ),
          }));
          throw new Error(
            "Split reservation rendering failed: " + JSON.stringify(detail),
            { cause: error },
          );
        });
      const coverage = await page.evaluate(() => {
        const t = (window as any).term,
          screen = t.element
            .querySelector(".xterm-screen")
            .getBoundingClientRect();
        const points: Array<[number, number, boolean]> = [];
        for (let row = 0; row < t.rows; row++) {
          const text =
            t.buffer.active.getLine(row)?.translateToString(true) || "";
          if (text.includes("~HBR:")) points.push([row, 2, true]);
          if (text.startsWith("NATIVE")) points.push([row, 4, false]);
          if (text.includes("SUFFIX")) points.push([row, 80, false]);
        }
        const hits = points.map(([row, column, marker]) => ({
          marker,
          covered: !!document
            .elementFromPoint(
              screen.left + (column * screen.width) / t.cols,
              screen.top + ((row + 0.5) * screen.height) / t.rows,
            )
            ?.closest('[data-terminal-rich="true"]'),
        }));
        return {
          markers: hits.filter((h) => h.marker).map((h) => h.covered),
          native: hits.filter((h) => !h.marker).map((h) => h.covered),
        };
      });
      assert.equal(coverage.markers.length, 19);
      assert.ok(
        coverage.markers.every(Boolean),
        "every authenticated marker must have an answer fragment over it",
      );
      assert.ok(
        coverage.native.every((value) => !value),
        "native status, wrapped output, suffix and prompt must remain uncovered",
      );
      const splitCopy = await page.evaluate(() => {
        const articles = [
          ...document.querySelectorAll('article[data-terminal-rich="true"]'),
        ];
        const start = articles[0].querySelector("p")!,
          end = articles.at(-1)!.querySelector("p")!;
        getSelection()!.setBaseAndExtent(start, 0, end, end.childNodes.length);
        return (window as any).richSelectedText(
          document.querySelector(".terminal-mount"),
        );
      });
      assert.equal(
        splitCopy,
        copied,
        "copying across two visual fragments must return the source once",
      );
      const reverseCopy = await page.evaluate(() => {
        const s = getSelection()!,
          anchor = s.anchorNode!,
          focus = s.focusNode!,
          a = s.anchorOffset,
          f = s.focusOffset;
        s.setBaseAndExtent(focus, f, anchor, a);
        return (window as any).richSelectedText(
          document.querySelector(".terminal-mount"),
        );
      });
      assert.equal(reverseCopy, copied);
      await page.waitForTimeout(80);
      await page.evaluate(() => (window as any).clearAnswer());
      await page.waitForFunction(
        () => !document.querySelector('article[data-terminal-rich="true"]'),
      );
      assert.equal(
        await page.evaluate(() =>
          (window as any).richSelectedText(
            document.querySelector(".terminal-mount"),
          ),
        ),
        copied,
        "offscreen fragment selection keeps the exact source without covering new terminal output",
      );
      await page.evaluate(() => {
        getSelection()?.removeAllRanges();
        (window as any).paintSplit();
      });
      await page.waitForFunction(
        () =>
          document.querySelectorAll('article[data-terminal-rich="true"]')
            .length === 4,
      );
      await page.waitForTimeout(150);
      await desktop.evaluate(
        async ({ BrowserWindow }) =>
          await BrowserWindow.getAllWindows()[0].webContents.capturePage(
            undefined,
            { stayHidden: true, stayAwake: true },
          ),
      );
      await page.waitForTimeout(150);
      const screenshot = await desktop.evaluate(async ({ BrowserWindow }) =>
        (
          await BrowserWindow.getAllWindows()[0].webContents.capturePage(
            undefined,
            { stayHidden: true, stayAwake: true },
          )
        )
          .toPNG()
          .toString("base64"),
      );
      await writeFile(
        resolve(".cache/rich-fragments-latest.png"),
        Buffer.from(screenshot, "base64"),
      );
      await page.evaluate(() => (window as any).paintOffset(0));
      await page.waitForFunction(
        () =>
          document.querySelectorAll('article[data-terminal-rich="true"]')
            .length === 1,
      );
      await page.evaluate(() => (window as any).reflowExisting(80));
      await page.waitForFunction(() => {
        const article = document.querySelector(
          'article[data-terminal-rich="true"]',
        );
        const screen = document.querySelector(".xterm-screen");
        return (
          !!article &&
          !!screen &&
          article.getBoundingClientRect().width <=
            screen.getBoundingClientRect().width
        );
      });
      await page.evaluate(() => (window as any).settings({ documentSize: 24 }));
      await page.waitForTimeout(150);
      await page.evaluate(() => (window as any).clearAnswer());
      await page.waitForFunction(
        () => !document.querySelector('article[data-terminal-rich="true"]'),
      );
      assert.equal(
        await page.locator('[data-terminal-rich="true"]').count(),
        0,
        "compaction must leave no stale answer overlay",
      );
      await page.evaluate(() => (window as any).resizeFixture(80));
      await page.waitForFunction(() =>
        (window as any).layouts.some(
          (body: any) => body.columns === 80 && body.available,
        ),
      );
      assert.deepEqual(errors, []);
    } finally {
      await desktop?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      assert.ok(resolve(directory).startsWith(root + sep));
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  },
);
