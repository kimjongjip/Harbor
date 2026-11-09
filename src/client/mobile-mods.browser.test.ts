import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { _electron } from "playwright";
import { mobileFixture, origin } from "../test/mobile-fixture";

const answerId = "0123456789abcdef0123";

// Synthetic text in the native Claude 2.1.295 layout: a 100-column inline
// pane, or a 160-column right dock, plus the collapsible band above the prompt.
// Geometry was checked with an isolated mod and a local mock (no model calls).
function nativeFrame(frame: number, columns = 100) {
  const wide = columns === 160;
  const contentColumns = wide ? 109 : columns;
  const lines = Array.from({ length: 38 }, () => "");
  lines[0] = `MAIN_FRAME_${frame}`;
  lines[1] = "Claude assistant: the original answer remains readable.";
  lines[2] = "Tool output: npm test passed; nothing was sent by the phone.";
  for (let row = 3; row <= 5; row++)
    lines[row] = `~HBR:${answerId}:${row - 3}~`;
  for (let row = 6; row <= 20; row++)
    lines[row] =
      `MAIN_CODE_${frame}_${row}: const value = compute('/workspace/project/src/synthetic.ts');`;
  const pane = [
    `MOD_CODE_FRAME_${frame}`,
    "src/panel-only.ts +3 -1",
    "+ const panelOnly = 42;",
    "- const oldPanel = 21;",
    "MOD_PANE_LAST_ROW",
  ];
  if (!wide) {
    lines[21] = "╭" + "─".repeat(columns - 4) + "✕─╮";
    pane.forEach((text, index) => {
      lines[22 + index] = "│ " + text.padEnd(columns - 4) + " │";
    });
    lines[27] = "╰" + "─".repeat(columns - 2) + "╯";
  }
  lines[28] = `MOD_PET_FRAME_${frame}`.padEnd(contentColumns - 4) + "[-] ";
  lines[29] = "  (=^.^=)";
  lines[30] = " ( o.o )";
  lines[31] = "  > ^ <";
  lines[32] = "MOD_BAND_LAST_ROW";
  if (wide)
    for (let row = 0; row < 34; row++)
      lines[row] =
        lines[row].padEnd(contentColumns) +
        "│" +
        (row === 0
          ? " ".repeat(columns - contentColumns - 3) + "✕"
          : pane[row - 1] || "");
  lines[34] = "─".repeat(columns);
  lines[35] = "❯ ";
  lines[36] = "─".repeat(columns);
  lines[37] = "  manual mode on · ? for shortcuts";
  return (
    "\x1b[?1049h\x1b[?2026h\x1b[2J" +
    lines.map((line, row) => `\x1b[${row + 1};1H${line}`).join("") +
    "\x1b[36;3H\x1b[?2026l"
  );
}

