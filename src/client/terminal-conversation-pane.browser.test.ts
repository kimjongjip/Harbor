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
  "TerminalPane keeps its native grid/socket/input while automatic reading and copying preserve peer control",
  { skip: process.platform !== "win32", timeout: 90000 },
  async () => {
    const root = resolve(".cache/terminal-conversation-pane-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    const id = "synthetic-reader-terminal",
      nativeSession = "synthetic-native-session";
    const control = new TerminalControl(() => nativeSession);
    const screen = new TerminalScreen();
    screen.resize(100, 30);
    screen.append("NATIVE WORK OUTPUT\r\nREADY > UNSENT DRAFT");
    let completed = false,
      socketsOpened = 0,
      claims = 0;
    const received: string[] = [],
      sizes: { cols: number; rows: number }[] = [],
      requests: { method: string; path: string }[] = [];
    await build({
      stdin: {
        contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{Terminal}from'@xterm/xterm';import TerminalPane from'./src/client/TerminalPane';
import'./src/client/styles.css';import'./src/client/themes.css';import'./src/client/terminal-layout.css';import'./src/client/workspace.css';
Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});
window.copies=[];window.opens=0;window.harborDesktop={writeClipboardText:async text=>{window.copies.push(text);return true;}};
const open=Terminal.prototype.open;Terminal.prototype.open=function(...args){window.term=this;window.opens++;return open.apply(this,args);};
window.bufferText=()=>Array.from({length:window.term.buffer.active.length},(_,row)=>window.term.buffer.active.getLine(row).translateToString(true)).join('\\n').trimEnd();
function Fixture(){const[state,setState]=useState('working');window.setAgentState=setState;return <div style={{height:'100vh',display:'flex',flexDirection:'column'}}><TerminalPane info={{id:'${id}',hostId:'fixture',title:'Synthetic reader terminal',cwd:'/fixture',connectionState:'connected',exited:false,agentKind:'codex',agentSessionId:'${nativeSession}',agentState:state}} active={true}/></div>;}
createRoot(document.getElementById('root')).render(<Fixture/>);`,
        resolveDir: process.cwd(),
        sourcefile: "terminal-conversation-pane-fixture.tsx",
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
    app.use((req, _res, next) => {
      if (req.path.startsWith("/api/"))
        requests.push({ method: req.method, path: req.path });
      next();
    });
    app.get(`/api/terminals/${id}/rich`, (_req, res) =>
      res.json({ blocks: [] }),
    );
    app.get(`/api/terminals/${id}/control`, (_req, res) =>
      res.json({ control: control.view(id) }),
    );
    app.post(`/api/terminals/${id}/control`, (_req, res) => {
      claims++;
      res.json(
        control.change(id, "local", "Host PC", {
          clientId: "local",
          action: "claim",
          takeover: true,
        }),
      );
    });
    app.get(`/api/hosts/fixture/history/${nativeSession}`, (_req, res) => {
      const timeline = [
        { id: "q1", kind: "user", turnId: "one", text: "FIRST QUESTION" },
        {
          id: "a1",
          kind: "assistant",
          turnId: "one",
          text: "FIRST ANSWER MIDDLE MESSAGE",
          phase: "final_answer",
          turnStatus: "completed",
        },
        { id: "q2", kind: "user", turnId: "two", text: "SECOND QUESTION" },
        {
          id: "tool2",
          kind: "command",
          turnId: "two",
          text: "HIDDEN TOOL DETAIL",
          turnStatus: completed ? "completed" : "inProgress",
        },
        {
          id: "a2",
          kind: "assistant",
          turnId: "two",
          text: completed ? "SECOND FINAL ANSWER" : "PARTIAL WORK",
          phase: "final_answer",
          turnStatus: completed ? "completed" : "inProgress",
        },
      ];
      res.json({
        thread: {
          id: nativeSession,
          hostId: "fixture",
          title: "Synthetic conversation",
          cwd: "/fixture",
        },
        items: timeline.filter((item) => item.kind !== "command"),
        timeline,
        nextCursor: null,
      });
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
      socketsOpened++;
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
        } else if (message.type === "terminal-resize")
          sizes.push({ cols: message.cols, rows: message.rows });
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const main = join(directory, "electron.cjs");
    await writeFile(
      main,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.commandLine.appendSwitch('disable-gpu');app.whenReady().then(()=>{new BrowserWindow({show:false,width:1100,height:850,webPreferences:{backgroundThrottling:false,contextIsolation:true,sandbox:true}}).loadURL('http://127.0.0.1:${(server.address() as { port: number }).port}/');});app.on('window-all-closed',()=>app.quit());`,
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
      await page.waitForFunction(
        () =>
          typeof (window as any).bufferText === "function" &&
          !!(window as any).term &&
          (window as any).bufferText().includes("UNSENT DRAFT"),
      );
      await page.waitForTimeout(350);
      assert.equal(
        await page.locator(".terminal-conversation").isVisible(),
        false,
      );
      await page.evaluate(() => (window as any).term.focus());
      await page.keyboard.type("abc");
      await page.waitForTimeout(100);
      assert.equal(received.join(""), "abc");
      const native = await page.evaluate(() => ({
        cols: (window as any).term.cols,
        rows: (window as any).term.rows,
        text: (window as any).bufferText(),
      }));
      const beforeSizes = sizes.length,
        beforeSockets = socketsOpened;
      completed = true;
      await page.evaluate(() => (window as any).setAgentState("idle"));
      await page
        .locator(".terminal-conversation")
        .waitFor({ state: "visible" });
      await page.getByText("SECOND FINAL ANSWER", { exact: true }).waitFor();
      await page.waitForTimeout(200);
      assert.deepEqual(
        await page.evaluate(() => ({
          cols: (window as any).term.cols,
          rows: (window as any).term.rows,
          text: (window as any).bufferText(),
        })),
        native,
        "automatic reader must not resize or overwrite the native PTY buffer",
      );
      assert.equal(sizes.length, beforeSizes);
      assert.equal(socketsOpened, beforeSockets);
      assert.equal(await page.evaluate(() => (window as any).opens), 1);
      await page.evaluate(() => {
        const term = (window as any).term;
        term.write("\x1b[" + (term.rows - 2) + ";1HREADY > UNSENT DRAFT");
      });
      await page.waitForTimeout(50);
      await page.screenshot({ path: join(root, "native-reader.png") });
      await page.evaluate(() => {
        const start = document.querySelector(
            '[data-rich-block="conversation-user-q1"] .conversation-question',
          )!.firstChild!,
          end = document.querySelector(
            '[data-rich-block="conversation-assistant-a2"] .markdown p',
          )!.firstChild!;
        const range = document.createRange();
        range.setStart(start, 0);
        range.setEnd(end, end.textContent!.length);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      });
      await page.keyboard.press("Control+c");
      await page.waitForFunction(() => (window as any).copies.length > 0);
      const copied = await page.evaluate(() => (window as any).copies.at(-1));
      assert.ok(
        copied.includes("FIRST QUESTION") &&
          copied.includes("FIRST ANSWER MIDDLE MESSAGE") &&
          copied.includes("SECOND QUESTION") &&
          copied.includes("SECOND FINAL ANSWER"),
      );
      assert.ok(!copied.includes("HIDDEN TOOL DETAIL"));
      await page.evaluate(() => {
        const first = document.querySelector(
          '[data-rich-block="conversation-user-q1"] > b',
        )!.firstChild!;
        const last = document.querySelector(
          '[data-rich-block="conversation-assistant-a2"] > b',
        )!.firstChild!;
        window
          .getSelection()!
          .setBaseAndExtent(first, 0, last, last.textContent!.length);
      });
      await page.keyboard.press("Control+c");
      await page.waitForFunction(() => (window as any).copies.length === 2);
      const withLabels = await page.evaluate(() =>
        (window as any).copies.at(-1),
      );
      assert.ok(
        withLabels.includes("FIRST QUESTION") &&
          withLabels.includes("FIRST ANSWER MIDDLE MESSAGE") &&
          withLabels.includes("SECOND QUESTION") &&
          withLabels.includes("Codex"),
      );
      assert.ok(
        !withLabels.includes("HIDDEN TOOL DETAIL"),
        "author-label selection must still exclude closed work",
      );
      assert.equal(
        received.join(""),
        "abc",
        "copy must not send Ctrl+C to the remote CLI",
      );
      await page.evaluate(() => {
        window.getSelection()!.removeAllRanges();
        (window as any).term.focus();
      });
      await page.keyboard.type("d");
      await page.waitForTimeout(100);
      assert.equal(
        received.join(""),
        "abcd",
        "native input remains usable below the reader",
      );
      control.change(id, "fixture-phone", "Fixture iPhone", {
        clientId: "phone",
        action: "claim",
        takeover: true,
      });
      await page
        .getByRole("button", { name: "여기서 제어", exact: true })
        .waitFor();
      const beforePeerSizes = sizes.length;
      await page
        .getByRole("button", { name: "현재 대화 기록 닫기", exact: true })
        .click();
      await page.locator(".terminal-conversation").waitFor({ state: "hidden" });
      await page.evaluate(() => (window as any).term.focus());
      await page.keyboard.type("must stay local");
      await page.waitForTimeout(150);
      assert.equal(received.join(""), "abcd");
      assert.equal(control.view(id)?.clientId, "phone");
      assert.equal(claims, 0);
      assert.equal(sizes.length, beforePeerSizes);
      assert.ok(
        requests.every((request) => request.method === "GET"),
        "reading/copying must not spawn, resume, claim or post input",
      );
      assert.deepEqual(errors, []);
    } finally {
      await desktop?.close();
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      await new Promise<void>((done) => server.close(() => done()));
      screen.dispose();
      assert.ok(resolve(directory).startsWith(root + sep));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
