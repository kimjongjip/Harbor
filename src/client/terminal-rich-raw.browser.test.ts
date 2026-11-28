import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import { build } from "esbuild";
import { _electron } from "playwright";

test(
  "the raw terminal view shows a typeset reply's own text over its reservation markers",
  { skip: process.platform !== "win32", timeout: 90000 },
  async () => {
    const root = resolve(".cache/rich-raw-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    const text = [
      "# 원문 제목",
      "",
      "첫 문단은 **굵게** 표시되는 원문입니다.",
      "",
      "| 열 | 값 |",
      "| --- | --- |",
      ...Array.from({ length: 8 }, (_, i) => `| 행 ${i + 1} | 값 ${i + 1} |`),
      "",
      "마지막 원문 줄",
    ].join("\n");
    const code = `
import React,{useEffect,useRef,useState}from'react';import{createRoot}from'react-dom/client';
import{Terminal}from'@xterm/xterm';import'@xterm/xterm/css/xterm.css';
import{TerminalRich,richSelectedText}from'./src/client/TerminalRich';
import{TypographyProvider}from'./src/client/Typography';import{terminalFontFamily}from'./src/client/typography-settings';import{ThemeProvider}from'./src/client/Theme';
import'./src/client/styles.css';import'./src/client/themes.css';import'./src/client/rich-content.css';import'./src/client/typography.css';
const text=${JSON.stringify(text)};window.richSelectedText=richSelectedText;window.layouts=[];
function Fixture(){const mount=useRef(null),blockRef=useRef(null);const[term,setTerm]=useState(null),[block,setBlock]=useState(null),[raw,setRaw]=useState(false);window.setRaw=setRaw;
useEffect(()=>{const t=new Terminal({cols:100,rows:30,fontSize:15,fontFamily:terminalFontFamily('d2coding'),lineHeight:1.45,scrollback:1000});t.open(mount.current);window.term=t;
let current={id:'0123456789abcdef0123',requestId:'fixture',sessionId:'native',text,columns:100,viewportRows:30,cwd:'/fixture',createdAt:1,state:'pending',marker:'~HBR:0123456789abcdef0123~',renderer:'rows-v2'};blockRef.current=current;setBlock(current);setTerm(t);
const paint=()=>{const b=blockRef.current;if(!b.rows)return;t.write('\\x1bcNATIVE HEADER\\r\\n'+Array.from({length:Math.min(b.rows,t.rows-3)},(_,i)=>'  ~HBR:'+b.id+':'+i+'~').join('\\r\\n')+'\\r\\nNATIVE INPUT > ');};
const nativeFetch=window.fetch;window.fetch=(input,options)=>{if(typeof input==='string'&&input.includes('/rich/')){const body=JSON.parse(options.body);window.layouts.push(body);if(body.available){current={...blockRef.current,rows:blockRef.current.rows||body.rows,state:'ready'};blockRef.current=current;setBlock(current);paint();}return Promise.resolve(new Response('{}',{status:200,headers:{'Content-Type':'application/json'}}));}return nativeFetch(input,options);};
return()=>{window.fetch=nativeFetch;t.dispose();};},[]);
return <><div ref={mount} className="terminal-mount" style={{position:'relative',width:1000,height:760,margin:10}}/>{term&&block&&<TerminalRich term={term} raw={raw} info={{id:'fixture',hostId:'fixture',cwd:'/fixture',title:'fixture',agentKind:'claude',agentSessionId:'native'}} blocks={[block]}/>}</>;}
createRoot(document.getElementById('root')).render(<ThemeProvider><TypographyProvider><Fixture/></TypographyProvider></ThemeProvider>);
`;
    await build({
      stdin: {
        contents: code,
        resolveDir: process.cwd(),
        sourcefile: "rich-raw-fixture.tsx",
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
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadURL(${JSON.stringify(url)});});app.on('window-all-closed',()=>app.quit());`,
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
      await article.locator(".terminal-rich-content table").waitFor();
      const sourceSelector = ".terminal-rich-terminal-source";
      assert.equal(await page.locator(sourceSelector).count(), 0);

      // Which element is painted over each reserved terminal row.
      const coverage = () =>
        page.evaluate(() => {
          const t = (window as any).term;
          const screen = t.element
            .querySelector(".xterm-screen")
            .getBoundingClientRect();
          const cell = screen.height / t.rows;
          const buffer = t.buffer.active;
          const rows: { marker: boolean; covered: boolean; text: string }[] =
            [];
          for (let row = 0; row < t.rows; row++) {
            const line =
              buffer.getLine(buffer.viewportY + row)?.translateToString(true) ||
              "";
            if (!line.includes("~HBR:")) continue;
            const hit = document.elementFromPoint(
              screen.left + 6 * (screen.width / t.cols),
              screen.top + (row + 0.5) * cell,
            );
            const pre = hit?.closest(".terminal-rich-terminal-source");
            rows.push({
              marker: true,
              covered: !!hit?.closest('article[data-terminal-rich="true"]'),
              text: pre ? "source" : hit?.className || "",
            });
          }
          return rows;
        });

      await page.evaluate(() => (window as any).setRaw(true));
      const source = page.locator(sourceSelector);
      await source.waitFor();
      const shown = await source.evaluate((pre) => {
        const style = getComputedStyle(pre);
        const content = pre.parentElement!.querySelector(
          ".terminal-rich-content",
        ) as HTMLElement;
        const t = (window as any).term;
        const screen = t.element
          .querySelector(".xterm-screen")
          .getBoundingClientRect();
        return {
          text: pre.textContent,
          lineHeight: parseFloat(style.lineHeight),
          cell: screen.height / t.rows,
          typesetHidden: getComputedStyle(content).visibility === "hidden",
          layerOpacity: getComputedStyle(pre.closest(".terminal-rich-layer")!)
            .opacity,
        };
      });
      assert.equal(shown.text, text, "the reply's source text is shown verbatim");
      assert.ok(
        Math.abs(shown.lineHeight - shown.cell) < 0.5,
        `source lines follow terminal rows: ${JSON.stringify(shown)}`,
      );
      assert.equal(shown.typesetHidden, true);
      assert.equal(shown.layerOpacity, "1");
      const rawRows = await coverage();
      assert.ok(rawRows.length > 5, JSON.stringify(rawRows));
      // No marker glyph stays visible. Source lines fill the reserved rows from
      // the top; a shorter source leaves the remaining reserved rows blank.
      const sourceLines = text.split("\n").length;
      assert.ok(
        rawRows.every((row) => row.covered),
        `every marker row is covered: ${JSON.stringify(rawRows)}`,
      );
      assert.ok(
        rawRows
          .slice(0, Math.min(sourceLines, rawRows.length))
          .every((row) => row.text === "source"),
        `reply text starts on the first reserved row: ${JSON.stringify(rawRows)}`,
      );
      assert.equal(
        await page.locator(".terminal-rich-source-toggle").count(),
        0,
        "the per-reply source toggle is not offered in the raw view",
      );

      // Selecting inside the raw view copies the original text, not markers.
      const copied = await source.evaluate((pre) => {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const selection = getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        return (window as any).richSelectedText(
          pre.closest(".terminal-rich-layer"),
        );
      });
      assert.ok(copied?.startsWith("# 원문 제목"), String(copied));
      assert.doesNotMatch(String(copied), /~HBR:/);
      await page.evaluate(() => getSelection()?.removeAllRanges());
      // A plain click on the reply text returns keyboard input to the CLI.
      await source.click({ position: { x: 40, y: 8 } });
      assert.equal(
        await page.evaluate(
          () => document.activeElement === (window as any).term.textarea,
        ),
        true,
      );

      await page.evaluate(() => (window as any).setRaw(false));
      await page.waitForFunction(
        (selector) => !document.querySelector(selector),
        sourceSelector,
      );
      assert.equal(
        await article
          .first()
          .locator(".terminal-rich-content")
          .evaluate((element) => getComputedStyle(element).visibility),
        "visible",
      );
      assert.ok(
        (await coverage()).every((row) => row.covered),
        "typeset view still covers the markers",
      );
      assert.equal(
        (await page.evaluate(() => (window as any).layouts)).filter(
          (body: any) => body.available,
        ).length,
        1,
        "switching views never re-allocates native rows",
      );
      assert.deepEqual(errors, []);
    } finally {
      await desktop?.close().catch(() => {});
      server.close();
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      }).catch(() => {});
    }
  },
);
