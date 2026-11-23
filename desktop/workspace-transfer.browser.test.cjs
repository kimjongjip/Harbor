const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { _electron: electron } = require("playwright");

test(
  "desktop windows transfer live tabs, preserve backend inventory and return tabs on close",
  { skip: process.platform !== "win32", timeout: 95000 },
  async () => {
    const parent = path.resolve(".cache/window-transfer-tests");
    await fs.mkdir(parent, { recursive: true });
    const dir = await fs.mkdtemp(path.join(parent, "run-"));
    const listener = net.createServer().listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    const base = "http://127.0.0.1:" + port;
    const env = {
      ...process.env,
      HARBOR_PORT: String(port),
      HARBOR_AUTO_CONNECT: "0",
      HARBOR_DATA_DIR: path.join(dir, "data"),
      HARBOR_DESKTOP_PROFILE: path.join(dir, "profile"),
      HARBOR_DESKTOP_HIDDEN: "1",
      HARBOR_NODE: process.execPath,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    let app, backend;
    try {
      backend = fork(path.resolve("dist/server.mjs"), [], {
        env,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let healthy = false;
      for (let i = 0; i < 80; i++) {
        healthy = await fetch(base + "/api/health")
          .then((r) => r.ok)
          .catch(() => false);
        if (healthy) break;
        await new Promise((r) => setTimeout(r, 125));
      }
      assert.equal(healthy, true);
      app = await electron.launch({ args: [process.cwd()], env });
      let main = await app.firstWindow();
      main.setDefaultTimeout(8000);
      await main.getByRole("button", {name:"터미널",exact:true}).click();
      await main.locator(".terminal-tabs").waitFor({state:"attached"});
      const boot = async () => (await fetch(base + "/api/bootstrap")).json();
      const initial = await boot();
      const create = async (title) => {
        const r = await fetch(base + "/api/terminals", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Harbor-Token": initial.token,
          },
          body: JSON.stringify({ hostId: "local", cwd: dir, title }),
        });
        assert.equal(r.ok, true);
        return (await r.json()).id;
      };
      const a = await create("Fixture A"),
        b = await create("Fixture B");
      const mobileListener = net.createServer().listen(0, "127.0.0.1");
      await once(mobileListener, "listening");
      const mobilePort = mobileListener.address().port;
      await new Promise((resolve) => mobileListener.close(resolve));
      const origin = "https://fixture.example.ts.net";
      const post = async (route, method, body) => {
        const response = await fetch(base + route, {
          method,
          headers: {
            "content-type": "application/json",
            "x-harbor-token": initial.token,
          },
          body: JSON.stringify(body),
        });
        assert.equal(response.ok, true);
        return response.json();
      };
      await post("/api/mobile", "PUT", {
        enabled: true,
        origin,
        port: mobilePort,
        mode: "private",
      });
      const invite = await post("/api/mobile/pair", "POST", { kind: "mobile" });
      const mobile = (route, body, cookie) =>
        new Promise((resolve, reject) => {
          const req = http.request(
            {
              hostname: "127.0.0.1",
              port: mobilePort,
              path: route,
              method: body ? "POST" : "GET",
              headers: {
                host: new URL(origin).host,
                origin,
                "x-harbor-mobile": "1",
                "content-type": "application/json",
                ...(cookie ? { cookie } : {}),
              },
            },
            (res) => {
              let data = "";
              res.setEncoding("utf8");
              res.on("data", (s) => (data += s));
              res.on("end", () =>
                resolve({
                  status: res.statusCode,
                  body: JSON.parse(data),
                  cookie: res.headers["set-cookie"]?.[0]?.split(";")[0],
                }),
              );
            },
          );
          req.on("error", reject);
          req.end(body ? JSON.stringify(body) : undefined);
        });
      const pair = await mobile("/mobile-api/pair", {
        code: new URLSearchParams(new URL(invite.url).hash.slice(1)).get(
          "pair",
        ),
        name: "Fixture",
      });
      assert.equal(pair.status, 200);
      const mobileState = (await mobile("/mobile-api/state", null, pair.cookie))
        .body;
      const clientId = require("node:crypto").randomUUID();
      const claim = await mobile(
        "/mobile-api/terminals/" + b + "/control",
        {
          action: "claim",
          takeover: true,
          clientId,
          runtimeId: mobileState.runtimeId,
        },
        pair.cookie,
      );
      assert.equal(claim.status, 200);
      const tab = (p, id) =>
        p.locator('.terminal-tabs [data-terminal-tab="' + id + '"]');
      await tab(main, b).waitFor();
      await tab(main, a).getByRole("button").click();
      const next = app.waitForEvent("window");
      const openButton = main.getByRole("button", {
        name: "터미널 새 창: Fixture A",
        exact: true,
      });
      await openButton.hover();
      let secondary = await next;
      await secondary.waitForLoadState("load");
      assert.equal(await secondary.locator("#root").innerHTML(), "");
      assert.equal(
        await secondary.evaluate(
          () =>
            performance
              .getEntriesByType("resource")
              .filter((e) => new URL(e.name).pathname.startsWith("/api/"))
              .length,
        ),
        0,
      );
      assert.equal(await tab(main, a).count(), 1);
      await main
        .getByRole("button", { name: "터미널 새 창: Fixture A", exact: true })
        .click();
      secondary.setDefaultTimeout(8000);
      await tab(secondary, a).waitFor();
      await tab(main, a).waitFor({ state: "detached" });
      assert.equal(await tab(secondary, b).count(), 0);
      // Arm the native drag broker in this isolated main process. Send a trusted
      // Chromium drop into the actual target tab strip without moving the OS mouse.
      const arm = async (source, id) => {
        const sourceUrl = source.url();
        return app.evaluate(
          async ({ BrowserWindow, ipcMain, screen }, { sourceUrl, id }) => {
            const win = BrowserWindow.getAllWindows().find(
              (w) => w.webContents.getURL() === sourceUrl,
            );
            const point = screen.getCursorScreenPoint;
            const bounds = win.getBounds();
            screen.getCursorScreenPoint = () => ({
              x: bounds.x + 40,
              y: bounds.y + 40,
            });
            try {
              return await ipcMain._invokeHandlers.get("harbor:tab-drag-start")(
                {
                  sender: win.webContents,
                  senderFrame: win.webContents.mainFrame,
                },
                id,
              );
            } finally {
              screen.getCursorScreenPoint = point;
            }
          },
          { sourceUrl, id },
        );
      };
      const drop = async (to, id, box) => {
        const cdp = await to.context().newCDPSession(to);
        try {
          for (const type of ["dragEnter", "dragOver", "drop"])
            await cdp.send("Input.dispatchDragEvent", {
              type,
              x: box.x + 4,
              y: box.y + 4,
              data: {
                items: [
                  { mimeType: "application/x-harbor-terminal-tab", data: id },
                ],
                dragOperationsMask: 16,
              },
            });
        } finally {
          await cdp.detach();
        }
      };
      assert.ok(await arm(main, b));
      await drop(secondary, b, await tab(secondary, a).boundingBox());
      await tab(secondary, b).waitFor();
      await tab(main, b).waitFor({ state: "detached" });
      assert.deepEqual(
        await secondary
          .locator(".terminal-tabs [data-terminal-tab]")
          .evaluateAll((els) => els.map((e) => e.dataset.terminalTab)),
        [b, a],
      );
      await secondary.reload();
      await tab(secondary, b).waitFor();
      const another = app.waitForEvent("window");
      await secondary
        .getByRole("button", { name: "새 워크스페이스 창", exact: true })
        .click();
      let third = await another;
      await third.locator(".terminal-welcome").waitFor();
      assert.equal(
        await third.locator(".terminal-tabs [data-terminal-tab]").count(),
        0,
      );
      assert.ok(await arm(secondary, b));
      await drop(
        third,
        b,
        await third.locator(".terminal-welcome").boundingBox(),
      );
      await tab(third, b).waitFor();
      await tab(secondary, b).waitFor({ state: "detached" });
      const shared = await mobile("/mobile-api/state", null, pair.cookie);
      assert.equal(shared.status, 200);
      assert.equal(shared.body.controls[b].clientId, clientId);
      for (const id of [a, b])
        assert.equal(
          shared.body.terminals.filter((t) => t.id === id).length,
          1,
        );
      await third
        .getByRole("button", { name: "새 터미널", exact: true })
        .first()
        .click();
      await third
        .getByRole("button", { name: "터미널 열기", exact: true })
        .click();
      await third.waitForFunction(
        () =>
          document.querySelectorAll(".terminal-tabs [data-terminal-tab]")
            .length === 2,
        undefined,
        { timeout: 8000 },
      );
      const urls = [main.url(), secondary.url(), third.url()];
      await third
        .getByRole("button", { name: "터미널 2분할 보기", exact: true })
        .click();
      await third.locator('.terminal-grid[data-layout="2"]').waitFor();
      await app.close();
      app = await electron.launch({ args: [process.cwd()], env });
      for (
        let i = 0;
        i < 80 &&
        urls.some((url) => !app.windows().some((p) => p.url() === url));
        i++
      )
        await new Promise((r) => setTimeout(r, 125));
      [main, secondary, third] = urls.map((url) =>
        app.windows().find((p) => p.url() === url),
      );
      assert.ok(main && secondary && third, "all three workspaces restored");
      await tab(third, b).waitFor();
      await third.locator('.terminal-grid[data-layout="2"]').waitFor();
      await tab(secondary, a).waitFor();
      assert.equal(await tab(main, b).count(), 0);
      await third.close();
      await tab(main, b).waitFor();
      await secondary.close();
      await tab(main, a).waitFor();
      // Drive Chromium's trusted dragstart and dragend on a hidden test tab.
      // Stand in for the OS pointer at release so the user's mouse stays put.
      const destinationDisplay = await app.evaluate(
        ({ BrowserWindow, screen }, url) => {
          const win = BrowserWindow.getAllWindows().find(
            (w) => w.webContents.getURL() === url,
          );
          const bounds = win.getBounds(),
            other = screen
              .getAllDisplays()
              .find((d) => d.id !== screen.getDisplayMatching(bounds).id);
          const point = other
            ? {
                x: other.workArea.x + Math.floor(other.workArea.width / 2),
                y: other.workArea.y + Math.floor(other.workArea.height / 2),
              }
            : { x: bounds.x + bounds.width + 64, y: bounds.y + 48 };
          const original = screen.getCursorScreenPoint;
          globalThis.restoreFixtureCursor = () => {
            screen.getCursorScreenPoint = original;
          };
          globalThis.releaseFixtureCursor = () => {
            screen.getCursorScreenPoint = () => point;
          };
          screen.getCursorScreenPoint = () => ({
            x: bounds.x + 80,
            y: bounds.y + 70,
          });
          return screen.getDisplayNearestPoint(point).id;
        },
        main.url(),
      );
      let floating;
      try {
        const box = await tab(main, a).boundingBox();
        const newWindow = app.waitForEvent("window", { timeout: 5000 });
        newWindow.catch(() => {});
        await main.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await main.mouse.down();
        await main.mouse.move(
          box.x + box.width / 2 + 12,
          box.y + box.height / 2,
          { steps: 4 },
        );
        await main.mouse.move(3, 3, { steps: 6 });
        await app.evaluate(() => globalThis.releaseFixtureCursor());
        await main.mouse.up();
        floating = await newWindow;
      } finally {
        await app.evaluate(() => {
          globalThis.restoreFixtureCursor();
          delete globalThis.restoreFixtureCursor;
          delete globalThis.releaseFixtureCursor;
        });
      }
      await tab(floating, a).waitFor();
      assert.equal(
        await app.evaluate(({ BrowserWindow, screen }, url) => {
          const win = BrowserWindow.getAllWindows().find(
            (w) => w.webContents.getURL() === url,
          );
          return screen.getDisplayMatching(win.getBounds()).id;
        }, floating.url()),
        destinationDisplay,
      );
      await tab(main, a).waitFor({ state: "detached" });
      assert.equal(
        await main.evaluate((id) => window.harborDesktop.receiveTab(id), a),
        false,
        "a transfer requires an actual drop",
      );
      await floating.close();
      await tab(main, a).waitFor();
      await main.mouse.move(2, 2);
      const speculative = app.waitForEvent("window", { timeout: 6000 });
      await main
        .getByRole("button", { name: "새 워크스페이스 창", exact: true })
        .hover();
      const unused = await speculative;
      await unused.waitForLoadState("load");
      assert.equal(await unused.locator("#root").innerHTML(), "");
      await unused.waitForEvent("close", { timeout: 8500 });
      assert.equal(await tab(main, a).count(), 1);
      const final = await boot();
      for (const id of [a, b])
        assert.equal(
          final.state.terminals.filter((t) => t.id === id && !t.exited).length,
          1,
        );
    } finally {
      if (app) await app.close();
      if (backend && backend.exitCode === null && backend.connected) {
        const exit = once(backend, "exit");
        backend.send({ type: "harbor:shutdown" });
        await exit;
      }
      assert.equal(path.dirname(dir), parent);
      await fs.rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    }
  },
);
