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
  "one terminal surface keeps live output, original input, folding, cross-turn copying and peer control",
  { skip: process.platform !== "win32", timeout: 90000 },
  async () => {
    const root = resolve(".cache/terminal-conversation-pane-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    const id = "01aaaa11-2222-4444-8888-ccccc99999cc",
      nativeSession = "synthetic-native-session";
    const control = new TerminalControl(() => nativeSession);
    const screen = new TerminalScreen();
    screen.resize(100, 30);
    screen.append(
      "› SECOND QUESTION\r\n• Ran compiler\r\n  └ NATIVE WORK OUTPUT\r\n› UNSENT DRAFT",
    );
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
window.harborDesktop.captureCurrentWindow=async()=> 'iVBORw0KGgo=';
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
    const captures: Buffer[] = [];
    app.post(`/api/terminals/${id}/attachments/prepare`, (_req, res) =>
      res.json({ hostId: "fixture", path: "/fixture/attachments" }),
    );
    app.put(
      `/api/terminals/${id}/attachments`,
      express.raw({ type: "application/octet-stream" }),
      (req, res) => {
        captures.push(req.body as Buffer);
        res.json({ path: "/fixture/attachments/harbor-window-capture.png" });
      },
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
          id: "progress2",
          kind: "assistant",
          turnId: "two",
          phase: "commentary",
          text: "**Progress report** before the tool",
        },
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
          text: completed
            ? "SECOND FINAL ANSWER\n\nPublished [Git](https://example.test/repository/commit/0123456789abcdef0123456789abcdef01234567)."
            : "PARTIAL WORK",
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
        true,
      );
      assert.equal(
        await page.locator(".terminal-conversation > header").count(),
        0,
      );
      assert.equal(await page.locator(".terminal-view-modes").count(), 0);
      // The running turn: its saved question and steps render from history in
      // a live work group, which also hosts the CLI rows newer than history.
      await page
        .locator(".conversation-live-work .terminal-native-flow")
        .getByText("  └ NATIVE WORK OUTPUT", { exact: true })
        .waitFor();
      assert.equal(
        await page
          .locator(
            '.conversation-work[data-work-state="live"] [data-work-item="tool2"]',
          )
          .count(),
        1,
      );
      assert.equal(
        await page.locator('[data-rich-block="conversation-user-q2"]').count(),
        1,
      );
      assert.ok(
        (
          await page.locator(".terminal-native-flow").last().innerText()
        ).includes("UNSENT DRAFT"),
      );
      await page.screenshot({ path: join(root, "native-working.png") });
      await page.evaluate(() => (window as any).term.focus());
      await page.keyboard.type("abc");
      await page.waitForTimeout(100);
      assert.equal(received.join(""), "abc");
      const beforeSizes = sizes.length,
        beforeSockets = socketsOpened;
      completed = true;
      await page.evaluate(() => (window as any).setAgentState("idle"));
      await page.waitForTimeout(300);
      // A natively completed saved turn folds even before the CLI repaints its
      // answer; the live input line stays native and nothing is resized.
      await page
        .locator(
          '[data-turn-id="two"] > .conversation-work[data-work-state="done"]:not([open])',
        )
        .waitFor();
      assert.equal(await page.locator('[data-work-item="tool2"]').count(), 0);
      const report = page.locator('[data-history-message="progress2"]');
      assert.equal(await report.isVisible(), true);
      assert.equal(
        await report.locator("strong").innerText(),
        "Progress report",
      );
      assert.equal(
        await report.evaluate((node) => !!node.closest(".conversation-work")),
        false,
      );
      assert.equal(
        await page.locator('[data-rich-block="conversation-user-q2"]').count(),
        1,
      );
      assert.ok(
        !(await page.locator(".terminal-conversation").innerText()).includes(
          "NATIVE WORK OUTPUT",
        ),
      );
      // A saved completion cannot replace arbitrary live bytes. First deliver
      // the matching final answer through the same synthetic PTY connection.
      // Codex paints link labels rather than Markdown destinations. Its visible
      // prompt glyph can also vary by version; neither changes the native turn.
      const finalOutput =
        "\x1b[2J\x1b[H» SECOND QUESTION\r\n• Ran compiler\r\n  └ NATIVE WORK OUTPUT\r\nSECOND FINAL ANSWER\r\n\r\nPublished Git.\r\n» UNSENT DRAFT";
      screen.append(finalOutput);
      for (const socket of sockets.clients)
        socket.send(
          JSON.stringify({ type: "terminal-data", id, data: finalOutput }),
        );
      await page.waitForFunction(() =>
        (window as any).bufferText().includes("SECOND FINAL ANSWER"),
      );
      const native = await page.evaluate(() => ({
        cols: (window as any).term.cols,
        rows: (window as any).term.rows,
        text: (window as any).bufferText(),
      }));
      await page
        .locator(".terminal-conversation")
        .waitFor({ state: "visible" });
      await page
        .locator('[data-rich-block="conversation-assistant-a2"]')
        .getByText("SECOND FINAL ANSWER", { exact: true })
        .waitFor();
      assert.equal(
        await page.locator('[data-rich-block="conversation-user-q2"]').count(),
        1,
      );
      assert.equal(
        await page
          .locator('[data-rich-block="conversation-assistant-a2"]')
          .count(),
        1,
      );
      await page.waitForTimeout(200);
      const liveCut = await page.evaluate(() => ({
        boundary: document
          .querySelector(".terminal-conversation")
          ?.getAttribute("data-native-start"),
        following: document
          .querySelector(".terminal-conversation")
          ?.getAttribute("data-following"),
        row: document
          .querySelector(".terminal-native-row")
          ?.getAttribute("data-native-row"),
        text: document.querySelector(".terminal-native-flow")?.textContent,
        cursor: (window as any).term.buffer.active.cursorY,
        synced: (window as any).term.modes.synchronizedOutputMode,
        selection: window.getSelection()?.toString(),
        selected: document
          .querySelector(".terminal-conversation")
          ?.getAttribute("data-selected"),
      }));
      assert.ok(
        !liveCut.text?.includes("NATIVE WORK OUTPUT"),
        JSON.stringify(liveCut),
      );
      assert.deepEqual(
        await page.evaluate(() => ({
          cols: (window as any).term.cols,
          rows: (window as any).term.rows,
          text: (window as any).bufferText(),
        })),
        native,
        "folding must not resize or overwrite the native PTY buffer",
      );
      assert.equal(sizes.length, beforeSizes);
      assert.equal(socketsOpened, beforeSockets);
      assert.equal(await page.evaluate(() => (window as any).opens), 1);
      const layout = await page.evaluate(() => {
        const mount = document
          .querySelector(".terminal-mount")!
          .getBoundingClientRect();
        const flow = document
          .querySelector(".terminal-conversation")!
          .getBoundingClientRect();
        const documentBox = document
          .querySelector(".terminal-conversation-document")!
          .getBoundingClientRect();
        return {
          top: flow.top - mount.top,
          bottom: mount.bottom - flow.bottom,
          left: documentBox.left - mount.left,
          width: documentBox.width,
          mountWidth: mount.width,
        };
      });
      assert.ok(
        Math.abs(layout.top) < 2 && Math.abs(layout.bottom) < 2,
        "one full-height surface, no separate lower pane",
      );
      assert.ok(
        layout.left < 20 && layout.width > layout.mountWidth - 40,
        "left aligned full width",
      );
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
      await page.evaluate(() => window.getSelection()!.removeAllRanges());
      await page.locator(".conversation-work > summary").click();
      // Inside an opened group each step starts expanded and folds on its own.
      const tool2 = page.locator('[data-work-item="tool2"]');
      assert.equal(
        await tool2.evaluate((node) => (node as HTMLDetailsElement).open),
        true,
      );
      assert.equal(
        await tool2.locator(".transcript-step-title").innerText(),
        "Ran HIDDEN TOOL DETAIL",
      );
      await tool2.locator(":scope > summary").click();
      assert.equal(
        await tool2.evaluate((node) => (node as HTMLDetailsElement).open),
        false,
      );
      await page.locator(".conversation-work > summary").click();
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
      });
      const paragraph = page
        .locator('[data-rich-block="conversation-assistant-a2"] .markdown p')
        .first();
      const textBox = await paragraph.evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const box = range.getBoundingClientRect();
        return {
          x: box.left + 1,
          y: box.top + box.height / 2,
          width: box.width,
        };
      });
      await page.mouse.move(textBox.x, textBox.y);
      await page.mouse.down();
      await page.mouse.move(textBox.x + textBox.width * 0.8, textBox.y, {
        steps: 8,
      });
      await page.mouse.up();
      assert.ok(
        (
          await page.evaluate(() => window.getSelection()?.toString() || "")
        ).includes("SECOND"),
      );
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      const fold = page.locator(".conversation-work > summary");
      await fold.click();
      assert.equal(
        await page.evaluate(
          () => document.activeElement === (window as any).term.textarea,
        ),
        false,
        "fold controls keep their own focus",
      );
      await fold.click();
      await paragraph.click();
      assert.equal(
        await page.evaluate(
          () => document.activeElement === (window as any).term.textarea,
        ),
        true,
        "clicking an answer should focus the native prompt",
      );
      await page.keyboard.type("d");
      await page.evaluate(() => (window as any).term.textarea.blur());
      await page
        .locator(".terminal-conversation-body")
        .click({ position: { x: 3, y: 15 } });
      assert.equal(
        await page.evaluate(
          () => document.activeElement === (window as any).term.textarea,
        ),
        true,
        "empty reader space should also focus the prompt",
      );
      await page.keyboard.type("e");
      await page.locator(".terminal-native-flow [data-native-cursor]").click();
      await page.keyboard.type("f");
      await page.waitForTimeout(100);
      assert.equal(
        received.join(""),
        "abcdef",
        "same native input stays usable inline, without a separate composer",
      );

      const reader = page.locator(".terminal-conversation-body");
      const latest = page.getByRole("button", { name: "맨 아래로" });
      await page.evaluate(async () => {
        const term = (window as any).term;
        await new Promise<void>((done) => term.write("\x1b[?1004h", done));
        document.querySelector<HTMLElement>(
          ".terminal-conversation-body",
        )!.style.flex = "0 0 150px";
      });
      const readAbove = async () => {
        await reader.evaluate((el) => {
          el.scrollTop = 20;
        });
        await latest.waitFor();
        return reader.evaluate((el) => el.scrollTop);
      };
      const beforeClick = await readAbove();
      await page.evaluate(() => (window as any).term.textarea.blur());
      await reader.click({ position: { x: 3, y: 7 } });
      await page.waitForFunction(
        () => document.activeElement === (window as any).term.textarea,
      );
      await page.evaluate(async () => {
        await new Promise<void>((done) =>
          (window as any).term.write("\x1b[6n", done),
        );
      });
      await page.waitForTimeout(120);
      assert.equal(
        await reader.evaluate((el) => el.scrollTop),
        beforeClick,
        "click, focus reports and cursor queries preserve the reading position",
      );
      await reader.evaluate((el) => {
        el.scrollTop = el.scrollHeight - el.clientHeight - 8;
      });
      await reader.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      assert.equal(
        await latest.isVisible(),
        true,
        "layout scrolling near the end keeps reading paused",
      );
      await latest.click();
      await latest.waitFor({ state: "hidden" });
      await readAbove();
      await page.evaluate(() => (window as any).term.focus());
      await page.keyboard.type("g");
      await latest.waitFor({ state: "hidden" });
      assert.ok(
        await reader.evaluate(
          (el) => el.scrollHeight - el.clientHeight - el.scrollTop < 2,
        ),
      );
      await page.evaluate(async () => {
        await new Promise<void>((done) =>
          (window as any).term.write("\x1b[?1004l", done),
        );
        document.querySelector<HTMLElement>(
          ".terminal-conversation-body",
        )!.style.flex = "";
      });
      control.change(id, "fixture-phone", "Fixture iPhone", {
        clientId: "phone",
        action: "claim",
        takeover: true,
      });
      await page
        .getByRole("button", { name: "여기서 제어", exact: true })
        .waitFor();
      const beforePeerSizes = sizes.length;
      await page.evaluate(() => (window as any).term.textarea.blur());
      await paragraph.click();
      await page.keyboard.type("view");
      assert.equal(
        await page.evaluate(
          () => document.activeElement === (window as any).term.textarea,
        ),
        false,
      );
      await page
        .getByRole("button", { name: "터미널 원문", exact: true })
        .click();
      await page.locator(".terminal-conversation").waitFor({ state: "hidden" });
      await page.evaluate(() => (window as any).term.focus());
      await page.keyboard.type("must stay local");
      await page.waitForTimeout(150);
      assert.equal(
        received.filter((data) => !data.startsWith("\x1b")).join(""),
        "abcdefg",
      );
      assert.equal(control.view(id)?.clientId, "phone");
      assert.equal(claims, 0);
      assert.equal(sizes.length, beforePeerSizes);
      assert.ok(
        requests.every((request) => request.method === "GET"),
        "reading/copying must not spawn, resume, claim or post input",
      );
      assert.deepEqual(errors, []);
      control.revoke("fixture-phone");
      await page
        .getByRole("button", { name: "여기서 제어", exact: true })
        .waitFor({ state: "hidden" });
      await page.evaluate(() => (window as any).setAgentState("idle"));
      const captureStart = received.length;
      await page
        .getByRole("button", { name: "현재 Harbor 창 캡처 첨부" })
        .click();
      for (
        let i = 0;
        i < 80 &&
        !received
          .slice(captureStart)
          .some((data) => data.includes("harbor-window-capture.png"));
        i++
      )
        await page.waitForTimeout(50);
      assert.ok(
        received
          .slice(captureStart)
          .some((data) => data.includes("harbor-window-capture.png")),
        "captured file path reaches this terminal",
      );
      assert.deepEqual(captures, [Buffer.from("89504e470d0a1a0a", "hex")]);
      assert.ok(
        !received.slice(captureStart).includes("\r"),
        "capture never submits the draft",
      );
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
