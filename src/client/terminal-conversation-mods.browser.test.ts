import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import { build } from "esbuild";
import { _electron } from "playwright";

test(
  "default conversation preserves live native Mods, mouse controls and input without rerendering history",
  { skip: process.platform !== "win32", timeout: 60000 },
  async () => {
    const root = resolve(".cache/conversation-mods-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    await build({
      stdin: {
        contents: `
import React,{useEffect,useRef,useState}from'react';import{createRoot}from'react-dom/client';import{Terminal}from'@xterm/xterm';import'@xterm/xterm/css/xterm.css';
import{TerminalConversation}from'./src/client/TerminalConversation';import{TerminalRich}from'./src/client/TerminalRich';
import'./src/client/styles.css';import'./src/client/themes.css';import'./src/client/terminal-layout.css';
window.inputs=[];window.writes=0;window.resizes=0;window.markdownRenders=0;
function Fixture(){const mount=useRef(null);const[term,setTerm]=useState(null),[mode,setMode]=useState('auto');window.setMode=setMode;
useEffect(()=>{const t=new Terminal({cols:160,rows:40,fontSize:14,lineHeight:1.25,allowProposedApi:true,theme:{background:'#ffffff',foreground:'#20242c'}});t.open(mount.current);window.term=t;t.onData(d=>window.inputs.push(d));setTerm(t);
const write=t.write.bind(t),resize=t.resize.bind(t);t.write=(...a)=>{window.writes++;return write(...a)};t.resize=(...a)=>{window.resizes++;return resize(...a)};
window.paint=(kind='dock',frame=0,commit=true)=>{const cols=t.cols,lines=Array(40).fill(''),dock=(kind==='dock'||kind==='slash')?109:undefined;
lines[0]='SAVED ANSWER CONFIRMED FINAL OUTPUT.';lines[2]='NEW NATIVE OUTPUT';
if(kind==='dock'&&frame===99){lines[28]='● Compacted while idle, before the prompt cache expired · turn off with';lines[29]='  "idleCompaction": false in settings.json';lines[33]=' '.repeat(70)+'✔ Update installed · /restart to apply';}
if(dock!==undefined)for(let r=0;r<34;r++)lines[r]+='\\x1b['+(r+1)+';'+(dock+1)+'H│'+(r===0?' '.repeat(cols-dock-3)+'✕ ':'\\x1b[33mCREW FRAME '+frame+' CONTEXT 42%\\x1b[0m');
if(kind==='inline'){lines[15]='╭'+'─'.repeat(cols-4)+'✕─╮';for(let r=16;r<33;r++)lines[r]='│'+('CREW FRAME '+frame+' CONTEXT 42%').padEnd(cols-2)+'│';lines[33]='╰'+'─'.repeat(cols-2)+'╯';}
if(kind==='band'){lines[28]='PET FRAME '+frame;lines[28]=lines[28].padEnd(cols-4)+'[-] ';lines[29]='  (=^.^=)';lines[32]='CONTEXT 42%';}
const prompt=kind==='inline'?35:34;lines[prompt]='─'.repeat(cols);lines[prompt+1]='❯ UNSENT DRAFT';lines[prompt+2]='─'.repeat(cols);lines[prompt+3]='  ? for shortcuts';
if(kind==='slash'){for(let r=28;r<34;r++)lines[r]='';lines[29]='  ❯ /help     Show help';lines[30]='    /theme    Change theme';lines[31]='    /doctor   Check installation';lines[35]='❯\u00a0/he ';}
if(kind==='approval'){lines[34]='─'.repeat(cols);lines[35]='Allow this command?';lines[36]='❯ 1. Yes';lines[37]='  2. No';}
t.write('\\x1b[?1049h\\x1b[?2004h\\x1b[?1000h\\x1b[?1006h\\x1b[?2026h\\x1b[2J'+lines.map((line,r)=>'\\x1b['+(r+1)+';1H'+line).join('')+'\\x1b['+(prompt+2)+';15H'+(commit?'\\x1b[?2026l':''));};window.paint();return()=>t.dispose();},[]);
const info={id:'fixture',hostId:'fixture',cwd:'/fixture',title:'Synthetic crew',agentKind:'claude',agentSessionId:'synthetic-crew',agentState:'idle'};
return <div className="terminal-instance active" style={{height:800}}><div ref={mount} className="terminal-mount" style={{position:'relative'}}/>{term&&<><TerminalRich term={term} info={info} blocks={[]} covered={mode!=='terminal'}/><TerminalConversation term={term} info={info} mode={mode}/></>}</div>}
createRoot(document.getElementById('root')).render(<Fixture/>);`,
        resolveDir: process.cwd(),
        sourcefile: "conversation-mods-fixture.tsx",
        loader: "tsx",
      },
      bundle: true,
      outfile: join(directory, "fixture.js"),
      format: "esm",
      define: { "process.env.NODE_ENV": '"production"' },
      external: ["/fonts/*"],
      loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
      logLevel: "silent",
      plugins: [
        {
          name: "count-history-renders",
          setup(plugin) {
            plugin.onLoad(
              { filter: /[\\/]RichMarkdown\.tsx$/ },
              async ({ path }) => {
                const source = await readFile(path, "utf8"),
                  target = "  const inherited = useContext(ResourceContext);";
                assert.ok(source.includes(target));
                return {
                  contents: source.replace(
                    target,
                    `  (window as any).markdownRenders++;\n${target}`,
                  ),
                  loader: "tsx",
                  resolveDir: dirname(path),
                };
              },
            );
          },
        },
      ],
    });
    const app = express();
    const timeline = Array.from({ length: 12 }, (_, i) => [
      {
        id: `q${i}`,
        kind: "user",
        turnId: `t${i}`,
        text: `Saved question ${i}`,
      },
      {
        id: `a${i}`,
        kind: "assistant",
        turnId: `t${i}`,
        text:
          i === 11
            ? "SAVED ANSWER CONFIRMED FINAL OUTPUT."
            : `Saved **answer ${i}**\n\nParagraph one.\n\nParagraph two.`,
        phase: "final_answer",
        turnStatus: "completed",
      },
    ]).flat();
    app.get("/api/hosts/fixture/history/synthetic-crew", (_req, res) =>
      res.json({
        thread: { id: "synthetic-crew", hostId: "fixture", cwd: "/fixture" },
        items: timeline,
        timeline,
        nextCursor: null,
      }),
    );
    app.use("/fonts", express.static(resolve("public/fonts")));
    app.use(express.static(directory));
    app.get("/", (_req, res) =>
      res
        .type("html")
        .send(
          '<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
        ),
    );
    const server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const main = join(directory, "main.cjs");
    await writeFile(
      main,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});require(${JSON.stringify(resolve("desktop/input-scheduling.cjs"))}).configureInputScheduling(app.commandLine);app.whenReady().then(()=>new BrowserWindow({show:false,width:1650,height:850,webPreferences:{backgroundThrottling:false,contextIsolation:true,sandbox:true}}).loadURL('http://127.0.0.1:${(server.address() as { port: number }).port}/'));app.on('window-all-closed',()=>app.quit());`,
    );
    let desktop: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE",
        ),
      );
      desktop = await _electron.launch({ args: [main], env });
      const page = await desktop.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (e) => {
        errors.push(e.message);
        console.error("Fixture error:", e.message);
      });
      await page
        .locator('[data-rich-block="conversation-assistant-a11"]')
        .waitFor();
      await page.locator('[data-native-mods="preserved"]').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(150);
      const measure = () =>
        page.evaluate(() => {
          const t = (window as any).term,
            screen = t.element
              .querySelector(".xterm-screen")
              .getBoundingClientRect(),
            overlay = document
              .querySelector(".terminal-conversation")!
              .getBoundingClientRect();
          return {
            screen: {
              left: screen.left,
              top: screen.top,
              width: screen.width,
              height: screen.height,
            },
            overlay: { right: overlay.right, bottom: overlay.bottom },
            columns: t.cols,
            rows: t.rows,
          };
        });
      let bounds = await measure();
      assert.ok(
        Math.abs(
          bounds.overlay.right -
            (bounds.screen.left + (bounds.screen.width * 109) / 160),
        ) < 1,
      );
      assert.ok(
        Math.abs(
          bounds.overlay.bottom -
            (bounds.screen.top + (bounds.screen.height * 34) / 40),
        ) < 1,
      );
      const text = await page.locator(".terminal-conversation").innerText();
      assert.match(text, /SAVED ANSWER/);
      assert.match(text, /NEW NATIVE OUTPUT/);
      assert.doesNotMatch(text, /CREW FRAME|CONTEXT 42%|UNSENT DRAFT/);
      assert.deepEqual(await page.evaluate(() => (window as any).inputs), []);
      await page.evaluate(() => {
        (window as any).markdownRenders = 0;
        (window as any).writes = 0;
        (window as any).resizes = 0;
        (window as any).savedCanvas = (
          window as any
        ).term.element.querySelector("canvas");
      });
      for (let frame = 1; frame <= 8; frame++) {
        await page.evaluate((n) => (window as any).paint("dock", n), frame);
        await page.waitForTimeout(50);
      }
      assert.deepEqual(
        await page.evaluate(() => ({
          renders: (window as any).markdownRenders,
          writes: (window as any).writes,
          resizes: (window as any).resizes,
        })),
        { renders: 0, writes: 8, resizes: 0 },
      );
      await page.screenshot({ path: join(root, "default-with-crew-dock.png") });
      await page.evaluate(() => (window as any).paint("dock", 99));
      await page.waitForTimeout(150);
      bounds = await measure();
      await page.screenshot({ path: join(root, "mods-idle-notices.png") });
      assert.ok(
        Math.abs(
          bounds.overlay.bottom -
            (bounds.screen.top + (bounds.screen.height * 28) / 40),
        ) < 1,
        "idle compaction and right-aligned update notice remain in the native footer",
      );
      assert.doesNotMatch(
        await page.locator(".terminal-conversation").innerText(),
        /Compacted while idle|Update installed|restart to apply/,
      );
      assert.equal(
        await page.evaluate(() => {
          const t = (window as any).term,
            r = t.element
              .querySelector(".xterm-screen")
              .getBoundingClientRect();
          return !!document
            .elementFromPoint(
              r.left + (r.width * 100) / 160,
              r.top + (r.height * 33.5) / 40,
            )
            ?.closest(".xterm-screen");
        }),
        true,
        "the update notice is visible directly on the native canvas",
      );
      await page.evaluate(() => (window as any).paint("dock"));
      await page.waitForTimeout(150);
      bounds = await measure();
      assert.ok(
        Math.abs(
          bounds.overlay.bottom -
            (bounds.screen.top + (bounds.screen.height * 34) / 40),
        ) < 1,
        "reader expands when the footer notices disappear",
      );
      assert.equal(
        await page.evaluate(() => (window as any).markdownRenders),
        0,
      );
      await page.evaluate(() => (window as any).paint("slash"));
      await page.waitForTimeout(150);
      bounds = await measure();
      assert.equal(await page.locator('[data-native-mods="preserved"]').count(), 1);
      assert.ok(Math.abs(bounds.overlay.right -
        (bounds.screen.left + bounds.screen.width * 109 / 160)) < 1,
        "opening slash commands keeps the live right dock visible");
      assert.ok(Math.abs(bounds.overlay.bottom -
        (bounds.screen.top + bounds.screen.height * 28 / 40)) < 1,
        "the reader stops above the native slash picker");
      assert.doesNotMatch(await page.locator(".terminal-conversation").innerText(), /Show help|Change theme|CREW FRAME/);
      await page.screenshot({ path: join(root, "mods-slash-picker.png") });
      // The CLI can leave sync output open; xterm's safety timeout commits
      // without another parsed write. The reader must recover with that paint.
      await page.evaluate(() => (window as any).paint("dock", 0, false));
      await page.waitForFunction(() => !(window as any).term.modes.synchronizedOutputMode,
        undefined, { timeout: 2500 });
      await page.waitForTimeout(100);
      bounds = await measure();
      assert.ok(Math.abs(bounds.overlay.bottom -
        (bounds.screen.top + bounds.screen.height * 34 / 40)) < 1,
        "closing the picker restores the full document height");
      const x = bounds.screen.left + (bounds.screen.width * 114.5) / 160,
        y = bounds.screen.top + (bounds.screen.height * 2.5) / 40;
      assert.equal(
        await page.evaluate(
          ({ x, y }) =>
            !!document.elementFromPoint(x, y)?.closest(".xterm-screen"),
          { x, y },
        ),
        true,
        "the actual native dock receives pointer input",
      );
      await page.mouse.click(x, y);
      const click = await page.evaluate(() => (window as any).inputs.join(""));
      assert.match(click, /\x1b\[<0;115;3M/);
      await page.evaluate(() => {
        (window as any).inputs = [];
        (window as any).term.focus();
      });
      await page.keyboard.type("X");
      assert.deepEqual(await page.evaluate(() => (window as any).inputs), [
        "X",
      ]);
      await page.evaluate(() => (window as any).setMode("terminal"));
      await page.waitForFunction(
        () =>
          (document.querySelector(".terminal-conversation") as HTMLElement)
            .hidden,
      );
      await page.evaluate(() => (window as any).setMode("auto"));
      await page.locator('[data-native-mods="preserved"]').waitFor();
      assert.equal(
        await page.evaluate(
          () =>
            (window as any).savedCanvas ===
            (window as any).term.element.querySelector("canvas"),
        ),
        true,
      );
      assert.equal(
        await page.evaluate(() => (window as any).resizes),
        0,
        "display mode changes never resize the terminal",
      );
      await page.evaluate(() => {
        (window as any).term.resize(100, 40);
        (window as any).paint("inline");
      });
      await page.waitForTimeout(150);
      bounds = await measure();
      assert.ok(
        Math.abs(
          bounds.overlay.bottom -
            (bounds.screen.top + (bounds.screen.height * 15) / 40),
        ) < 1,
        "narrow inline pane stays native below the document",
      );
      await page.screenshot({
        path: join(root, "default-with-crew-inline.png"),
      });
      await page.evaluate(() => (window as any).paint("band"));
      await page.waitForTimeout(150);
      bounds = await measure();
      assert.ok(
        Math.abs(
          bounds.overlay.bottom -
            (bounds.screen.top + (bounds.screen.height * 28) / 40),
        ) < 1,
      );
      await page.evaluate(() => (window as any).paint("approval"));
      await page.waitForFunction(
        () => !document.querySelector('[data-native-mods="preserved"]'),
      );
      await page.waitForFunction(() =>
        document
          .querySelector(".terminal-native-flow")
          ?.textContent?.includes("Allow this command?"),
      );
      assert.match(
        await page.locator(".terminal-native-flow").innerText(),
        /Allow this command\?/,
      );
      await page.evaluate(() => (window as any).paint("closed"));
      await page.waitForFunction(() =>
        document
          .querySelector(".terminal-native-flow")
          ?.textContent?.includes("UNSENT DRAFT"),
      );
      assert.equal(
        await page.locator('[data-native-mods="preserved"]').count(),
        0,
        "closing the pane restores the original conversation composer",
      );
      assert.deepEqual(errors, []);
    } finally {
      // This handle belongs solely to the fixture's Electron and isolated profile.
      await desktop?.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      assert.ok(resolve(directory).startsWith(root + sep));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
