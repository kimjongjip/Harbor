import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import { WebSocketServer } from "ws";
import { build } from "esbuild";
import { _electron } from "playwright";
import { TerminalControl } from "../server/terminal-control";
import { TerminalScreen } from "../server/terminal-screen";

function median(values: number[]) {
  return [...values].sort((left, right) => left - right)[
    Math.floor(values.length / 2)
  ];
}

// An explicit fixture-only control for repeating the scheduling A/B measurement.
// Normal test runs use the same startup helper as the shipped desktop.
const scheduling =
  process.env.HARBOR_TEST_INPUT_SCHEDULING === "default"
    ? "default"
    : "production";

test(
  `integrated terminal input preserves long history and native answers without rerendering Markdown (${scheduling} scheduling)`,
  { skip: process.platform !== "win32", timeout: 90000 },
  async (context) => {
    const root = resolve(".cache/terminal-input-performance-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    const id = "input-performance-fixture",
      sessionId = "synthetic-input-session",
      blockId = "0123456789abcdef0123";
    const anchor = "SAVED FINAL ANSWER ANCHOR UNIQUE.";
    const control = new TerminalControl(() => sessionId);
    const screen = new TerminalScreen();
    screen.resize(120, 40);
    const scrollback = Array.from(
      { length: 5000 },
      (_, i) => `Synthetic older native output ${i}\r\n`,
    ).join("");
    screen.append(
      `\x1b[?2004h${scrollback}${anchor}\r\n~HBR:${blockId}:0~\r\n~HBR:${blockId}:1~\r\n› TAIL `,
    );
    const block = {
      id: blockId,
      marker: `~HBR:${blockId}~`,
      requestId: "fixture",
      sessionId,
      text: Array.from(
        { length: 12 },
        (_, i) =>
          `## Native answer ${i}\n\nRetained **answer** with $x^2+y^2=z^2$.\n\n| Key | Value |\n| --- | --- |\n| One | Two |\n\n`,
      ).join(""),
      columns: 120,
      viewportRows: 40,
      createdAt: 1,
      state: "ready",
      rows: 3,
      renderer: "rows-v2",
    };
    const timeline = Array.from({ length: 80 }, (_, i) => [
      { id: `q${i}`, kind: "user", turnId: `turn${i}`, text: `Question ${i}` },
      {
        id: `a${i}`,
        kind: "assistant",
        turnId: `turn${i}`,
        text:
          i === 79
            ? anchor
            : `## Answer ${i}\n\n` +
              "Saved **Markdown** paragraph with [link](https://example.test).\n\n".repeat(
                4,
              ),
        phase: "final_answer",
        turnStatus: "completed",
      },
    ]).flat();
    await build({
      stdin: {
        contents: `
import React from 'react';import{createRoot}from'react-dom/client';import{Terminal}from'@xterm/xterm';import TerminalPane from'./src/client/TerminalPane';
import'./src/client/styles.css';import'./src/client/themes.css';import'./src/client/terminal-layout.css';import'./src/client/workspace.css';
Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});
window.markdownRenders=0;window.samples=[];window.probe=null;
const open=Terminal.prototype.open;Terminal.prototype.open=function(...args){window.term=this;const result=open.apply(this,args);this.onData(()=>{if(window.probe)window.probe.inputAt=performance.now();});this.onWriteParsed(()=>{if(window.probe)window.probe.parsedAt=performance.now();});return result;};
const NativeSocket=window.WebSocket;window.WebSocket=new Proxy(NativeSocket,{construct(target,args){const socket=new target(...args);socket.addEventListener('message',()=>{if(window.probe&&!window.probe.outputAt)window.probe.outputAt=performance.now();});return socket;}});
document.addEventListener('keydown',()=>{if(window.probe)window.probe.keyAt=performance.now();},true);
new MutationObserver(()=>{const p=window.probe;if(!p)return;const flow=[...document.querySelectorAll('.terminal-native-flow')].at(-1);if(flow?.textContent?.includes(p.target)){p.domAt=performance.now();window.samples.push(p);window.probe=null;}}).observe(document.getElementById('root'),{subtree:true,characterData:true,childList:true});
createRoot(document.getElementById('root')).render(<div style={{height:'100vh',display:'flex',flexDirection:'column'}}><TerminalPane info={{id:'${id}',hostId:'fixture',title:'Synthetic input benchmark',cwd:'/fixture',connectionState:'connected',exited:false,agentKind:'codex',agentSessionId:'${sessionId}',agentState:'idle'}} active={true}/></div>);`,
        resolveDir: process.cwd(),
        sourcefile: "terminal-input-performance-fixture.tsx",
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
          name: "count-markdown-renders",
          setup(plugin) {
            plugin.onLoad(
              { filter: /[\\/]RichMarkdown\.tsx$/ },
              async ({ path }) => {
                const source = await readFile(path, "utf8");
                const target =
                  "  const inherited = useContext(ResourceContext);";
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
    app.use(express.json());
    app.get(`/api/terminals/${id}/rich`, (_req, res) =>
      res.json({ blocks: [block] }),
    );
    app.post(`/api/terminals/${id}/rich/:blockId/layout`, (_req, res) =>
      res.json({ ok: true }),
    );
    app.get(`/api/terminals/${id}/control`, (_req, res) =>
      res.json({ control: control.view(id) }),
    );
    app.get(`/api/hosts/fixture/history/${sessionId}`, (_req, res) =>
      res.json({
        thread: {
          id: sessionId,
          hostId: "fixture",
          title: "Synthetic history",
          cwd: "/fixture",
        },
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
    const sockets = new WebSocketServer({ server, path: "/ws" });
    const received: string[] = [];
    sockets.on("connection", (socket) =>
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
          socket.send(
            JSON.stringify({ type: "terminal-data", id, data: message.data }),
          );
        }
      }),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const main = join(directory, "electron.cjs");
    const configureScheduling =
      scheduling === "production"
        ? `require(${JSON.stringify(resolve("desktop/input-scheduling.cjs"))}).configureInputScheduling(app.commandLine);`
        : "";
    await writeFile(
      main,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.commandLine.appendSwitch('disable-gpu');${configureScheduling}app.whenReady().then(()=>new BrowserWindow({show:false,width:1400,height:950,webPreferences:{backgroundThrottling:false,contextIsolation:true,sandbox:true}}).loadURL('http://127.0.0.1:${(server.address() as { port: number }).port}/'));app.on('window-all-closed',()=>app.quit());`,
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
      const disabledFeatures = await desktop.evaluate(({ app }) =>
        app.commandLine.getSwitchValue("disable-features"),
      );
      assert.equal(
        disabledFeatures.split(",").includes("DeferRendererTasksAfterInput"),
        scheduling === "production",
      );
      const page = await desktop.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page
        .locator('[data-rich-block="conversation-assistant-a79"]')
        .waitFor();
      await page.locator(".terminal-native-answer").waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      const word = "typingresponsive0123456789";
      const measurements = [];
      for (const scenario of ["retained answer", "long wrapped composer"]) {
        if (scenario === "long wrapped composer") {
          const output = `\x1b[3J\x1b[2J\x1b[H${scrollback}› ${"한글 프롬프트 입력 유지 ".repeat(100)}TAIL `;
          for (const socket of sockets.clients)
            socket.send(
              JSON.stringify({ type: "terminal-data", id, data: output }),
            );
          await page.waitForFunction(() =>
            document
              .querySelector(".terminal-native-flow")
              ?.textContent?.includes("한글 프롬프트"),
          );
          await page.waitForFunction(
            () =>
              document.querySelectorAll(".terminal-native-answer").length === 0,
          );
          await page.waitForTimeout(150);
          assert.ok(
            (await page.locator(".terminal-native-row").count()) < 100,
            "a multiline composer must not expose thousands of unrelated old native rows",
          );
        }
        await page.evaluate(() => {
          const state = window as any;
          state.samples = [];
          state.markdownRenders = 0;
          state.savedQuestion = document.querySelector(
            '[data-rich-block="conversation-user-q0"]',
          );
          state.term.focus();
        });
        for (let i = 0; i < word.length; i++) {
          await page.evaluate(
            (target) => {
              (window as any).probe = { target };
            },
            "TAIL " + word.slice(0, i + 1),
          );
          await page.keyboard.type(word[i]);
          await page.waitForFunction(
            (length) => (window as any).samples.length === length,
            i + 1,
            { polling: 5 },
          );
        }
        const result = await page.evaluate(() => ({
          renders: (window as any).markdownRenders,
          samples: (window as any).samples.map(
            (sample: any) => sample.domAt - sample.keyAt,
          ),
          stages: (window as any).samples.map((sample: any) => ({
            keyToInput: sample.inputAt - sample.keyAt,
            inputToOutput: sample.outputAt - sample.inputAt,
            outputToParsed: sample.parsedAt - sample.outputAt,
            parsedToDom: sample.domAt - sample.parsedAt,
          })),
          retained:
            (window as any).savedQuestion ===
            document.querySelector('[data-rich-block="conversation-user-q0"]'),
        }));
        assert.equal(
          result.renders,
          0,
          `${scenario}: typing must not render saved or retained native Markdown again`,
        );
        assert.equal(
          result.retained,
          true,
          "history DOM remains available for continuous selection",
        );
        measurements.push({ scenario, ...result });
        context.diagnostic(
          `${scenario}, median milliseconds: key-to-DOM ${median(result.samples).toFixed(1)}, input-to-output ${median(result.stages.map((stage: any) => stage.inputToOutput)).toFixed(1)}, parsed-to-DOM ${median(result.stages.map((stage: any) => stage.parsedToDom)).toFixed(1)}`,
        );
      }
      assert.equal(
        received.join(""),
        word.repeat(2),
        "each actual key travels through the existing WebSocket once, without submit",
      );
      const ime = await page.context().newCDPSession(page);
      const beforeComposition = received.join("");
      for (const text of ["ㅎ", "하", "한"]) {
        await ime.send("Input.imeSetComposition", {
          text,
          selectionStart: text.length,
          selectionEnd: text.length,
        });
        await page.waitForFunction(
          (text) =>
            document.querySelector(".terminal-native-ime .composition-view")
              ?.textContent === text,
          text,
        );
        const position = await page.evaluate(() => {
          const view = document.querySelector<HTMLElement>(
            ".terminal-native-ime .composition-view",
          )!;
          const anchor = document.querySelector("[data-native-cursor]")!;
          const range = document.createRange();
          range.selectNodeContents(view);
          const v = range.getBoundingClientRect(),
            a = anchor.getBoundingClientRect();
          // Hit-test the text layer only for this assertion; the product keeps
          // it transparent to pointer input so native focus/selection still work.
          view.style.pointerEvents = "auto";
          const top = document.elementFromPoint(v.left + 2, v.top + 2);
          view.style.removeProperty("pointer-events");
          return { x: v.left - a.left, y: v.top - a.top, onTop: top === view };
        });
        assert.ok(Math.abs(position.x) < 1 && Math.abs(position.y) < 1);
        assert.equal(
          position.onTop,
          true,
          "the composing character is visible above the conversation",
        );
        assert.equal(
          received.join(""),
          beforeComposition,
          "unfinished IME text must not be sent to the CLI",
        );
      }
      await page.screenshot({ path: join(root, "native-ime-composing.png") });
      await ime.send("Input.insertText", { text: "한" });
      await page.waitForFunction(() =>
        document
          .querySelector(".terminal-native-flow")
          ?.textContent?.includes("한"),
      );
      await page.waitForTimeout(60);
      assert.equal(
        received.join(""),
        beforeComposition + "한",
        "xterm commits the composed character exactly once",
      );
      assert.equal(await page.locator(".terminal-native-ime").count(), 0);
      await ime.send("Input.imeSetComposition", {
        text: "가",
        selectionStart: 1,
        selectionEnd: 1,
      });
      await ime.send("Input.imeSetComposition", {
        text: "",
        selectionStart: 0,
        selectionEnd: 0,
      });
      await page.waitForTimeout(60);
      assert.equal(
        received.join(""),
        beforeComposition + "한",
        "cancelled composition sends nothing",
      );
      await page.keyboard.type("Z");
      await page.waitForFunction(() =>
        document
          .querySelector(".terminal-native-flow")
          ?.textContent?.includes("한Z"),
      );
      assert.equal(
        received.join(""),
        beforeComposition + "한Z",
        "ordinary keys still use the original input path after IME cancellation",
      );
      await ime.detach();
      assert.deepEqual(errors, []);
      await writeFile(
        join(root, `input-scheduling-${scheduling}.json`),
        JSON.stringify(
          {
            scheduling,
            at: new Date().toISOString(),
            mode: "hidden isolated Electron; synthetic saved history and WebSocket echo; browser clock",
            measurements,
          },
          null,
          2,
        ),
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
