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
  "rich answer drag, wheel and edge scrolling remain local in a fullscreen CLI",
  {
    skip: process.platform !== "win32",
    timeout: 90000,
  },
  async () => {
    const root = resolve(".cache/rich-selection-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    const text = Array.from(
      { length: 55 },
      (_, i) =>
        `PARAGRAPH_${String(i).padStart(2, "0")} 한글과 emoji 🙂 text to select while scrolling a complete answer. More readable text on this line.`,
    ).join("\n\n");
    await build({
      stdin: {
        contents: `
import React,{useEffect,useRef,useState}from'react';import{createRoot}from'react-dom/client';
import{Terminal}from'@xterm/xterm';import'@xterm/xterm/css/xterm.css';
import{TerminalRich,richSelectedText}from'./src/client/TerminalRich';
import{TypographyProvider}from'./src/client/Typography';import{ThemeProvider}from'./src/client/Theme';import{installTerminalSelection}from'./src/client/terminalSelection';
import'./src/client/styles.css';import'./src/client/themes.css';import'./src/client/rich-content.css';import'./src/client/typography.css';
window.inputs=[];window.richSelectedText=richSelectedText;const text=${JSON.stringify(text)};
function Fixture(){const mount=useRef(null);const[term,setTerm]=useState(null),[added,setAdded]=useState(false);window.addAnswer=()=>setAdded(true);
const block={id:'0123456789abcdef0123',requestId:'fixture',sessionId:'native',text,columns:100,viewportRows:30,cwd:'/fixture',createdAt:1,state:'ready',rows:240,marker:'~HBR:0123456789abcdef0123~',renderer:'rows-v2'};
useEffect(()=>{const t=new Terminal({cols:100,rows:30,fontSize:15,lineHeight:1.4,scrollback:1000});t.open(mount.current);t.onData(d=>window.inputs.push(d));const dispose=installTerminalSelection(mount.current,t,()=>true);window.term=t;
window.paint=(offset=0)=>t.write('\\x1b[?1049h\\x1b[?1003h\\x1b[?1006h\\x1b[2J'+['NATIVE HEADER',...Array.from({length:20},(_,i)=>'  ~HBR:'+block.id+':'+(offset+i)+'~'),'NATIVE INPUT >'].map((line,row)=>'\\x1b['+(row+1)+';1H'+line).join('')+'\\x1b[23;1H');
window.paint();setTerm(t);const nativeFetch=window.fetch;window.fetch=(url,options)=>typeof url==='string'&&url.includes('/rich/')?Promise.resolve(new Response('{}',{status:200})):nativeFetch(url,options);
return()=>{dispose();t.dispose();window.fetch=nativeFetch;};},[]);
return <><button id="outside">Outside</button><div ref={mount} className="terminal-mount" style={{position:'relative',width:1000,height:700,margin:10}}/>{term&&<TerminalRich term={term} info={{id:'fixture',hostId:'fixture',cwd:'/fixture',title:'fixture',agentKind:'claude',agentSessionId:'native'}} blocks={added?[block,{...block,id:'0123456789abcdef0124'}]:[block]}/>}</>;}
createRoot(document.getElementById('root')).render(<ThemeProvider><TypographyProvider><Fixture/></TypographyProvider></ThemeProvider>);`,
        resolveDir: process.cwd(),
        sourcefile: "rich-selection-fixture.tsx",
        loader: "tsx",
      },
      bundle: true,
      outfile: join(directory, "fixture.js"),
      format: "esm",
      external: ["/fonts/*"],
      loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
      logLevel: "silent",
    });
    const web = express();
    web.use("/fonts", express.static(resolve("public/fonts")));
    web.use(express.static(directory));
    web.get("/", (_req, res) =>
      res
        .type("html")
        .send(
          '<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
        ),
    );
    const server = createServer(web);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await writeFile(
      join(directory, "main.cjs"),
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1200,height:1000,webPreferences:{backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadURL(${JSON.stringify(url)});});app.on('window-all-closed',()=>app.quit());`,
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      app = await _electron.launch({
        args: [join(directory, "main.cjs")],
        env,
      });
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const article = page.locator('article[data-terminal-rich="true"]');
      await article.waitFor();
      const first = article.locator("p").first();
      const box = await first.boundingBox();
      assert.ok(box);
      const clip = await article.boundingBox();
      assert.ok(clip);
      await page.mouse.move(box.x + 3, box.y + 8);
      await page.mouse.down();
      await page.mouse.move(box.x + 260, box.y + 12, { steps: 8 });
      await page.waitForFunction(
        () => !!getSelection()?.toString().includes("PARAGRAPH_00"),
      );
      const before = await page.evaluate(() => ({
        text: getSelection()?.toString(),
        base: (window as any).term.buffer.active.baseY,
        view: (window as any).term.buffer.active.viewportY,
      }));
      assert.equal(before.base, 0, "fullscreen CLI has no native scrollback");
      await page.mouse.wheel(0, 300);
      const reader = page.locator('[data-rich-selection-reader="true"]');
      await reader.waitFor();
      await page.waitForFunction(
        () => document.querySelector(".terminal-rich-canvas")!.scrollTop > 200,
      );
      const moved = await page.evaluate(() => ({
        text: getSelection()?.toString(),
        top: document.querySelector(".terminal-rich-canvas")!.scrollTop,
        base: (window as any).term.buffer.active.baseY,
        view: (window as any).term.buffer.active.viewportY,
        inputs: (window as any).inputs,
      }));
      assert.ok(moved.text?.includes("PARAGRAPH_00"));
      assert.ok((moved.text?.length || 0) > (before.text?.length || 0));
      assert.equal(moved.base, 0);
      assert.equal(moved.view, before.view);
      assert.deepEqual(moved.inputs, []);
      // Holding the pointer at the lower edge continues selecting without wheel.
      await page.mouse.move(box.x + 260, clip.y + clip.height - 2, {
        steps: 5,
      });
      await page.waitForFunction(
        (top) =>
          document.querySelector(".terminal-rich-canvas")!.scrollTop > top + 60,
        moved.top,
      );
      await page.mouse.up();
      const selected = await page.evaluate(() =>
        (window as any).richSelectedText(
          document.querySelector(".terminal-mount"),
        ),
      );
      assert.match(selected, /PARAGRAPH_00/);
      assert.ok(selected.length > 200);
      const end = await page.evaluate(
        () => document.querySelector(".terminal-rich-canvas")!.scrollTop,
      );
      await page.waitForTimeout(120);
      assert.equal(
        await page.evaluate(
          () => document.querySelector(".terminal-rich-canvas")!.scrollTop,
        ),
        end,
        "edge timer stops after mouseup",
      );
      // Further wheel after release preserves the exact copied text.
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(80);
      assert.equal(
        await page.evaluate(() =>
          (window as any).richSelectedText(
            document.querySelector(".terminal-mount"),
          ),
        ),
        selected,
      );
      // An unrelated native repaint must not remove/move the selected answer.
      const rectBefore = await reader.boundingBox();
      await page.evaluate(() => (window as any).addAnswer());
      await page.waitForTimeout(100);
      assert.deepEqual(
        await reader.boundingBox(),
        rectBefore,
        "new answer metadata keeps the active reader",
      );
      await page.evaluate(() => (window as any).paint(200));
      await page.waitForTimeout(100);
      assert.deepEqual(await reader.boundingBox(), rectBefore);
      assert.equal(
        await page.evaluate(() =>
          (window as any).richSelectedText(
            document.querySelector(".terminal-mount"),
          ),
        ),
        selected,
      );
      await page.evaluate(() =>
        (window as any).term.write("\x1b[2J\x1b[HNATIVE NEW OUTPUT"),
      );
      await page.waitForFunction(
        () => !document.querySelector('article[data-terminal-rich="true"]'),
      );
      assert.deepEqual(
        await reader.boundingBox(),
        rectBefore,
        "virtualized answer keeps its selected reading rectangle",
      );
      assert.equal(
        await page.evaluate(() =>
          (window as any).richSelectedText(
            document.querySelector(".terminal-mount"),
          ),
        ),
        selected,
      );
      assert.deepEqual(await page.evaluate(() => (window as any).inputs), []);
      await page.keyboard.press("Escape");
      await reader.waitFor({ state: "detached" });
      assert.equal(await page.evaluate(() => getSelection()?.toString()), "");
      // A fresh normal wheel still follows the existing native terminal route.
      await page.evaluate(() => (window as any).paint(0));
      await article.waitFor();
      await article.hover();
      await page.mouse.wheel(0, -100);
      await page.waitForFunction(() => (window as any).inputs.length > 0);
      // A clipped middle fragment opens at its existing offset, not answer start.
      await page.evaluate(() => {
        (window as any).inputs = [];
        (window as any).paint(30);
      });
      await page.waitForFunction(() =>
        document
          .querySelector<HTMLElement>(".terminal-rich-canvas")
          ?.style.top.startsWith("-"),
      );
      const middle = await article.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const p = [...element.querySelectorAll("p")].find((node) => {
          const r = node.getBoundingClientRect();
          return r.top > rect.top + 8 && r.bottom < rect.bottom - 8;
        })!;
        const r = p.getBoundingClientRect();
        return {
          x: r.x + 3,
          y: r.y + 8,
          offset: -parseFloat(
            element.querySelector<HTMLElement>(".terminal-rich-canvas")!.style
              .top,
          ),
        };
      });
      await page.mouse.move(middle.x, middle.y);
      await page.mouse.down();
      await page.mouse.move(middle.x + 200, middle.y + 2, { steps: 5 });
      await page.waitForFunction(() => !!getSelection()?.toString());
      await page.mouse.wheel(0, -60);
      await reader.waitFor();
      assert.ok(
        Math.abs(
          (await reader
            .locator(".terminal-rich-canvas")
            .evaluate((node) => node.scrollTop)) -
            (middle.offset - 60),
        ) < 3,
      );
      await page.mouse.up();
      await page.locator("#outside").click();
      await reader.waitFor({ state: "detached" });
      assert.deepEqual(await page.evaluate(() => (window as any).inputs), []);
      assert.deepEqual(errors, []);
    } finally {
      await app?.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
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
