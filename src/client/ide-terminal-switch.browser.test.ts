import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import { WebSocketServer } from "ws";
import { _electron } from "playwright";
import { TerminalControl } from "../server/terminal-control";
import { TerminalScreen } from "../server/terminal-screen";

test(
  "full desktop IDE moves the same live terminal and preserves drafts, splits without an external Mods installer",
  { skip: process.platform !== "win32", timeout: 90000 },
  async () => {
    const root = resolve(".cache/ide-terminal-switch-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    const host = {
      id: "fixture",
      name: "Test server",
      kind: "local",
      status: "connected",
      address: "",
      username: "",
      port: 22,
      identityFile: "",
      codexPath: "",
      defaultCwd: "/fixture",
      mode: "auto",
      color: "#3867d6",
      createdAt: 1,
      models: [],
    };
    const terminals = ["one", "two"].map((id) => ({
      id,
      hostId: host.id,
      title: `Synthetic ${id}`,
      cwd: "/fixture",
      exited: false,
      connectionState: "connected",
      agentKind: "codex",
      agentSessionId: `native-${id}`,
      agentState: "idle",
      agentConnected: true,
      integration: "unavailable",
    }));
    const state = {
      hosts: [host],
      terminals,
      sessions: [],
      activities: [],
      transfers: [],
      discussions: [],
      notices: [],
      mailbox: [],
      researchLabs: [],
      requests: [],
      connections: [],
    };
    const screens = new Map(
      terminals.map((t) => {
        const screen = new TerminalScreen();
        screen.resize(120, 38);
        screen.append(
          `\x1b[?2004hSynthetic ${t.id} history\r\n› UNSENT ${t.id} `,
        );
        return [t.id, screen];
      }),
    );
    const controls = new TerminalControl((id) => `native-${id}`);
    const input: { id: string; text: string }[] = [],
      requests: { method: string; path: string }[] = [];
    let socketsOpened = 0;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.path.startsWith("/api/"))
        requests.push({ method: req.method, path: req.path });
      next();
    });
    app.get("/api/bootstrap", (_req, res) =>
      res.json({
        token: "fixture-token",
        state,
        sshAliases: [],
        localCwd: "/fixture",
        credentialStorageAvailable: false,
        capabilities: {
          terminalReplayState: true,
          terminalInputOptimized: true,
          claudeIntegration: true,
        },
      }),
    );
    app.get("/api/health", (_req, res) =>
      res.json({ name: "codex-harbor", version: "1.18.0" }),
    );
    app.get("/api/terminals/:id/rich", (_req, res) => res.json({ blocks: [] }));
    app.get("/api/terminals/:id/usage", (req, res) =>
      res.json({
        usage: {
          provider: "codex",
          sessionId: `native-${req.params.id}`,
          usedTokens: 42000,
          contextWindow: 200000,
          usedPercent: 21,
          costUsd: null,
          updatedAt: Date.now(),
          source: "native",
        },
      }),
    );
    app.get("/api/terminals/:id/control", (req, res) =>
      res.json({ control: controls.view(req.params.id) }),
    );
    app.post("/api/terminals/:id/control", (req, res) =>
      res.json(
        controls.change(req.params.id, "local", "Host PC", {
          clientId: "local",
          action: "claim",
          takeover: true,
        }),
      ),
    );
    app.get("/api/hosts/:id/history/:session", (req, res) =>
      res.json({
        thread: { id: req.params.session, hostId: host.id, cwd: "/fixture" },
        items: [],
        timeline: [],
        nextCursor: null,
      }),
    );
    app.get("/api/editor/:id/tree", (req, res) =>
      res.json({
        terminalId: req.params.id,
        hostId: host.id,
        root: "/fixture",
        path: "/fixture",
        parent: null,
        binding: `binding-${req.params.id}`,
        entries: [],
        truncated: false,
      }),
    );
    app.get("/api/hosts/:id/files/preview", (_req, res) =>
      res.status(404).json({ error: "No fixture reports" }),
    );
    app.use("/api", (_req, res) =>
      res.json({ data: [], messages: [], requests: [], hosts: [host] }),
    );
    app.use(express.static(resolve("dist/client")));
    const server = createServer(app),
      sockets = new WebSocketServer({ server, path: "/ws" });
    sockets.on("connection", (socket) => {
      socketsOpened++;
      socket.on("message", async (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === "subscribe") {
          for (const id of message.terminals || []) {
            const screen = screens.get(id);
            if (screen)
              socket.send(
                JSON.stringify({
                  type: "terminal-data",
                  id,
                  ...(await screen.snapshot()),
                }),
              );
          }
        } else if (message.type === "terminal-input") {
          input.push({ id: message.id, text: message.data });
          screens.get(message.id)?.append(message.data);
          socket.send(
            JSON.stringify({
              type: "terminal-data",
              id: message.id,
              data: message.data,
            }),
          );
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const main = join(directory, "electron.cjs");
    await writeFile(
      main,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.commandLine.appendSwitch('disable-gpu');app.whenReady().then(()=>new BrowserWindow({show:false,width:1500,height:950,webPreferences:{backgroundThrottling:false,contextIsolation:true,sandbox:true}}).loadURL('http://127.0.0.1:${(server.address() as { port: number }).port}/'));app.on('window-all-closed',()=>app.quit());`,
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
      await page
        .locator('[data-terminal-id="one"] .terminal-native-flow')
        .getByText(/UNSENT one/)
        .waitFor();
      const pane = page.locator('[data-terminal-id="one"]');
      await pane.locator(".terminal-usage").waitFor();
      await pane.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type("abc");
      await page.waitForFunction(() =>
        document
          .querySelector('[data-terminal-id="one"]')
          ?.textContent?.includes("UNSENT one abc"),
      );
      await page
        .getByRole("button", { name: "터미널 2분할 보기", exact: true })
        .click();
      const previous = await page.evaluate(() => {
        (window as any).keptPane = document.querySelector(
          '[data-terminal-id="one"]',
        );
        (window as any).keptInput = document.querySelector(
          '[data-terminal-id="one"] .xterm-helper-textarea',
        );
        return localStorage.getItem("harbor.terminalTree");
      });
      const connections = socketsOpened,
        beforeInput = input.length;
      // An idle terminal must repaint when only the theme changes: no output,
      // resize, reconnect or keystroke should be needed to replace old colors.
      const themes = page.getByLabel("테마", { exact: true });
      const themeValues = await themes
        .locator("option")
        .evaluateAll((options) =>
          options.map((option) => (option as HTMLOptionElement).value),
        );
      for (const value of [
        ...themeValues.filter((value) => value !== "light"),
        "light",
      ]) {
        await themes.selectOption(value);
        await page.waitForFunction(
          () => {
            const row = document.querySelector(
              '[data-terminal-id="one"] [data-native-row="0"] > span',
            );
            return (
              row &&
              getComputedStyle(row).backgroundColor ===
                getComputedStyle(document.body).backgroundColor
            );
          },
          undefined,
          { timeout: 2000 },
        );
        assert.ok((await pane.innerText()).includes("UNSENT one abc"));
        assert.equal(
          await page.evaluate(() => localStorage.getItem("harbor.theme")),
          value,
        );
        assert.equal(socketsOpened, connections);
        assert.equal(input.length, beforeInput);
      }
      await page
        .getByRole("separator", { name: "왼쪽 패널 너비 조절", exact: true })
        .press("ArrowRight");
      const workspaceWidth = await page.evaluate(() =>
        localStorage.getItem("harbor.sidebarWidth"),
      );
      await page.getByRole("button", { name: "IDE", exact: true }).click();
      await page.getByLabel("IDE 작업 공간", { exact: true }).waitFor();
      await page.waitForFunction(
        () => !document.querySelector(".terminal-usage"),
      );
      const ideUsageReads = requests.filter((request) =>
        request.path.endsWith("/usage"),
      ).length;
      await page.waitForFunction(() => {
        const editor = document
          .querySelector(".harbor-ide-region")
          ?.getBoundingClientRect();
        const terminal = document
          .querySelector("#harbor-terminal-dock")
          ?.getBoundingClientRect();
        return (
          editor &&
          terminal &&
          terminal.x > editor.x + editor.width - 1 &&
          terminal.height > 500
        );
      });
      const explorer = page.locator(".ide-explorer");
      const resize = page.getByRole("separator", {
        name: "IDE 파일 탐색기 너비 조절",
        exact: true,
      });
      const handle = (await resize.boundingBox())!;
      const originalWidth = (await explorer.boundingBox())!.width;
      await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2 + 90, handle.y + 100, {
        steps: 6,
      });
      await page.mouse.up();
      assert.equal(
        Math.round((await explorer.boundingBox())!.width - originalWidth),
        90,
      );
      await resize.press("ArrowLeft");
      const preferredWidth = Math.round((await explorer.boundingBox())!.width);
      assert.equal(preferredWidth, Math.round(originalWidth) + 90 - 16);
      assert.equal(
        await page.evaluate(() =>
          localStorage.getItem("harbor.ideExplorerWidth"),
        ),
        String(preferredWidth),
      );
      assert.equal(
        await page.evaluate(() => localStorage.getItem("harbor.sidebarWidth")),
        workspaceWidth,
        "IDE and terminal sidebars keep separate widths",
      );
      await page.setViewportSize({ width: 900, height: 950 });
      await page.waitForFunction(
        () =>
          document.querySelector(".harbor-ide")!.getBoundingClientRect().width <
          500,
      );
      assert.ok((await explorer.boundingBox())!.width < preferredWidth);
      assert.ok(
        (await page.locator(".ide-main").boundingBox())!.width >= 239,
        "Narrow IDE retains usable editor space",
      );
      await page.setViewportSize({ width: 1500, height: 950 });
      await page.waitForFunction(
        (width) =>
          Math.round(
            document.querySelector(".ide-explorer")!.getBoundingClientRect()
              .width,
          ) === width,
        preferredWidth,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "터미널에서 입력", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page.evaluate(
          () =>
            (window as any).keptPane ===
              document.querySelector('[data-terminal-id="one"]') &&
            (window as any).keptInput ===
              document.querySelector(
                '[data-terminal-id="one"] .xterm-helper-textarea',
              ),
        ),
        true,
      );
      assert.equal(
        socketsOpened,
        connections,
        "Switching layout must not reopen the terminal socket",
      );
      assert.equal(
        input.length,
        beforeInput,
        "Switching layout must not submit anything",
      );
      await pane.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type("def");
      await page.waitForFunction(() =>
        document
          .querySelector('[data-terminal-id="one"]')
          ?.textContent?.includes("UNSENT one abcdef"),
      );
      await page.screenshot({ path: join(root, "same-terminal-in-ide.png") });
      assert.equal(
        requests.filter((request) => request.path.endsWith("/usage")).length,
        ideUsageReads,
        "IDE keeps usage polling stopped while preserving terminal input",
      );
      await page.getByLabel("IDE 세션", { exact: true }).selectOption("two");
      await page
        .locator('[data-terminal-id="two"] .terminal-native-flow')
        .getByText(/UNSENT two/)
        .waitFor();
      await page.getByLabel("IDE 세션", { exact: true }).selectOption("one");
      assert.equal(
        await page.evaluate(() => localStorage.getItem("harbor.terminalTree")),
        previous,
        "IDE selection preserves the terminal split layout",
      );
      await page.getByRole("button", { name: "터미널", exact: true }).click();
      await pane.locator(".terminal-usage").waitFor();
      await page.waitForFunction(
        () =>
          document
            .querySelector(".terminal-tree-grid")
            ?.getAttribute("data-layout") === "2",
      );
      assert.equal(
        await page.evaluate(
          () =>
            (window as any).keptInput ===
            document.querySelector(
              '[data-terminal-id="one"] .xterm-helper-textarea',
            ),
        ),
        true,
      );
      assert.equal(socketsOpened, connections);
      assert.equal(input.map((item) => item.text).join(""), "abcdef");
      assert.ok(input.every((item) => item.id === "one"));
      assert.equal(
        requests.some(
          (item) =>
            item.path.startsWith("/api/ide-chat") ||
            (item.method === "POST" && item.path === "/api/terminals"),
        ),
        false,
        "IDE switch must not start or attach a second AI engine",
      );
      await page.getByRole("button", { name: "IDE", exact: true }).click();
      await page
        .getByRole("button", { name: "새 AI 대화 열기", exact: true })
        .click();
      await page
        .getByLabel("AI에게 보낼 메시지", { exact: true })
        .fill("Separate unsent AI draft");
      await page
        .getByRole("button", { name: "현재 터미널로 돌아가기", exact: true })
        .click();
      await page
        .getByRole("button", { name: "새 AI 대화 열기", exact: true })
        .click();
      assert.equal(
        await page
          .getByLabel("AI에게 보낼 메시지", { exact: true })
          .inputValue(),
        "Separate unsent AI draft",
      );
      await page
        .getByRole("button", { name: "현재 터미널로 돌아가기", exact: true })
        .click();
      await page.getByRole("button", { name: "터미널", exact: true }).click();
      assert.equal(
        await page.getByRole("button", { name: /Claude Mods/ }).count(),
        0,
      );
      assert.equal(
        requests.some((request) => request.path.includes("claude-mods")),
        false,
      );
      assert.equal(input.map((item) => item.text).join(""), "abcdef");
      // Reload only this isolated fixture, never the user's running Harbor.
      await page.reload();
      await page.getByRole("button", { name: "IDE", exact: true }).click();
      await resize.waitFor();
      assert.equal(
        Math.round((await explorer.boundingBox())!.width),
        preferredWidth,
        "Explorer preference survives a fresh app view",
      );
      await resize.dblclick();
      assert.equal(Math.round((await explorer.boundingBox())!.width), 210);
      assert.equal(
        await page.evaluate(() =>
          localStorage.getItem("harbor.ideExplorerWidth"),
        ),
        null,
      );
      assert.deepEqual(errors, []);
    } finally {
      await desktop
        ?.evaluate(({ BrowserWindow }) => {
          for (const window of BrowserWindow.getAllWindows()) window.destroy();
        })
        .catch(() => {});
      await desktop?.close().catch(() => {});
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const screen of screens.values()) screen.dispose();
    }
  },
);
