import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { _electron } from "playwright";
import { desktopWorkbenchFixture } from "../test/desktop-workbench-fixture";
import { origin } from "../test/mobile-fixture";

test(
  "paired PC uses the host workbench, selection, appearance, Crew and same terminal across IDE with central media",
  { skip: process.platform !== "win32", timeout: 120000 },
  async () => {
    const f = await desktopWorkbenchFixture();
    // A loopback-only TLS-termination stand-in. Production still requires exact Tailscale origin.
    const proxy = createServer((req, res) => {
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
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    });
    const sockets = new WebSocketServer({ noServer: true });
    let opened = 0;
    proxy.on("upgrade", (req, socket, head) =>
      sockets.handleUpgrade(req, socket, head, (client) => {
        opened++;
        const remote = new WebSocket(f.url.replace("http:", "ws:") + req.url, {
          headers: {
            host: new URL(origin).host,
            origin,
            cookie: req.headers.cookie || "",
          },
        });
        const pending: string[] = [];
        client.on("message", (data) => {
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
        remote.on("error", () => client.close());
        client.on("close", () => remote.close());
      }),
    );
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/desktop/`;
    const invite = f.access.pairing("desktop"),
      code = new URLSearchParams(new URL(invite.url).hash.slice(1)).get("pair");
    f.gateway.controls.local(f.second.id);
    const main = join(f.directory, "electron.cjs");
    await writeFile(
      main,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(f.directory, "profile"))});app.commandLine.appendSwitch('disable-gpu');app.whenReady().then(()=>new BrowserWindow({show:false,width:1600,height:1000,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}}).loadURL(${JSON.stringify(url + "#pair=" + code)}));app.on('window-all-closed',()=>app.quit());`,
    );
    let browser: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    const evidence = resolve(".cache/desktop-workbench-evidence");
    await mkdir(evidence, { recursive: true });
    try {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (p): p is [string, string] => p[1] !== undefined,
        ),
      );
      delete env.ELECTRON_RUN_AS_NODE;
      browser = await _electron.launch({ args: [main], env });
      const page = await browser.firstWindow();
      const errors: string[] = [],
        policy: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => {
        if (
          /Content Security Policy|Refused to (load|create|connect|execute)/i.test(
            m.text(),
          )
        )
          policy.push(m.text());
      });
      await page.getByLabel("기기 이름", { exact: true }).fill("Other PC");
      await page
        .getByRole("button", { name: "등록하고 세션 보기", exact: true })
        .click();
      const pane = page.locator(`[data-terminal-id="${f.second.id}"]`).last();
      await pane.locator(".terminal-native-flow").getByText(/READY/).waitFor();
      assert.equal(await page.locator(".remote-app").count(), 0);
      assert.equal(
        await page.getByLabel("테마", { exact: true }).inputValue(),
        "midnight",
      );
      assert.equal(
        await page.getByLabel("휴대폰 · 다른 PC 연결", { exact: true }).count(),
        0,
      );
      await pane.locator(".terminal-usage").waitFor();
      assert.match(await pane.locator(".terminal-usage").innerText(), /51k/);
      const oldWidth = await pane
        .locator(".xterm-screen")
        .evaluate((e) => parseFloat((e as HTMLElement).style.width));
      f.resizeScreen(80, 30);
      await page.waitForFunction(
        ({ id, width }) => {
          const screen = document.querySelector<HTMLElement>(
            `[data-terminal-id="${id}"] .xterm-screen`,
          );
          return (
            !!screen &&
            Math.abs(parseFloat(screen.style.width) - width * 0.8) < 2
          );
        },
        { id: f.second.id, width: oldWidth },
      );
      await page
        .getByRole("button", { name: "여기서 제어", exact: true })
        .click();
      await page
        .getByText("이 창에서 제어", { exact: true })
        .waitFor();
      await pane.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type("remote-input");
      await page.waitForFunction(() =>
        document.body.textContent?.includes("READY > remote-input"),
      );
      assert.equal(f.inputs.join(""), "remote-input");
      await page.evaluate((id) => {
        (window as any).keptInput = document.querySelector(
          `[data-terminal-id="${id}"] .xterm-helper-textarea`,
        );
      }, f.second.id);
      await page.screenshot({ path: join(evidence, "terminal.png") });
      const connections = opened;
      await page.getByRole("button", { name: "IDE", exact: true }).click();
      await page.locator(".desktop-ide-workspace").waitFor();
      await page.getByRole("button", { name: "note.md", exact: true }).click();
      await page.getByRole("tab", { name: "note.md", exact: true }).waitFor();
      await page
        .getByRole("button", { name: "sample.png", exact: true })
        .click();
      await page.waitForFunction(() => {
        const img = document.querySelector<HTMLImageElement>(
          ".ide-image-scroll img",
        );
        return !!img?.complete && img.naturalWidth > 0;
      });
      await page
        .getByRole("button", { name: "sample.pdf", exact: true })
        .click();
      await page
        .locator('.ide-pdf-scroll .page[data-page-number="1"] canvas')
        .waitFor();
      await page.screenshot({ path: join(evidence, "ide-pdf.png") });
      assert.equal(
        await page.evaluate(
          (id) =>
            (window as any).keptInput ===
            document.querySelector(
              `[data-terminal-id="${id}"] .xterm-helper-textarea`,
            ),
          f.second.id,
        ),
        true,
      );
      assert.equal(
        opened,
        connections,
        "IDE keeps the same terminal WebSocket",
      );
      assert.equal(browser.windows().length, 1, "media stays in central tabs");
      await page.getByRole("button", { name: "터미널", exact: true }).click();
      await pane.locator(".terminal-usage").waitFor();
      await page.reload();
      await pane.locator(".terminal-native-flow").getByText(/READY/).waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "등록하고 세션 보기", exact: true })
          .count(),
        0,
        "existing pairing survives reload",
      );
      assert.deepEqual(errors, []);
      assert.deepEqual(policy, []);
      f.gateway.revoke(f.access.view().devices[0].id);
      await page
        .getByRole("heading", { name: "이 PC 연결", exact: true })
        .waitFor();
    } catch (error) {
      await writeFile(join(evidence, "inputs.json"), JSON.stringify(f.inputs));
      const page = browser && (await browser.firstWindow());
      await page
        ?.screenshot({ path: join(evidence, "failure.png") })
        .catch(() => {});
      throw error;
    } finally {
      await browser?.close();
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      await new Promise<void>((r) => {
        proxy.close(() => r());
        proxy.closeAllConnections();
      });
      await f.close();
    }
  },
);
