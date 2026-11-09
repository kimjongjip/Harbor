import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { build } from "esbuild";
import express from "express";
import { _electron } from "playwright";

test(
  "server approval UI saves only an explicit selection, cancels unchanged and surfaces failures",
  { skip: process.platform !== "win32", timeout: 60000 },
  async () => {
    const root = resolve(".cache/approval-browser-tests");
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "run-"));
    const host = {
      id: "fixture",
      name: "Fixture server",
      kind: "ssh",
      cliApprovalMode: "native",
    };
    let saves = 0,
      fail = false,
      connects = 0;
    await build({
      stdin: {
        contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {CliApprovalSettings} from './src/client/CliApprovalSettings';import {setToken} from './src/client/api';import './src/client/styles.css';import './src/client/themes.css';import './src/client/harbor.css';
setToken('fixture-only');const host=await (await fetch('/host')).json();createRoot(document.getElementById('root')).render(<aside style={{width:300}} onDoubleClick={()=>fetch('/connect',{method:'POST'})}><CliApprovalSettings host={host}/></aside>);`,
        resolveDir: process.cwd(),
        loader: "tsx",
        sourcefile: "approval-fixture.tsx",
      },
      bundle: true,
      format: "esm",
      outfile: join(dir, "fixture.js"),
      logLevel: "silent",
      external: ["/fonts/*"],
    });
    const app = express();
    app.use(express.json());
    app.get("/host", (_req, res) => res.json(host));
    app.post("/connect", (_req, res) => {
      connects++;
      res.json({});
    });
    app.patch("/api/hosts/fixture/cli-approval", (req, res) => {
      assert.equal(req.headers["x-harbor-token"], "fixture-only");
      if (fail) {
        res.status(503).json({ error: "설정을 저장하지 못했습니다." });
        return;
      }
      assert.ok(["native", "full-access"].includes(req.body.mode));
      host.cliApprovalMode = req.body.mode;
      saves++;
      res.json({ cliApprovalMode: host.cliApprovalMode });
    });
    app.use(express.static(dir));
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
      join(dir, "main.cjs"),
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(dir, "profile"))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1000,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadURL(${JSON.stringify(origin)});});app.on('window-all-closed',()=>app.quit());`,
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
      ),
    ) as Record<string, string>;
    let desktop: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      desktop = await _electron.launch({
        args: [join(dir, "main.cjs"), "--force-device-scale-factor=1"],
        env,
      });
      const page = await desktop.firstWindow();
      const open = () =>
        page
          .getByRole("button", { name: "Fixture server AI 실행 승인 설정" })
          .click();
      await open();
      await page
        .getByRole("heading", { name: "서버 CLI 시작 권한", exact: true })
        .dblclick();
      assert.equal(
        await page.getByLabel("AI 실행 승인 방식").inputValue(),
        "native",
      );
      await page.getByLabel("AI 실행 승인 방식").selectOption("full-access");
      await page.getByRole("button", { name: "취소", exact: true }).click();
      assert.equal(saves, 0);
      await open();
      assert.equal(
        await page.getByLabel("AI 실행 승인 방식").inputValue(),
        "native",
      );
      await page.getByLabel("AI 실행 승인 방식").selectOption("full-access");
      await page.screenshot({ path: join(dir, "verified.png") });
      await page
        .getByRole("button", { name: "설정 저장", exact: true })
        .click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      assert.equal(saves, 1);
      assert.equal(host.cliApprovalMode, "full-access");
      assert.equal(connects, 0);
      await page.reload();
      await open();
      assert.equal(
        await page.getByLabel("AI 실행 승인 방식").inputValue(),
        "full-access",
      );
      fail = true;
      await page.getByLabel("AI 실행 승인 방식").selectOption("native");
      await page
        .getByRole("button", { name: "설정 저장", exact: true })
        .click();
      await page
        .getByRole("alert")
        .getByText("설정을 저장하지 못했습니다.")
        .waitFor();
      assert.equal(host.cliApprovalMode, "full-access");
      fail = false;
      await page
        .getByRole("button", { name: "설정 저장", exact: true })
        .click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      assert.equal(host.cliApprovalMode, "native");
      assert.equal(connects, 0);
    } finally {
      await desktop?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
