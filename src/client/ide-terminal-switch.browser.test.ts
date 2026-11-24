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
  { skip: process.platform !== "win32", timeout: 120000 },
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
      hosts: [host,{...host,id:"fixture-other",name:"Other fixture server",kind:"ssh",serverWorkspace:true}],
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
    const managedId = "fixture-managed-conversation";
    const chat = {
      id: managedId,
      runtimeId: "fixture-runtime",
      nativeId: "fixture-managed-native",
      hostId: host.id,
      provider: "codex",
      title: "Synthetic background work",
      cwd: "/fixture",
      model: "",
      items: [] as { id: string; kind: string; text: string }[],
      approvals: [],
      status: "idle",
      revision: 0,
      historyCursor: null,
      updatedAt: Date.now(),
    };
    const secondChat: typeof chat = {
      ...chat,
      id: "fixture-managed-claude",
      nativeId: "fixture-native-claude",
      provider: "claude",
      title: "Fixture second conversation",
      status: "idle",
      items: [],
    };
    const otherCodex: typeof chat = {
      ...chat,
      id: "fixture-second-codex",
      nativeId: "fixture-second-codex-native",
      title: "Second Codex analysis",
      items: [],
    };
    const conversations = [chat, secondChat, otherCodex];
    let codexCreations = 0;
    app.post("/api/ide-chat/conversations", (req, res) => {
      const c =
        req.body.provider === "claude"
          ? secondChat
          : codexCreations++ === 0
            ? chat
            : otherCodex;
      res.json({ ...c, revision: ++c.revision });
    });
    app.get("/api/ide-chat/conversations/:id", (req, res) => {
      const c = conversations.find((c) => c.id === req.params.id);
      if (!c) {
        res.sendStatus(404);
        return;
      }
      res.json({ ...c, revision: ++c.revision });
    });
    app.get("/api/ide-chat/conversations/:id/usage", (req, res) => {
      const owner = conversations.find((v) => v.id === req.params.id);
      if (!owner) {
        res.sendStatus(404);
        return;
      }
      const first = owner === chat;
      res.json({
        usage: {
          provider: owner.provider,
          sessionId: owner.nativeId,
          model: first
            ? "fixture-codex-usage"
            : owner === otherCodex
              ? "fixture-second-codex-usage"
              : "fixture-claude-usage",
          usedTokens: first ? 36000 : 77000,
          contextWindow: 100000,
          usedPercent: first ? 36 : 77,
          costUsd: first ? 1.23 : 4.56,
          updatedAt: Date.now(),
          source: "native",
        },
        work: {
          updatedAt: Date.now(),
          jobs: first
            ? [
                {
                  id: "fixture-sim",
                  pid: 456,
                  kind: "simulator",
                  task: "fixture simulation",
                  state: "running",
                },
              ]
            : [],
        },
      });
    });
    app.post("/api/ide-chat/conversations/:id/messages", (req, res) => {
      const target = conversations.find((c) => c.id === req.params.id);
      if (!target) {
        res.sendStatus(404);
        return;
      }
      target.items.push({
        id: req.body.requestId,
        kind: "user",
        text: req.body.text,
      });
      target.status = "running";
      res.json({
        ok: true,
        requestId: req.body.requestId,
        status: "submitted",
      });
    });
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
      const globalUpdate = page.locator(".harbor-topbar").getByRole("button", {name:"Harbor 업데이트"});
      const checkUpdateLocation = async () => {
        await globalUpdate.waitFor();
        assert.equal(await page.getByRole("button", {name:"Harbor 업데이트"}).count(), 1);
        assert.ok(await globalUpdate.evaluate(button => {
          const box = button.getBoundingClientRect();
          return box.left >= 0 && box.right <= innerWidth &&
            button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
        }), "visible text update entry is accessible in the top bar");
      };
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page
        .locator('[data-terminal-id="one"] .terminal-native-flow')
        .getByText(/UNSENT one/)
        .waitFor();
      const pane = page.locator('[data-terminal-id="one"]');
      await checkUpdateLocation();
      const sidebarToggle = page.locator(".harbor-topbar .sidebar-toggle");
      await sidebarToggle.click();
      await checkUpdateLocation();
      await sidebarToggle.click();
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
      await checkUpdateLocation();
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
      await page
        .getByRole("button", { name: "터미널 2분할 보기", exact: true })
        .click();
      const mark = input.length;
      for (const [id, key] of [
        ["two", "g"],
        ["one", "h"],
      ]) {
        const target = page.locator('[data-terminal-id="' + id + '"]');
        await target
          .locator(".terminal-conversation-body")
          .click({ position: { x: 3, y: 12 } });
        await page.keyboard.type(key);
        await page.waitForFunction(
          ({ id, key }) =>
            document
              .querySelector(
                '[data-terminal-id="' + id + '"] .terminal-native-flow',
              )
              ?.textContent?.includes(key),
          { id, key },
        );
      }
      await page.waitForTimeout(100);
      assert.deepEqual(
        input.slice(mark),
        [
          { id: "two", text: "g" },
          { id: "one", text: "h" },
        ],
        "pane background clicks route typing to the clicked terminal",
      );
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
      await page.getByRole("button", { name: "AI 대화", exact: true }).click();
      const managed = page.locator(".managed-chat-workspace");
      await checkUpdateLocation();
      const emptyRail = managed.getByRole("complementary", { name: "Codex 컨텍스트 사용량" });
      await emptyRail.getByText("Harbor", { exact: true }).waitFor();
      await emptyRail.getByText("대화를 시작하면 표시됩니다.", { exact: true }).waitFor();
      assert.ok(!requests.some(r => r.path.startsWith("/api/ide-chat/conversations/") && r.path.endsWith("/usage")), "new chat sends no managed telemetry requests");
      await managed
        .getByLabel("AI에게 보낼 메시지")
        .fill("Independent managed draft");
      await page.getByRole("button", { name: "터미널", exact: true }).click();
      await page.getByRole("button", { name: "AI 대화", exact: true }).click();
      assert.equal(
        await managed.getByLabel("AI에게 보낼 메시지").inputValue(),
        "Independent managed draft",
      );
      assert.equal(
        requests.some(
          (r) =>
            r.path === "/api/ide-chat/conversations" && r.method === "POST",
        ),
        false,
      );
      const composer = managed.getByRole("textbox", {
        name: "AI에게 보낼 메시지",
      });
      await managed
        .getByRole("button", { name: "AI 메시지 전송", exact: true })
        .click();
      await managed
        .getByText("Independent managed draft", { exact: true })
        .waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLTextAreaElement>(
            '.managed-chat-workspace textarea[aria-label="AI에게 보낼 메시지"]',
          )?.value === "",
      );
      await composer.fill("Follow-up draft while the turn is running");
      const panel = managed.getByRole("complementary", {
        name: "Codex 컨텍스트 사용량",
      });
      await panel.getByText("fixture-codex-usage", { exact: true }).waitFor();
      await panel.locator(".crew-main").waitFor();
      await panel.getByText("fixture simulation", { exact: true }).waitFor();
      assert.match(
        await panel.locator(".terminal-usage-percent").innerText(),
        /36%/,
      );
      assert.match(
        await panel.locator(".terminal-usage-cost").innerText(),
        /1\.23/,
      );
      const panelBox = await panel.boundingBox(),
        composerBox = await composer.boundingBox();
      assert.ok(
        panelBox &&
          composerBox &&
          panelBox.x >= composerBox.x + composerBox.width - 2,
        "Harbor panel occupies the right column",
      );
      await panel.getByRole("button", { name: "상태 패널 접기" }).click();
      await panel.locator(".terminal-usage-compact").waitFor();
      assert.equal(
        await composer.inputValue(),
        "Follow-up draft while the turn is running",
      );
      await panel.getByRole("button", { name: "상태 패널 펼치기" }).click();
      await panel.locator(".crew-main").waitFor();
      await page.setViewportSize({ width: 700, height: 950 });
      await panel.waitFor({ state: "hidden" });
      assert.equal(
        await composer.inputValue(),
        "Follow-up draft while the turn is running",
      );
      await page.setViewportSize({ width: 1500, height: 950 });
      await panel.locator(".crew-main").waitFor();
      const picker = managed.getByLabel("AI 제공자");
      await picker.selectOption("claude");
      await composer.fill("Question for Claude");
      await managed
        .getByRole("button", { name: "AI 메시지 전송", exact: true })
        .click();
      const claudePanel = managed.getByRole("complementary", {
        name: "Claude 컨텍스트 사용량",
      });
      await claudePanel
        .getByText("fixture-claude-usage", { exact: true })
        .waitFor();
      assert.match(
        await claudePanel.locator(".terminal-usage-percent").innerText(),
        /77%/,
      );
      assert.match(
        await claudePanel.locator(".terminal-usage-cost").innerText(),
        /4\.56/,
      );
      assert.equal(
        await managed.getByText("fixture-codex-usage", { exact: true }).count(),
        0,
      );
      assert.equal(
        await claudePanel
          .getByText("fixture simulation", { exact: true })
          .count(),
        0,
      );
      await picker.selectOption("codex");
      await panel.getByText("fixture-codex-usage", { exact: true }).waitFor();
      const tabs = managed.getByRole("tablist", { name: "열린 AI 대화" });
      const tabA = tabs.getByRole("tab", { name: /Synthetic background work/ }),
        tabB = tabs.getByRole("tab", { name: /Second Codex analysis/ });
      await tabA.waitFor();
      await managed
        .getByRole("button", { name: "새 대화", exact: true })
        .click();
      assert.equal(await composer.inputValue(), "");
      await composer.fill("Independent second Codex question");
      await managed
        .getByRole("button", { name: "AI 메시지 전송", exact: true })
        .click();
      await tabB.waitFor();
      await panel
        .getByText("fixture-second-codex-usage", { exact: true })
        .waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLTextAreaElement>(
            '.managed-chat-workspace textarea[aria-label="AI에게 보낼 메시지"]',
          )?.value === "",
      );
      await composer.fill("Second Codex follow-up draft");
      const tabOrder = () => tabs.getByRole("tab").evaluateAll(nodes=>nodes.map(n=>n.getAttribute("aria-label")));
      const expectedOrder = await tabOrder();
      const beforeMove = expectedOrder.indexOf(await tabB.getAttribute("aria-label"));
      assert.ok(beforeMove >= 0);
      const afterMove = beforeMove === 0 ? 1 : beforeMove - 1;
      [expectedOrder[beforeMove], expectedOrder[afterMove]] = [expectedOrder[afterMove], expectedOrder[beforeMove]];
      await tabB.press(beforeMove === 0 ? "Alt+ArrowRight" : "Alt+ArrowLeft");
      assert.deepEqual(await tabOrder(), expectedOrder, "keyboard reorders the selected tab");
      await tabB.dragTo(tabA);
      assert.notDeepEqual(await tabOrder(), expectedOrder, "dragging moves the tab within this window");
      await tabB.dragTo(tabs.getByRole("tab").nth(afterMove));
      assert.deepEqual(await tabOrder(), expectedOrder);
      assert.equal(await tabB.getAttribute("aria-selected"), "true");
      assert.equal(await composer.inputValue(), "Second Codex follow-up draft");
      chat.items.push({
        id: "progress-a",
        kind: "assistant",
        text: "Progress for the first Codex conversation",
      });
      assert.equal(
        await managed
          .getByText("Progress for the first Codex conversation", {
            exact: true,
          })
          .count(),
        0,
      );
      await tabA.click();
      await managed
        .getByText("Progress for the first Codex conversation", { exact: true })
        .waitFor();
      await panel.getByText("fixture-codex-usage", { exact: true }).waitFor();
      await page
        .locator('[data-host-id="fixture-other"]')
        .getByRole("button", { name: "Other fixture server", exact: true })
        .click();
      assert.equal(
        await tabA.count(),
        0,
        "a different host and durable transport do not inherit direct Codex tabs",
      );
      assert.equal(await composer.inputValue(), "");
      await page
        .locator('[data-host-id="fixture"]')
        .getByRole("button", { name: "Test server", exact: true })
        .click();
      await tabA.waitFor();
      await panel.getByText("fixture-codex-usage", { exact: true }).waitFor();
      assert.equal(
        await composer.inputValue(),
        "Follow-up draft while the turn is running",
      );
      await page.evaluate(() => {
        localStorage.setItem("harbor.managedHost.main", "fixture");
        localStorage.setItem("harbor.managedHost.main.view", "chat");
      });
      await page.reload();
      await page
        .getByRole("button", { name: "터미널", exact: true, pressed: true })
        .waitFor();
      await page
        .locator(".terminal-instance.active .xterm-helper-textarea")
        .first()
        .waitFor({ state: "attached" });
      assert.equal(await managed.isVisible(), false);
      await page.getByRole("button", { name: "AI 대화", exact: true }).click();
      await managed
        .getByText("Independent managed draft", { exact: true })
        .waitFor();
      assert.equal(
        await composer.inputValue(),
        "Follow-up draft while the turn is running",
      );
      assert.equal(chat.status, "running");
      assert.equal(chat.items.filter((i) => i.kind === "user").length, 1);
      assert.equal(await tabs.getByRole("tab").count(), 3);
      assert.deepEqual(await tabOrder(), expectedOrder, "restored tabs retain their names and order");
      await managed.screenshot({path:join(directory,"managed-tabs-and-harbor-panel.png")});
      await tabB.click();
      await panel
        .getByText("fixture-second-codex-usage", { exact: true })
        .waitFor();
      assert.equal(await composer.inputValue(), "Second Codex follow-up draft");
      page.once("dialog", (dialog) => dialog.dismiss());
      const closeB = managed.getByRole("button", {
        name: /Second Codex analysis 탭 닫기/,
      });
      await closeB.click();
      assert.equal(
        await composer.inputValue(),
        "Second Codex follow-up draft",
        "canceling close keeps the draft",
      );
      page.once("dialog", (dialog) => dialog.accept());
      await closeB.click();
      await tabB.waitFor({ state: "detached" });
      assert.equal(otherCodex.status, "running");
      assert.equal(
        requests.filter(
          (r) => r.method === "POST" && r.path.endsWith("/interrupt"),
        ).length,
        0,
      );
      await tabA.click();
      await panel.getByText("fixture-codex-usage", { exact: true }).waitFor();
      assert.equal(
        await composer.inputValue(),
        "Follow-up draft while the turn is running",
      );
      assert.equal(
        requests.filter(
          (r) =>
            r.path === "/api/ide-chat/conversations" && r.method === "POST",
        ).length,
        3,
      );
      // The HTTP response can precede the WS inventory. Neither background
      // completion should steal an explicit selection made after startup.
      await page.route("**/api/bootstrap",async route=>{
        const original=await route.fetch(),boot=await original.json();
        await route.fulfill({response:original,json:{...boot,state:{...boot.state,terminals:[]}}});
      });
      let permitReply!:()=>void;
      const held=new Promise<void>(resolve=>{permitReply=resolve;});
      await page.route("**/api/terminals",async route=>{
        if(route.request().method()!=="POST")return route.continue();
        assert.equal(route.request().postDataJSON().startupPlaceholder,true);
        await held;
        await route.fulfill({json:{...terminals[0],startupPlaceholder:true}});
      });
      const startup=page.waitForRequest(r=>r.method()==="POST" && new URL(r.url()).pathname==="/api/terminals");
      await page.reload();
      await startup;
      await page.getByRole("button",{name:"AI 대화",exact:true}).click();
      await composer.fill("Keep typing while the startup terminal connects");
      const replied=page.waitForResponse(r=>r.request().method()==="POST" && new URL(r.url()).pathname==="/api/terminals");
      permitReply();
      await replied;
      await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
      assert.equal(await managed.isVisible(),true,"background POST completion preserves managed chat");
      for(const socket of sockets.clients) socket.send(JSON.stringify({type:"state",state:{...state,terminals:[{...terminals[0],startupPlaceholder:true}]}}));
      await page.waitForFunction(()=>!!document.querySelector('[data-terminal-id="one"]'));
      await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
      assert.equal(await managed.isVisible(),true,"delayed socket inventory preserves managed chat");
      assert.equal(await composer.inputValue(),"Keep typing while the startup terminal connects");
      await page.route("**/api/update/workspaces", route => route.fulfill({json:{targetVersion:"2.0.8",hosts:[]}}));
      await globalUpdate.click();
      await page.getByRole("button",{name:"서버 작업 공간 설정",exact:true}).click();
      const workspaceSettings = page.getByRole("region",{name:"서버에서 세션 유지",exact:true});
      await workspaceSettings.waitFor();
      assert.ok(await workspaceSettings.evaluate(section=>{
        const rect=section.getBoundingClientRect();
        return document.activeElement === section && rect.top < innerHeight && rect.bottom > 0;
      }), "setup goes directly to the saved SSH server's visible, focused workspace settings");
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
