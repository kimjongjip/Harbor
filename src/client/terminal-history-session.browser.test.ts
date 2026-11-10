import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
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
  "an unbound shared Codex terminal recovers Markdown without changing PTY input or connection",
  { skip: process.platform !== "win32", timeout: 90000 },
  async () => {
    const root = resolve(".cache/terminal-history-session-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    const id = "synthetic-shared-terminal",
      session = "11111111-2222-4333-8444-555555555555";
    const control = new TerminalControl(() => undefined),
      screen = new TerminalScreen();
    let title = "Ambiguous shared conversation",
      ambiguous = true,
      hold = false;
    let release: () => void = () => {},
      socketsOpened = 0,
      claims = 0,
      dimensions = { cols: 120, rows: 35 };
    const requests: { method: string; path: string }[] = [],
      received: string[] = [],
      sizes: unknown[] = [];
    const ending =
      "This completed response has a distinctive ending that must match the actual native terminal before its saved conversation can be displayed safely. The native input stays in the same place and keeps the current unsent draft while the saved Markdown answer appears in the reader above it.";
    const markdown = `## Rendered shared answer\n\n| Item | State |\n| --- | --- |\n| Reader | Ready |\n\n${ending}`;
    const output = () =>
      `\x1b[?1049h\x1b[?2004h\x1b[2J\x1b[HRendered shared answer\r\nItem State\r\nReader Ready\r\n${ending}\x1b[${dimensions.rows - 6};1H  Worked for 1m 2s\x1b[${dimensions.rows - 3};1H› UNSENT DRAFT\x1b[${dimensions.rows - 1};1H  GPT-6-Astra xhigh · ~ · ${title}\x1b[${dimensions.rows};1H  ← for agents · ? for shortcuts\x1b[${dimensions.rows - 3};15H`;
    screen.resize(dimensions.cols, dimensions.rows);
    screen.append(output());
    await build({
      stdin: {
        contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{Terminal}from'@xterm/xterm';import TerminalPane from'./src/client/TerminalPane';
import'./src/client/styles.css';import'./src/client/themes.css';import'./src/client/terminal-layout.css';import'./src/client/workspace.css';
Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});
window.mounts=0;window.renders=0;const open=Terminal.prototype.open;Terminal.prototype.open=function(...args){window.term=this;window.mounts++;return open.apply(this,args);};
function Fixture(){const[kind,setKind]=useState('codex');window.setKind=setKind;return <div style={{height:'100vh',display:'flex',flexDirection:'column'}}><TerminalPane info={{id:'${id}',hostId:'fixture',title:'Shared Codex',cwd:'/fixture',exited:false,program:'shell',agentKind:kind,agentConnected:true,agentState:'idle',integration:'ready',peerDelivery:'poll'}} active={true}/></div>;}
createRoot(document.getElementById('root')).render(<Fixture/>);`,
        resolveDir: process.cwd(),
        sourcefile: "shared-session-fixture.tsx",
        loader: "tsx",
      },
      bundle: true,
      outfile: join(directory, "fixture.js"),
      format: "esm",
      external: ["/fonts/*"],
      loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
      logLevel: "silent",
      plugins: [
        {
          name: "count-transcript-renders",
          setup(builder) {
            builder.onLoad(
              { filter: /[/\\]TranscriptItems\.tsx$/ },
              async ({ path }) => {
                const source = await readFile(path, "utf8"),
                  entry = "}: TranscriptItemsProps) {";
                assert.ok(source.includes(entry));
                return {
                  contents: source.replace(
                    entry,
                    entry + "\n(window as any).renders++;",
                  ),
                  loader: "tsx",
                };
              },
            );
          },
        },
      ],
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
    const thread = () => ({
      id: session,
      hostId: "fixture",
      title,
      provider: "codex",
      cwd: "/fixture",
      source: "cli",
      active: false,
    });
    app.get("/api/hosts/fixture/history", (_req, res) =>
      res.json({
        data: ambiguous
          ? [
              thread(),
              { ...thread(), id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
            ]
          : [thread()],
        nextCursor: null,
      }),
    );
    app.get(`/api/hosts/fixture/history/${session}`, (_req, res) => {
      const payload = {
        thread: thread(),
        items: [
          {
            id: "q",
            kind: "user",
            text: "Show the shared conversation",
            turnId: "one",
          },
          {
            id: "a",
            kind: "assistant",
            text: markdown,
            turnId: "one",
            phase: "final_answer",
            turnStatus: "completed",
          },
        ],
        nextCursor: null,
      };
      if (hold) {
        hold = false;
        release = () => res.json(payload);
      } else res.json(payload);
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
    const server = createServer(app),
      sockets = new WebSocketServer({ server, path: "/ws" });
    const repaint = () => {
      const data = output();
      screen.append(data);
      for (const socket of sockets.clients)
        socket.send(JSON.stringify({ type: "terminal-data", id, data }));
    };
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
        else if (message.type === "terminal-input") received.push(message.data);
        else if (message.type === "terminal-resize") {
          dimensions = { cols: message.cols, rows: message.rows };
          sizes.push(dimensions);
          screen.resize(dimensions.cols, dimensions.rows);
          repaint();
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const main = join(directory, "electron.cjs");
    await writeFile(
      main,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.commandLine.appendSwitch('disable-gpu');app.whenReady().then(()=>{new BrowserWindow({show:false,width:1400,height:950,webPreferences:{backgroundThrottling:false,contextIsolation:true,sandbox:true}}).loadURL('http://127.0.0.1:${(server.address() as { port: number }).port}/');});app.on('window-all-closed',()=>app.quit());`,
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
      const page = await desktop.firstWindow(),
        errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.waitForFunction(() => !!(window as any).term);
      for (
        let i = 0;
        i < 40 &&
        !requests.some((r) => r.path === "/api/hosts/fixture/history");
        i++
      )
        await page.waitForTimeout(100);
      assert.ok(requests.some((r) => r.path === "/api/hosts/fixture/history"));
      assert.equal(
        await page.locator(".terminal-conversation").count(),
        0,
        "duplicate titles preserve the original CLI",
      );
      assert.equal(requests.filter((r) => r.path.endsWith(session)).length, 0);
      ambiguous = false;
      title = "Recovered shared conversation";
      repaint();
      await page
        .locator(".terminal-conversation h2")
        .getByText("Rendered shared answer", { exact: true })
        .waitFor();
      assert.equal(
        await page.locator(".terminal-conversation table").count(),
        1,
      );
      assert.match(
        await page.locator(".terminal-native-flow").last().innerText(),
        /UNSENT DRAFT/,
      );
      await page.waitForTimeout(400);
      const baseline = {
        sizes: sizes.length,
        sockets: socketsOpened,
        claims,
        reads: requests.filter((r) => r.path === "/api/hosts/fixture/history")
          .length,
        renders: await page.evaluate(() => (window as any).renders),
      };
      await page.screenshot({
        path: join(root, "recovered-shared-session.png"),
      });
      await page.evaluate(() => (window as any).term.focus());
      await page.keyboard.type("abc");
      for (let i = 0; i < 8; i++) {
        repaint();
        await page.waitForTimeout(40);
      }
      await page.waitForTimeout(550);
      assert.equal(received.join(""), "abc");
      assert.equal(await page.evaluate(() => (window as any).mounts), 1);
      assert.equal(socketsOpened, baseline.sockets);
      assert.equal(sizes.length, baseline.sizes);
      assert.equal(claims, baseline.claims);
      assert.equal(
        requests.filter((r) => r.path === "/api/hosts/fixture/history").length,
        baseline.reads,
        "typing/output never starts repeated history searches",
      );
      assert.equal(
        await page.evaluate(() => (window as any).renders),
        baseline.renders,
      );
      hold = true;
      title = "Delayed replacement conversation";
      repaint();
      await page
        .locator(".terminal-conversation")
        .waitFor({ state: "detached" });
      await page.waitForTimeout(400);
      title = "Ambiguous replacement conversation";
      ambiguous = true;
      repaint();
      await page.waitForTimeout(400);
      release();
      await page.waitForTimeout(250);
      assert.equal(
        await page.locator(".terminal-conversation").count(),
        0,
        "an aborted history read cannot restore the old reader",
      );
      await page.evaluate(() => (window as any).setKind("claude"));
      const before = requests.length;
      title = "No longer Codex";
      repaint();
      await page.waitForTimeout(500);
      assert.equal(requests.length, before);
      assert.deepEqual(received, ["a", "b", "c"]);
      assert.ok(
        requests.every(
          (r) =>
            r.method === "GET" || r.path === `/api/terminals/${id}/control`,
        ),
      );
      assert.deepEqual(errors, []);
    } finally {
      await desktop?.close();
      sockets.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      screen.dispose();
      assert.ok(resolve(directory).startsWith(root + sep));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
