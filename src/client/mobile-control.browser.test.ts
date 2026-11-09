import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import { build } from "esbuild";
import { _electron } from "playwright";
import { TerminalControl } from "../server/terminal-control";

test(
  "phone control survives reordered background release and abandons hidden pending claims",
  { skip: process.platform !== "win32", timeout: 90000 },
  async () => {
    const root = resolve(".cache/mobile-control-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    const controls = new TerminalControl(() => "runtime/native");
    let claims = 0;
    let renewals = 0;
    let delayRelease = false;
    let delayClaimResponse = false;
    const releases: (() => void)[] = [];
    const claimResponses: (() => void)[] = [];
    await build({
      stdin: {
        contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{useSharedInputControl}from'./src/client/mobile/useSharedInputControl';
let visible=true;Object.defineProperty(document,'visibilityState',{get:()=>visible?'visible':'hidden'});
window.visibility=(value)=>{visible=value;document.dispatchEvent(new Event('visibilitychange'));};
const api=async(path,body)=>{const r=await fetch('/mobile-api'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
function App(){const[state,setState]=useState({runtimeId:'runtime',terminals:[{id:'terminal',agentSessionId:'native'}],controls:{}});const[ready,setReady]=useState(true);window.setReady=setReady;window.ready=ready;
const control=useSharedInputControl({enabled:true,active:true,ready,state,terminal:state.terminals[0],api,update:(id,value)=>setState(s=>({...s,controls:{...s.controls,[id]:value}}))});
window.authorize=control.authorize;window.busy=control.busy;return <p>Isolated mobile control fixture</p>;}
createRoot(document.getElementById('root')).render(<App/>);`,
        resolveDir: process.cwd(),
        sourcefile: "fixture.tsx",
        loader: "tsx",
      },
      bundle: true,
      outfile: join(directory, "fixture.js"),
      format: "esm",
      logLevel: "silent",
    });
    const app = express();
    app.use(express.json());
    app.post("/mobile-api/terminals/terminal/control", (req, res) => {
      const apply = () => {
        try {
          if (req.body.action === "claim") claims++;
          if (req.body.action === "renew") renewals++;
          const result = controls.change(
            "terminal",
            "phone",
            "iPhone",
            req.body,
          );
          const respond = () => res.json(result);
          if (req.body.action === "claim" && delayClaimResponse)
            claimResponses.push(respond);
          else respond();
        } catch (error) {
          res.status(409).json({ error: (error as Error).message });
        }
      };
      if (req.body.action === "release" && delayRelease) releases.push(apply);
      else apply();
    });
    app.use(express.static(directory));
    app.get("/", (_req, res) =>
      res
        .type("html")
        .send(
          '<!doctype html><html><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
        ),
    );
    const server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await writeFile(
      join(directory, "main.cjs"),
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadURL(${JSON.stringify(url)});});app.on('window-all-closed',()=>app.quit());`,
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    let desktop: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      desktop = await _electron.launch({
        args: [join(directory, "main.cjs")],
        env,
      });
      const page = await desktop.firstWindow();
      await page.clock.install();
      await page.reload();
      await page.waitForFunction(() => !!(window as any).authorize);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      delayClaimResponse = true;
      await page.evaluate(() => {
        const w = window as any;
        w.initial = Promise.all([w.authorize(), w.authorize()]);
      });
      await assertEventually(() => claimResponses.length === 1).catch(
        (error) => {
          throw new Error(
            `${error.message}; claims=${claims}; errors=${JSON.stringify(errors)}`,
          );
        },
      );
      assert.equal(claims, 1, "concurrent sends/takeover share one claim");
      delayClaimResponse = false;
      claimResponses.shift()!();
      const initial = await page.evaluate(() => (window as any).initial);
      assert.equal(initial[0].controlToken, initial[1].controlToken);
      await page.waitForFunction(() => !(window as any).busy);

      delayRelease = true;
      await page.evaluate(() => (window as any).visibility(false));
      await assertEventually(() => releases.length === 1);
      await page.evaluate(() => (window as any).visibility(true));
      const resumed = await page.evaluate(() => (window as any).authorize());
      assert.notEqual(resumed.controlToken, initial[0].controlToken);
      releases.shift()!();
      controls.assert(
        "terminal",
        "phone",
        resumed.clientId,
        resumed.controlToken,
      );

      // Browser navigation can also background while claim's response is in flight.
      delayRelease = false;
      await page.evaluate(() => {
        const w = window as any;
        w.visibility(false);
      });
      await assertEventually(() => controls.view("terminal") === null);
      delayClaimResponse = true;
      await page.evaluate(() => {
        const w = window as any;
        w.visibility(true);
        w.pending = w.authorize().then(
          () => "unexpected success",
          (e: Error) => e.message,
        );
      });
      await assertEventually(() => claimResponses.length === 1);
      await page.evaluate(() => (window as any).visibility(false));
      delayClaimResponse = false;
      claimResponses.shift()!();
      const rejected = await page.evaluate(() => (window as any).pending);
      assert.match(rejected, /다시 시도/);
      await assertEventually(() => controls.view("terminal") === null);
      const beforeHiddenClaim = claims;
      const hidden = await page.evaluate(async () => {
        try {
          await (window as any).authorize();
          return "unexpected success";
        } catch (error) {
          return (error as Error).message;
        }
      });
      assert.match(hidden, /실시간 연결/);
      assert.equal(claims, beforeHiddenClaim);

      await page.evaluate(() => (window as any).visibility(true));
      await page.evaluate(() => (window as any).authorize());
      await page.evaluate(() => (window as any).setReady(false));
      await page.waitForFunction(() => !(window as any).ready);
      const beforeOffline = renewals;
      await page.clock.runFor(10001);
      assert.equal(
        renewals,
        beforeOffline,
        "disconnected view cannot keep renewing control",
      );
      await page.evaluate(() => (window as any).setReady(true));
      await page.waitForFunction(() => (window as any).ready);
      await page.clock.runFor(10001);
      await assertEventually(() => renewals === beforeOffline + 1);
      assert.deepEqual(errors, []);
    } finally {
      delayRelease = delayClaimResponse = false;
      for (const respond of [...releases, ...claimResponses]) respond();
      await desktop?.close();
      await new Promise<void>((done) => server.close(() => done()));
      const target = resolve(directory);
      assert.ok(target.startsWith(root + sep) && target !== root);
      await rm(target, { recursive: true, force: true });
    }
  },
);

async function assertEventually(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(check(), "expected asynchronous fixture event");
}