test(
  "phone hides Claude mod panes locally, restores frozen output, and preserves approvals and Codex",
  { skip: process.platform !== "win32", timeout: 90000 },
  async () => {
    const f = await mobileFixture();
    const pendingRequest = {
      ...f.state.requests[0],
      kind: "permission" as const,
      title: "Run synthetic command?",
      question: "Allow Bash to run npm test?",
      permission: { toolName: "Bash", command: "npm test" },
    };
    f.state.requests = [];
    Object.assign(f.state.terminals[0], {
      title: "Synthetic Claude mods",
      agentKind: "claude",
    });
    f.screen.resize(100, 38);
    f.screen.append(nativeFrame(0));
    f.operations.answers = () => [
      {
        id: answerId,
        marker: `~HBR:${answerId}~`,
        requestId: "synthetic-mods-answer",
        sessionId: "native-fixture",
        text: "## Assistant answer\n\nASSISTANT_TEXT_PRESERVED\n\n| Result | Value |\n| --- | --- |\n| TABLE_PRESERVED | 42 |",
        columns: 100,
        viewportRows: 38,
        rows: 3,
        renderer: "rows-v2",
        createdAt: 1,
        state: "ready",
      },
    ];
    let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    const messages: { type?: string }[] = [];
    const mutations: string[] = [];
    const proxy = createServer((req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD")
        mutations.push(`${req.method} ${req.url}`);
      const upstream = request(
        f.url + req.url,
        {
          method: req.method,
          headers: {
            ...req.headers,
            host: new URL(origin).host,
            ...(req.headers.origin ? { origin } : {}),
          },
        },
        (response) => {
          res.writeHead(response.statusCode!, response.headers);
          response.pipe(res);
        },
      );
      upstream.on("error", () => {
        res.statusCode = 502;
        res.end();
      });
      req.pipe(upstream);
    });
    const sockets = new WebSocketServer({ noServer: true });
    proxy.on("upgrade", (req, socket, head) =>
      sockets.handleUpgrade(req, socket, head, (client) => {
        const remote = new WebSocket(
          f.url.replace("http:", "ws:") + "/mobile-ws",
          {
            headers: {
              host: new URL(origin).host,
              origin,
              cookie: req.headers.cookie || "",
            },
          },
        );
        const pending: string[] = [];
        client.on("message", (data) => {
          messages.push(JSON.parse(String(data)));
          if (remote.readyState === WebSocket.OPEN) remote.send(String(data));
          else pending.push(String(data));
        });
        remote.on("open", () => {
          for (const data of pending) remote.send(data);
        });
        remote.on("message", (data) => {
          if (client.readyState === WebSocket.OPEN) client.send(String(data));
        });
        remote.on("close", (code) => client.close(code === 1006 ? 1011 : code));
        client.on("close", () => remote.close());
        remote.on("error", () => client.close());
        client.on("error", () => remote.close());
      }),
    );
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const port = (proxy.address() as { port: number }).port;
    const code = new URL(f.access.pairing().url).hash;
    const main = join(f.directory, "electron-mods.cjs");
    await writeFile(
      main,
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(f.directory, "profile"))});app.commandLine.appendSwitch('disable-gpu');app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:390,height:844,webPreferences:{backgroundThrottling:false,nodeIntegration:false,contextIsolation:true,sandbox:true}});w.loadURL('http://127.0.0.1:${port}/mobile/${code}');});app.on('window-all-closed',()=>app.quit());`,
    );
    try {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      delete env.ELECTRON_RUN_AS_NODE;
      app = await _electron.launch({ args: [main], env });
      const page = await app.firstWindow();
      page.setDefaultTimeout(10000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page
        .getByRole("button", { name: "이 기기 연결", exact: true })
        .click();
      await page.getByRole("button", { name: /Synthetic Claude mods/ }).click();
      await page.waitForFunction(
        () => document.querySelector("[role=status]")?.textContent === "연결됨",
      );
      const scroll = page.locator(".terminal-scroll");
      const flow = scroll.locator(".mobile-terminal-flow");
      await flow.locator("table").waitFor();
      assert.match(await flow.innerText(), /ASSISTANT_TEXT_PRESERVED/);
      assert.match(await flow.innerText(), /TABLE_PRESERVED/);
      assert.match(await flow.innerText(), /Tool output: npm test passed/);
      assert.doesNotMatch(
        await flow.innerText(),
        /MOD_(?:CODE|PET|PANE|BAND)_|panelOnly|\(=\^\.\^=\)/,
      );
      assert.doesNotMatch(await flow.innerText(), /[╭╮╰╯│✕]|\[-\]/);
      assert.doesNotMatch(await flow.innerText(), /~HBR:/);
      await page.getByLabel("글자 크기 설정", { exact: true }).click();
      const hide = page.getByRole("checkbox", { name: "Mods 패널 숨기기" });
      assert.equal(await hide.isChecked(), true);
      const unchanged = await f.screen.snapshot();

      await hide.uncheck();
      await flow.getByText("MOD_CODE_FRAME_0", { exact: false }).waitFor();
      assert.match(await flow.innerText(), /MOD_PET_FRAME_0/);
      assert.match(await flow.innerText(), /╭─/);
      await hide.check();
      await page.waitForFunction(
        () =>
          !document
            .querySelector(".mobile-terminal-flow")
            ?.textContent?.includes("MOD_CODE_"),
      );
      assert.deepEqual(await f.screen.snapshot(), unchanged);

      // Freeze the phone projection, then change the underlying shared frame.
      // Toggling must reveal the original frozen pane, not the newer buffer.
      await scroll.hover();
      await page.mouse.wheel(0, -420);
      await page
        .getByRole("button", { name: "맨 아래로", exact: true })
        .waitFor();
      await page.waitForTimeout(250);
      const frozenTop = await scroll.evaluate((node) => node.scrollTop);
      assert.match(await flow.innerText(), /MAIN_FRAME_0/);
      assert.ok(
        frozenTop > 150,
        "fixture has enough main output to test frozen scrolling",
      );
      const emit = (data: string) => {
        f.screen.append(data);
        f.gateway.output(f.id, data);
      };
      emit(nativeFrame(1));
      await page
        .getByRole("button", { name: "새 출력 · 맨 아래로", exact: true })
        .waitFor();
      assert.match(await flow.innerText(), /MAIN_FRAME_0/);
      await hide.uncheck();
      await flow.getByText("MOD_CODE_FRAME_0", { exact: false }).waitFor();
      assert.doesNotMatch(
        await flow.innerText(),
        /MAIN_FRAME_1|MOD_CODE_FRAME_1/,
      );
      assert.ok(
        Math.abs(
          (await scroll.evaluate((node) => node.scrollTop)) - frozenTop,
        ) < 3,
      );
      await hide.check();
      await page.waitForFunction(
        () =>
          !document
            .querySelector(".mobile-terminal-flow")
            ?.textContent?.includes("MOD_CODE_"),
      );
      assert.ok(
        Math.abs(
          (await scroll.evaluate((node) => node.scrollTop)) - frozenTop,
        ) < 3,
      );
      await page.getByLabel("최신 내용으로 이동", { exact: true }).click();
      await flow.getByText("MAIN_FRAME_1", { exact: true }).waitFor();

      // Claude waiting/permission states preserve the complete native screen.
      f.state.terminals[0].agentState = "waiting";
      f.gateway.changed();
      await flow.getByText("MOD_CODE_FRAME_1", { exact: false }).waitFor();
      f.state.terminals[0].agentState = "idle";
      f.state.requests = [pendingRequest];
      f.gateway.changed();
      await page.locator(".session-requests > summary").click();
      await page
        .getByText("Allow Bash to run npm test?", { exact: true })
        .waitFor();
      assert.match(await flow.innerText(), /MOD_CODE_FRAME_1/);
      assert.equal(pendingRequest.status, "pending");
      f.state.requests = [];
      f.gateway.changed();
      await page.waitForFunction(
        () =>
          !document
            .querySelector(".mobile-terminal-flow")
            ?.textContent?.includes("MOD_CODE_"),
      );

      // A wide PC keeps its original 160 columns; only the phone omits the dock.
      f.screen.resize(160, 38);
      f.gateway.resize(f.id, 160, 38);
      emit(nativeFrame(2, 160));
      await flow.getByText("MAIN_FRAME_2", { exact: true }).waitFor();
      assert.match(await flow.innerText(), /MAIN_CODE_2_20/);
      assert.doesNotMatch(
        await flow.innerText(),
        /MOD_(?:CODE|PET|PANE|BAND)_|panelOnly/,
      );
      const wideUnchanged = await f.screen.snapshot();
      await hide.uncheck();
      await flow.getByText("MOD_CODE_FRAME_2", { exact: false }).waitFor();
      assert.match(await flow.innerText(), /MOD_PET_FRAME_2/);
      assert.deepEqual(await f.screen.snapshot(), wideUnchanged);

      // The saved option survives refresh, while Codex always retains its output.
      await page.reload();
      await page.waitForFunction(
        () => document.querySelector("[role=status]")?.textContent === "연결됨",
      );
      await flow.getByText("MOD_CODE_FRAME_2", { exact: false }).waitFor();
      await page.getByLabel("글자 크기 설정", { exact: true }).click();
      assert.equal(await hide.isChecked(), false);
      await hide.check();
      await page.waitForFunction(
        () =>
          !document
            .querySelector(".mobile-terminal-flow")
            ?.textContent?.includes("MOD_CODE_"),
      );
      f.state.terminals[0].agentKind = "codex";
      f.gateway.changed();
      await hide.waitFor({ state: "detached" });
      await flow.getByText("MOD_CODE_FRAME_2", { exact: false }).waitFor();
      assert.equal(await hide.count(), 0);
      assert.deepEqual(await f.screen.snapshot(), wideUnchanged);
      assert.equal(f.gateway.controls.view(f.id), null);
      assert.deepEqual(f.writes, []);
      assert.deepEqual(mutations, ["POST /mobile-api/pair"]);
      assert.ok(
        messages.length > 0 &&
          messages.every((message) => message.type === "subscribe"),
      );
      assert.equal(wideUnchanged.replay.cols, 160);
      assert.deepEqual(errors, []);
    } catch (error) {
      if (app) {
        const page = await app.firstWindow();
        const directory = resolve(".cache/mobile-mods-review");
        await mkdir(directory, { recursive: true });
        await page.screenshot({ path: join(directory, "failure.png") });
        await writeFile(join(directory, "failure.html"), await page.content());
        await writeFile(
          join(directory, "failure.txt"),
          await page.locator(".mobile-terminal-flow").innerText(),
        );
      }
      throw error;
    } finally {
      await app?.close();
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      await new Promise<void>((resolve) => {
        proxy.close(() => resolve());
        proxy.closeAllConnections();
      });
      await f.close();
    }
  },
);
