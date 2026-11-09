import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { build } from "vite";
import { createServer } from "node:http";
import express from "express";
import react from "@vitejs/plugin-react";
import { _electron } from "playwright";

test(
  "Tailscale setup offers explicit installation and official login, preserving existing connections",
  { skip: process.platform !== "win32", timeout: 90000 },
  async () => {
    const root = resolve(".cache/tailscale-ui-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    await writeFile(
      join(directory, "fixture.tsx"),
      `import React from 'react';import{createRoot}from'react-dom/client';import{TailscaleOnboarding}from'/src/client/TailscaleOnboarding';window.opened=[];window.addresses=[];window.open=(url)=>{window.opened.push(url);return null};createRoot(document.getElementById('root')).render(<TailscaleOnboarding onAddress={url=>window.addresses.push(url)}/>);`,
    );
    await writeFile(
      join(directory, "index.html"),
      '<html><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>',
    );
    await build({
      configFile: false,
      root: directory,
      cacheDir: join(directory, "vite"),
      plugins: [react()],
      logLevel: "error",
      resolve: { alias: { "/src": resolve("src") } },
      build: { outDir: join(directory, "compiled") },
    });
    let installed = false,
      connected = false;
    const actions: string[] = [];
    let authUrl = "";
    const serverApp = express();
    serverApp.use(express.json());
    serverApp.get("/api/mobile/setup", (_req, res) =>
      res.json({
        supported: true,
        canInstall: true,
        installed,
        connected,
        loggedIn: connected,
        state: connected
          ? "running"
          : installed
            ? "needs-login"
            : "not-installed",
        origin: connected ? "https://fixture.example.ts.net" : undefined,
        authUrl,
        downloadUrl: "https://tailscale.com/download/windows",
      }),
    );
    serverApp.post("/api/mobile/setup", (req, res) => {
      actions.push(req.body.action);
      if (req.body.action === "install") installed = true;
      if (req.body.action === "login")
        authUrl = "https://login.tailscale.com/a/fixture-login";
      res.json({ id: "fixture", status: "waiting" });
    });
    serverApp.use(express.static(join(directory, "compiled")));
    const server = createServer(serverApp);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const main = join(directory, "electron.cjs");
    await writeFile(
      main,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:900,height:800,webPreferences:{backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadURL(${JSON.stringify(url)});});app.on('window-all-closed',()=>app.quit());`,
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      app = await _electron.launch({ args: [main], env });
      const page = await app.firstWindow();
      page.setDefaultTimeout(12000);
      await page
        .getByRole("button", { name: "Tailscale 설치", exact: true })
        .waitFor();
      assert.deepEqual(actions, []);
      await page
        .getByRole("button", { name: "Tailscale 설치", exact: true })
        .click();
      await page
        .getByRole("button", { name: "로그인하기", exact: true })
        .waitFor();
      assert.deepEqual(actions, ["install"]);
      await page
        .getByRole("button", { name: "로그인하기", exact: true })
        .click();
      await page.getByRole("link", { name: "Tailscale 로그인 계속" }).waitFor();
      assert.deepEqual(actions, ["install", "login"]);
      assert.deepEqual(await page.evaluate(() => (window as any).opened), [
        "https://login.tailscale.com/a/fixture-login",
      ]);
      connected = true;
      await page
        .getByRole("button", { name: "설치·로그인 상태 다시 확인" })
        .click();
      await page.getByText("연결됨", { exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => (window as any).addresses), [
        "https://fixture.example.ts.net",
      ]);
      await page
        .getByRole("button", { name: "설치·로그인 상태 다시 확인" })
        .click();
      assert.deepEqual(actions, ["install", "login"]);
      await page.reload();
      await page.getByText("연결됨", { exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => (window as any).opened), []);
      assert.deepEqual(actions, ["install", "login"]);
    } finally {
      await app?.close();
      await new Promise<void>((r) => server.close(() => r()));
      const rel = relative(root, directory);
      if (!rel || rel.startsWith("..")) throw new Error("unsafe cleanup");
      await rm(directory, { recursive: true, force: true });
    }
  },
);
