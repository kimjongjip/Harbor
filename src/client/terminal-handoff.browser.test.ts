import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import { WebSocketServer } from "ws";
import { build } from "esbuild";
import { _electron } from "playwright";
import { TerminalControl } from "../server/terminal-control";
import { TerminalScreen } from "../server/terminal-screen";

test(
  "phone to PC handoff keeps denied keys and Harbor errors out of the terminal",
  { skip: process.platform !== "win32", timeout: 90000 },
  async () => {
    const root = resolve(".cache/terminal-handoff-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    const id = "synthetic-terminal";
    const control = new TerminalControl(() => "synthetic-native-session");
    const screen = new TerminalScreen();
    screen.resize(100, 30);
    screen.append("ORIGINAL ANSWER\r\nREADY > ");
    const received: string[] = [];
    const accepted: string[] = [];
    const sizes: { cols: number; rows: number }[] = [];
    let controlReads = 0;
    let failControlReads = false;
    let claims = 0;
    await build({
      stdin: {
        contents: `
import React from'react';import{createRoot}from'react-dom/client';
import{Terminal}from'@xterm/xterm';import TerminalPane from'./src/client/TerminalPane';
import'./src/client/styles.css';import'./src/client/themes.css';import'./src/client/terminal-layout.css';import'./src/client/workspace.css';
const open=Terminal.prototype.open;Terminal.prototype.open=function(...args){window.term=this;return open.apply(this,args);};
window.bufferText=()=>Array.from({length:window.term.buffer.active.length},(_,row)=>window.term.buffer.active.getLine(row).translateToString(true)).join('\\n').trimEnd();
createRoot(document.getElementById('root')).render(<div style={{height:'100vh',display:'flex',flexDirection:'column'}}><TerminalPane info={{id:'${id}',hostId:'fixture',title:'Synthetic terminal',cwd:'/fixture',connectionState:'connected',exited:false}} active={true}/></div>);`,
        resolveDir: process.cwd(),
        sourcefile: "fixture.tsx",
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
    app.use(express.json());
    app.get(`/api/terminals/${id}/rich`, (_req, res) =>
      res.json({ blocks: [] }),
    );
    app.get(`/api/terminals/${id}/control`, (_req, res) => {
      controlReads++;
      if (failControlReads) {
        res.status(503).json({ error: "Synthetic control status failure" });
        return;
      }
      res.json({ control: control.view(id) });
    });
    app.post(`/api/terminals/${id}/control`, (req, res) => {
      assert.deepEqual(req.body, { action: "claim" });
      claims++;
      res.json(
        control.change(id, "local", "Host PC", {
          clientId: "local",
          action: "claim",
          takeover: true,
        }),
      );
    });
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
    const sockets = new WebSocketServer({ server, path: "/ws" });
    sockets.on("connection", (socket) => {
      socket.on("message", async (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === "subscribe")
          socket.send(
            JSON.stringify({
              type: "terminal-data",
              id,
              ...(await screen.snapshot()),
            }),
          );
        else if (message.type === "terminal-input") {
          received.push(message.data);
          try {
            control.local(id);
            accepted.push(message.data);
          } catch (error) {
            // Existing deployed backends have only this untyped error packet.
            socket.send(
              JSON.stringify({
                type: "error",
                message: (error as Error).message,
              }),
            );
          }
        } else if (
          message.type === "terminal-resize" &&
          control.canResizeLocally(id)
        )
          sizes.push({ cols: message.cols, rows: message.rows });
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await writeFile(
      join(directory, "main.cjs"),
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadURL(${JSON.stringify(url)});});app.on('window-all-closed',()=>app.quit());`,
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
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.waitForFunction(
        () =>
          (window as any).term &&
          (window as any).bufferText?.().includes("ORIGINAL ANSWER") &&
          !document.querySelector(".terminal-connecting"),
      );
      assert.ok(controlReads > 0);
      const original = await page.evaluate(() => (window as any).bufferText());
      // Exercise the denial race and failed status refresh together. Even an
      // older backend's untyped error must leave an actionable takeover banner.
      failControlReads = true;
      control.change(id, "phone", "iPhone fixture", {
        clientId: "phone-tab",
        action: "claim",
        takeover: true,
      });
      await page.evaluate(() => (window as any).term.focus());
      await page.keyboard.press("a");
      await page
        .getByRole("button", { name: "여기서 제어", exact: true })
        .waitFor();
      const deniedCount = received.length;
      assert.equal(deniedCount, 1);
      await page.keyboard.type("blocked keys");
      await page.waitForTimeout(100);
      assert.equal(
        received.length,
        deniedCount,
        "known foreign ownership blocks each further key locally",
      );
      assert.deepEqual(accepted, []);
      assert.equal(
        await page.evaluate(() => (window as any).bufferText()),
        original,
        "Harbor denial did not become PTY output",
      );
      assert.equal(claims, 0, "typing must not silently take control");
      const beforeClaimSizes = sizes.length;
      const heldSize = await page.evaluate(() => ({
        cols: (window as any).term.cols,
        rows: (window as any).term.rows,
      }));
      await page.setViewportSize({ width: 900, height: 650 });
      await page.waitForTimeout(150);
      assert.deepEqual(
        await page.evaluate(() => ({
          cols: (window as any).term.cols,
          rows: (window as any).term.rows,
        })),
        heldSize,
        "read-only local view does not resize the shared terminal grid",
      );
      assert.equal(sizes.length, beforeClaimSizes);
      await page
        .getByRole("button", { name: "여기서 제어", exact: true })
        .click();
      await page
        .getByRole("button", { name: "여기서 제어", exact: true })
        .waitFor({ state: "detached" });
      await page.keyboard.type("new");
      await page.waitForTimeout(100);
      assert.deepEqual(
        accepted,
        ["n", "e", "w"],
        "only newly typed keys are sent after explicit takeover",
      );
      assert.equal(claims, 1);
      assert.equal(control.view(id)?.clientId, "local");
      assert.ok(
        sizes.length > beforeClaimSizes,
        "explicit takeover resynchronizes the native size",
      );
      failControlReads = false;
      for (const socket of sockets.clients)
        for (let i = 0; i < 3; i++)
          socket.send(
            JSON.stringify({
              type: "error",
              message: "SYNTHETIC_TRANSPORT_FAILURE",
            }),
          );
      await page
        .getByRole("alert")
        .filter({ hasText: "SYNTHETIC_TRANSPORT_FAILURE" })
        .waitFor();
      assert.equal(await page.getByRole("alert").count(), 1);
      assert.equal(
        await page.evaluate(() => (window as any).bufferText()),
        original,
      );
      assert.deepEqual(errors, []);
    } finally {
      await desktop?.close();
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      await new Promise<void>((done) => server.close(() => done()));
      screen.dispose();
      const target = resolve(directory);
      assert.ok(target.startsWith(root + sep) && target !== root);
      await rm(target, { recursive: true, force: true });
    }
  },
);
