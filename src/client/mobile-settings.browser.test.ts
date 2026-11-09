import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { build } from "esbuild";
import { _electron } from "playwright";

test(
  "mobile setup UI switches VPN-free mode, handles permission, retains devices and gates old backends",
  { skip: process.platform !== "win32", timeout: 60000 },
  async () => {
    const root = resolve(".cache/mobile-settings-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    const compiled = await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client'; import Settings from './MobileSettings'; import {setToken} from './api'; import './styles.css'; import './themes.css'; setToken('fixture-token'); createRoot(document.getElementById('root')).render(<Settings onClose={()=>{}}/>);`,
        loader: "tsx",
        resolveDir: resolve("src/client"),
      },
      jsx: "automatic",
      bundle: true,
      write: false,
      outfile: join(directory, "app.js"),
    });
    const assets = new Map(
      compiled.outputFiles!.map((f) => [
        f.path.endsWith(".css") ? "/app.css" : "/app.js",
        f.text,
      ]),
    );
    let settings: any = {
      enabled: true,
      listening: true,
      origin: "https://pc.fixture.ts.net",
      port: 4318,
      mode: "private",
      devices: [
        {
          id: "fixture",
          name: "Existing iPhone",
          expiresAt: Date.now() + 100000,
          notifications: false,
        },
      ],
    };
    let permission = false,
      connectedMode = "private",
      networkCalls = 0,
      saves: any[] = [];
    const server = createServer(async (req, res) => {
      res.setHeader(
        "Content-Type",
        req.url?.endsWith(".css")
          ? "text/css"
          : req.url?.endsWith(".js")
            ? "text/javascript"
            : "application/json",
      );
      if (assets.has(req.url!)) {
        res.end(assets.get(req.url!));
        return;
      }
      if (!req.url?.startsWith("/api/")) {
        res.setHeader("Content-Type", "text/html");
        res.end(
          '<html data-theme="light"><head><link rel="stylesheet" href="/app.css"><style>:root{--font-ui:"Segoe UI","Malgun Gothic",sans-serif}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
        );
        return;
      }
      if (req.headers["x-harbor-token"] !== "fixture-token") {
        res.writeHead(403).end("{}");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : undefined;
      let result: any;
      if (req.url === "/api/mobile" && req.method === "GET") result = settings;
      else if (req.url === "/api/mobile" && req.method === "PUT") {
        saves.push(body);
        settings = { ...settings, ...body, listening: body.enabled };
        result = settings;
      } else if (req.url === "/api/mobile/network") {
        networkCalls++;
        if (req.method === "POST" && !permission)
          result = {
            origin: settings.origin,
            connected: false,
            conflict: false,
            approvalUrl: "https://login.tailscale.com/f/funnel?node=fixture",
            error: "연결 허용이 필요합니다.",
          };
        else {
          if (req.method === "POST") connectedMode = settings.mode;
          result = {
            origin: "https://pc.fixture.ts.net",
            connected: true,
            conflict: false,
            mode: connectedMode,
          };
        }
      } else if (req.url === "/api/mobile/pair")
        result = {
          url: settings.origin + "/mobile/#pair=fixture-only",
          expiresAt: Date.now() + 600000,
        };
      else {
        res.writeHead(404).end("{}");
        return;
      }
      res.end(JSON.stringify(result));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = `http://127.0.0.1:${(server.address() as any).port}`;
    const main = join(directory, "electron.cjs");
    await writeFile(
      main,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1000,height:1000,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadURL(${JSON.stringify(address)});});app.on('window-all-closed',()=>app.quit());`,
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined),
    ) as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      app = await _electron.launch({ args: [main], env });
      const page = await app.firstWindow(),
        errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const mode = page.getByLabel("모바일 연결 방식");
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLSelectElement>(
            '[aria-label="모바일 연결 방식"]',
          )?.value === "private",
      );
      assert.equal(
        networkCalls,
        0,
        "opening settings must not modify or query Tailscale automatically",
      );
      await mode.selectOption("funnel");
      assert.equal(
        await page
          .getByRole("button", {
            name: "일회용 기기 연결 링크 만들기",
            exact: true,
          })
          .isDisabled(),
        true,
      );
      const save = page.getByRole("button", {
        name: "저장하고 연결 설정",
        exact: true,
      });
      await save.click();
      await page
        .getByRole("link", { name: "Tailscale에서 연결 허용" })
        .waitFor();
      assert.equal(saves.at(-1).mode, "funnel");
      assert.equal(settings.devices.length, 1);
      assert.equal(await page.getByRole("status").count(), 0);
      permission = true;
      await save.click();
      await page
        .getByRole("status")
        .filter({ hasText: "VPN 없는 연결 경로 설정 완료" })
        .waitFor();
      await page
        .getByRole("button", {
          name: "일회용 기기 연결 링크 만들기",
          exact: true,
        })
        .click();
      await page
        .getByRole("button", { name: "링크 복사", exact: true })
        .waitFor();
      await mkdir(resolve(".cache/mobile-review"), { recursive: true });
      await page.screenshot({
        path: resolve(".cache/mobile-review/funnel-settings.png"),
      });
      await mode.selectOption("private");
      await save.click();
      await page
        .getByRole("status")
        .filter({ hasText: "개인망 연결 경로 설정 완료" })
        .waitFor();
      // An invalid unsaved draft cannot prevent disabling the current listener.
      await page.getByLabel("모바일 HTTPS 주소").fill("invalid");
      await page.getByRole("button", { name: "끄기", exact: true }).click();
      await page.waitForFunction(() =>
        document
          .querySelector(".mobile-settings")
          ?.textContent?.includes("상태: 꺼짐"),
      );
      assert.equal(saves.at(-1).origin, "https://pc.fixture.ts.net");
      settings = { ...settings, enabled: true, listening: true };
      delete settings.mode;
      const oldCalls = networkCalls;
      await page.reload();
      await page
        .getByRole("alert")
        .filter({ hasText: "현재 실행 중인 PC 백엔드" })
        .waitFor();
      assert.equal(await mode.isDisabled(), true);
      await page
        .getByRole("button", { name: "모바일 연결 켜기 · 저장", exact: true })
        .click();
      await page.waitForFunction(
        () =>
          !document
            .querySelector(".mobile-settings")
            ?.textContent?.includes("처리 중…"),
      );
      assert.equal(saves.at(-1).mode, undefined);
      assert.equal(networkCalls, oldCalls);
      assert.deepEqual(errors, []);
    } finally {
      await app?.close();
      await new Promise<void>((r) => server.close(() => r()));
      const rel = relative(root, directory);
      assert.ok(rel && !rel.startsWith(".."));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
