import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import { build } from "esbuild";
import { _electron } from "playwright";
import { Files } from "../server/files.js";
import { HtmlPreviews } from "../server/html-preview.js";
import type { HostConfig } from "../shared/types.js";

test(
  "32MB HTML renders completely with assets and bounded source in an isolated preview window",
  { skip: process.platform !== "win32", timeout: 90000 },
  async () => {
    const root = resolve(".cache/html-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    const docs = join(directory, "documents");
    await mkdir(join(docs, "assets"), { recursive: true });
    await writeFile(
      join(docs, "보고서.html"),
      `<!doctype html><meta charset="utf-8"><title>HTML 문서</title>
<link rel="stylesheet" href="assets/style.css"><h1>HTML 보고서</h1><img src="assets/figure.svg"><button id="run">계산</button><output id="value">0</output><p id="module"></p><p id="json"></p>
<script>try { parent.document.body.dataset.leaked='yes'; } catch { document.body.dataset.parentBlocked='yes'; }
fetch('/api/bootstrap').then(()=>document.body.dataset.apiBlocked='no').catch(()=>document.body.dataset.apiBlocked='yes');
document.querySelector('#run').onclick=()=>document.querySelector('#value').textContent='42';</script>
<script type="module" src="assets/module.js"></script><!--${"x".repeat(32 * 1024 * 1024)}--><p id="tail">문서 끝</p>`,
    );
    await writeFile(
      join(docs, "assets", "style.css"),
      "body{font-family:sans-serif;padding:24px}h1{color:rgb(12, 34, 56)}img{width:80px;height:50px}",
    );
    await writeFile(
      join(docs, "assets", "figure.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="50"><rect width="80" height="50" fill="blue"/></svg>',
    );
    await writeFile(
      join(docs, "assets", "module.js"),
      "import {label} from './part.js'; document.querySelector('#module').textContent=label; fetch(new URL('./data.json',import.meta.url)).then(r=>r.json()).then(d=>document.querySelector('#json').textContent=d.value);",
    );
    await writeFile(
      join(docs, "assets", "part.js"),
      "export const label='모듈 정상';",
    );
    await writeFile(
      join(docs, "assets", "data.json"),
      '{"value":"데이터 정상"}',
    );
    const host = {
      id: "fixture",
      name: "HTML fixture",
      kind: "local",
      defaultCwd: docs,
    } as HostConfig;
    const files = new Files(() => undefined);
    const previews = new HtmlPreviews(files, () => host);
    const code = `import React from 'react';import{createRoot}from'react-dom/client';
import{PreviewProvider,usePreview}from'./src/client/ResourcePreview';import{ThemeProvider}from'./src/client/Theme';import{TypographyProvider}from'./src/client/Typography';import{setToken}from'./src/client/api';
import'./src/client/styles.css';import'./src/client/themes.css';import'./src/client/rich-content.css';
setToken('fixture-only');function Open(){const open=usePreview();return <button id="open" onClick={()=>open('보고서.html',{hostId:'fixture',cwd:${JSON.stringify(docs)}})}>HTML 열기</button>}
const target=new URLSearchParams(location.hash.slice(1)).get('target');
createRoot(document.getElementById('root')).render(<ThemeProvider><TypographyProvider><PreviewProvider hosts={[${JSON.stringify(host)}]} onFolder={()=>{}} standalone={!!target} initialTarget={target?JSON.parse(target):undefined}>{!target&&<Open/>}</PreviewProvider></TypographyProvider></ThemeProvider>);`;
    await build({
      stdin: {
        contents: code,
        resolveDir: process.cwd(),
        sourcefile: "html-fixture.tsx",
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
    let apiAttempts = 0;
    app.use("/html-preview", previews.router);
    app.use(express.json());
    app.get("/api/hosts/fixture/files/preview", async (req, res) =>
      res.json(
        await files.preview(
          host,
          String(req.query.path),
          String(req.query.cwd),
        ),
      ),
    );
    app.post("/api/hosts/fixture/files/html", async (req, res) => {
      assert.equal(req.headers["x-harbor-token"], "fixture-only");
      res.json(await previews.open(host.id, req.body.path));
    });
    app.get("/api/bootstrap", (_req, res) => {
      apiAttempts++;
      res.json({ secret: "not-for-document" });
    });
    app.use("/fonts", express.static(resolve("public/fonts")));
    app.use(express.static(directory));
    app.get("/", (_req, res) =>
      res
        .type("html")
        .send(
          '<!doctype html><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
        ),
    );
    const server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    await writeFile(
      join(directory, "main.cjs"),
      `const{app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.whenReady().then(()=>{
session.defaultSession.webRequest.onHeadersReceived({urls:[${JSON.stringify(origin + "/*")}]},(d,cb)=>{const headers={...d.responseHeaders};if(d.resourceType==='mainFrame')headers['Content-Security-Policy']=["default-src 'self';script-src 'self' 'wasm-unsafe-eval';style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;font-src 'self' data: https://fonts.gstatic.com;img-src 'self' data: blob: https: http:;connect-src 'self';object-src 'none';frame-src 'self';base-uri 'none'"];cb({responseHeaders:headers});});
const w=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});w.webContents.setWindowOpenHandler(()=>({action:'allow',overrideBrowserWindowOptions:{show:false}}));w.loadURL(${JSON.stringify(origin)});});app.on('window-all-closed',()=>app.quit());`,
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
      ),
    ) as Record<string, string>;
    let desktop: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      desktop = await _electron.launch({
        // Keep CDP mouse coordinates consistent for cross-origin frames on high-DPI Windows.
        args: [join(directory, "main.cjs"), "--force-device-scale-factor=1"],
        env,
      });
      const main = await desktop.firstWindow();
      await main.locator("#open").waitFor();
      const opened = main.waitForEvent("popup");
      await main.locator("#open").click();
      const page = await opened;
      page.on("pageerror", (error) =>
        console.error("Preview page error:", error.message),
      );
      const frame = page.frameLocator(
        'iframe[title="HTML 미리보기 · 보고서.html"]',
      );
      await frame
        .locator("#module")
        .getByText("모듈 정상", { exact: true })
        .waitFor();
      await frame
        .locator("#json")
        .getByText("데이터 정상", { exact: true })
        .waitFor();
      assert.equal(
        await frame.locator("h1").evaluate((e) => getComputedStyle(e).color),
        "rgb(12, 34, 56)",
      );
      assert.equal(
        await frame
          .locator("img")
          .evaluate((e) => (e as HTMLImageElement).naturalWidth),
        80,
      );
      assert.equal(await frame.locator("#tail").textContent(), "문서 끝");
      assert.equal(
        await frame.locator("body").getAttribute("data-parent-blocked"),
        "yes",
      );
      assert.equal(
        await frame.locator("body").getAttribute("data-api-blocked"),
        "yes",
      );
      assert.equal(apiAttempts, 0);
      await frame.locator("#run").click();
      await frame
        .locator("#value")
        .getByText("42", { exact: true })
        .waitFor({ timeout: 5000 });
      const bounds = await page.locator("iframe").boundingBox();
      assert.ok(
        bounds && bounds.width > 800 && bounds.height > 400,
        "preview fills a separate window",
      );
      await page.screenshot({ path: join(directory, "verified.png") });
      await page
        .getByRole("button", { name: "원문 보기", exact: true })
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector(".html-source")
          ?.textContent?.includes("HTML 보고서"),
      );
      await page.locator(".preview-data-notice").getByText(/512KB/).waitFor();
      const sourceText = await page.locator(".html-source").textContent();
      assert.ok(sourceText && sourceText.length <= 512 * 1024);
      assert.ok(!sourceText.includes("문서 끝"));
      assert.equal(await page.locator("iframe").count(), 0);
      await page
        .getByRole("button", { name: "웹페이지 보기", exact: true })
        .click();
      await frame.locator("h1").waitFor();
      const oldUrl = await page.locator("iframe").getAttribute("src");
      await page.getByRole("button", { name: "새로고침", exact: true }).click();
      await page.waitForFunction((old) => {
        const src = document.querySelector("iframe")?.getAttribute("src");
        return src && src !== old;
      }, oldUrl);
      await frame
        .locator("#module")
        .getByText("모듈 정상", { exact: true })
        .waitFor();
      assert.equal(await main.locator("#open").count(), 1);
      assert.equal(
        await main.locator("body").getAttribute("data-leaked"),
        null,
      );
    } finally {
      await desktop?.close();
      files.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      assert.ok(directory.startsWith(root + sep));
      // Retain the synthetic screenshot for visual inspection.
      for (const name of [
        "profile",
        "fixture.js",
        "fixture.css",
        "main.cjs",
        "documents",
      ])
        await rm(join(directory, name), { recursive: true, force: true });
    }
  },
);
