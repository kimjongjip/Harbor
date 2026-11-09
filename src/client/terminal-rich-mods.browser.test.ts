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
  "Claude Mods dock width is measured before native reservations and never covers the dock",
  { skip: process.platform !== "win32", timeout: 60000 },
  async () => {
    const root = resolve(".cache/rich-mods-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    const code = `
import React,{useEffect,useRef,useState}from'react';import{createRoot}from'react-dom/client';
import{Terminal}from'@xterm/xterm';import'@xterm/xterm/css/xterm.css';
import{TerminalRich}from'./src/client/TerminalRich';
import{TypographyProvider}from'./src/client/Typography';import{ThemeProvider}from'./src/client/Theme';
import'./src/client/styles.css';import'./src/client/themes.css';import'./src/client/rich-content.css';import'./src/client/typography.css';
window.layouts=[];window.inputs=[];
function Fixture(){const mount=useRef(null),current=useRef(null);const[term,setTerm]=useState(null),[block,setBlock]=useState(null);
useEffect(()=>{const t=new Terminal({cols:160,rows:38,fontSize:14,lineHeight:1.25,scrollback:1000});t.open(mount.current);t.onData(d=>window.inputs.push(d));window.term=t;setTerm(t);
const text=${JSON.stringify("# Completed reply\n\nThe main answer keeps its math $x^2$ and table.\n\n| Result | Value |\n|---|---|\n| Preserved | 42 |")};
const paint=()=>{const b=current.current;if(!b)return;const lines=Array.from({length:38},()=>''),dock=b.columns<160?b.columns:undefined;
lines[0]='NATIVE_HEADER';
if(b.rows){for(let row=0;row<Math.min(b.rows,29);row++)lines[row+1]='  ~HBR:'+b.id+':'+row+'~';}else lines[1]='ORIGINAL_REPLY_BEFORE_MEASUREMENT';
if(dock!==undefined)for(let row=0;row<34;row++)lines[row]=lines[row].padEnd(dock)+'│'+(row===0?' '.repeat(158-dock-1)+'✕':'MOD_PANE_PRESERVED');
lines[34]='─'.repeat(160);lines[35]='❯ ';lines[36]='─'.repeat(160);lines[37]='NATIVE_STATUS';
t.write('\\x1b[?1049h\\x1b[?2026h\\x1b[2J'+lines.map((line,row)=>'\\x1b['+(row+1)+';1H'+line).join('')+'\\x1b[36;3H\\x1b[?2026l');};
let revision=0;window.showWidth=(columns,viewportRows=38)=>{const id=(++revision).toString(16).padStart(20,'0');current.current={id,requestId:'native-'+revision,sessionId:'native',text,columns,viewportRows,createdAt:revision,state:'pending',marker:'~HBR:'+id+'~',renderer:'rows-v2'};setBlock(current.current);paint();return id;};
const original=window.fetch;window.fetch=(input,options)=>{if(typeof input==='string'&&input.includes('/rich/')){const body=JSON.parse(options.body),id=input.split('/').at(-2);window.layouts.push({id,...body});if(body.available&&current.current.id===id){current.current={...current.current,rows:body.rows,state:'ready'};setBlock(current.current);paint();}return Promise.resolve(new Response('{}',{status:200,headers:{'Content-Type':'application/json'}}));}return original(input,options);};
window.showWidth(160);return()=>{window.fetch=original;t.dispose();};},[]);
return <><div ref={mount} className="terminal-mount" style={{position:'relative',width:1500,height:760,margin:10}}/>{term&&block&&<TerminalRich term={term} info={{id:'fixture',hostId:'fixture',cwd:'/fixture',title:'fixture',agentKind:'claude',agentSessionId:'native'}} blocks={[block]}/>}</>;}
createRoot(document.getElementById('root')).render(<ThemeProvider><TypographyProvider><Fixture/></TypographyProvider></ThemeProvider>);
`;
    await build({
      stdin: {
        contents: code,
        resolveDir: process.cwd(),
        sourcefile: "rich-mods-fixture.tsx",
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
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await writeFile(
      join(directory, "main.cjs"),
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1700,height:950,webPreferences:{backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadURL(${JSON.stringify(url)});});app.on('window-all-closed',()=>app.quit());`,
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
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.waitForFunction(() =>
        (window as any).layouts?.some(
          (x: any) => x.available && x.columns === 160,
        ),
      );
      const narrow = await page.evaluate(() => (window as any).showWidth(109));
      await page.waitForFunction(
        (id) =>
          (window as any).layouts.some(
            (x: any) => x.available && x.columns === 109 && x.id === id,
          ),
        narrow,
        { timeout: 8000 },
      );
      const article = page.locator(
        `article[data-terminal-rich="true"][data-rich-block="${narrow}"]`,
      );
      await article.locator(".katex").first().waitFor();
      await article.locator("table").first().waitFor();
      assert.match(
        await article.first().innerText(),
        /Completed reply|Preserved/,
      );
      const bounds = await page.evaluate(() => {
        const t = (window as any).term,
          screen = t.element
            .querySelector(".xterm-screen")
            .getBoundingClientRect();
        return {
          separator: screen.left + (screen.width / 160) * 109,
          right: Math.max(
            ...Array.from(
              document.querySelectorAll('article[data-terminal-rich="true"]'),
            ).map((el) => el.getBoundingClientRect().right),
          ),
          columns: t.cols,
          lines: Array.from({ length: 34 }, (_, row) =>
            t.buffer.active.getLine(row).translateToString(true),
          ),
        };
      });
      assert.equal(bounds.columns, 160);
      assert.ok(
        bounds.right <= bounds.separator,
        "typesetting must stop before the native dock",
      );
      assert.ok(
        bounds.lines
          .slice(1)
          .every((line) => line.includes("MOD_PANE_PRESERVED")),
      );
      const full = await page.evaluate(() => (window as any).showWidth(160));
      await page.waitForFunction(
        (id) =>
          (window as any).layouts.some(
            (x: any) => x.available && x.columns === 160 && x.id === id,
          ),
        full,
      );
      await page
        .locator(
          `article[data-terminal-rich="true"][data-rich-block="${full}"] .katex`,
        )
        .first()
        .waitFor();
      const stale = await page.evaluate(() =>
        (window as any).showWidth(109, 37),
      );
      await page.waitForTimeout(500);
      assert.equal(
        await page.evaluate(
          (id) => (window as any).layouts.some((x: any) => x.id === id),
          stale,
        ),
        false,
        "an old viewport cannot request a new allocation",
      );
      assert.deepEqual(await page.evaluate(() => (window as any).inputs), []);
      assert.deepEqual(errors, []);
    } finally {
      await desktop?.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      assert.ok(resolve(directory).startsWith(root + sep));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
