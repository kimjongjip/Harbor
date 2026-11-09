import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import express from "express";
import { build } from "esbuild";
import { _electron } from "playwright";
import { AutoApproval } from "../server/auto-approval.js";
import { Requests } from "../server/requests.js";
import type { TerminalInfo } from "../shared/types.js";

test(
  "terminal switch accepts pending requests live, exposes counts and stops independently of its neighbor",
  { skip: process.platform !== "win32", timeout: 60000 },
  async () => {
    const root = resolve(".cache/auto-approval-browser");
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "run-"));
    const terminals: TerminalInfo[] = ["a", "b"].map((id) => ({
      id,
      hostId: "fixture",
      title: `Session ${id}`,
      cwd: "/fixture",
      exited: false,
      integration: "ready",
      agentSessionId: `native-${id}`,
    }));
    const resolver = {
      terminal: (id: string) => terminals.find((t) => t.id === id),
      host: (id: string) => ({ id, name: "Fixture" }),
    };
    const requests = new Requests(join(dir, "state"), resolver);
    const auto = new AutoApproval(requests, resolver.terminal, () => {});
    const permission = (id: string) =>
      requests.createPermission(id, {
        hook_event_name: "PermissionRequest",
        session_id: `native-${id}`,
        tool_name: "Bash",
        tool_input: { command: "echo fixture" },
      });
    const pending = permission("a"),
      neighbor = permission("b");
    await build({
      stdin: {
        contents: `import React,{useEffect,useState}from'react';import{createRoot}from'react-dom/client';import TerminalAutoApproval from'./src/client/TerminalAutoApproval';import{setToken}from'./src/client/api';import'./src/client/styles.css';import'./src/client/themes.css';setToken('fixture');function App(){const[items,setItems]=useState([]);useEffect(()=>{const read=()=>fetch('/state').then(r=>r.json()).then(setItems);read();const timer=setInterval(read,100);return()=>clearInterval(timer)},[]);return items.map(t=><div key={t.id} style={{display:'flex',gap:20,margin:20}}><b>{t.title}</b><TerminalAutoApproval terminal={t}/></div>)}createRoot(document.getElementById('root')).render(<App/>);`,
        resolveDir: process.cwd(),
        sourcefile: "auto-fixture.tsx",
        loader: "tsx",
      },
      bundle: true,
      format: "esm",
      outfile: join(dir, "fixture.js"),
      external: ["/fonts/*"],
      logLevel: "silent",
    });
    const app = express();
    app.use(express.json());
    app.get("/state", (_req, res) =>
      res.json(
        terminals.map((t) => ({ ...t, autoApproval: auto.state(t.id) })),
      ),
    );
    app.patch("/api/terminals/:id/auto-approval", (req, res) => {
      assert.equal(req.headers["x-harbor-token"], "fixture");
      res.json(auto.set(String(req.params.id), req.body.enabled));
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
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(dir, "profile"))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadURL(${JSON.stringify(origin)});});app.on('window-all-closed',()=>app.quit());`,
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
      await page
        .getByRole("button", { name: "자동 수락 설정: Session a", exact: true })
        .click();
      await page
        .getByRole("button", { name: "이 세션 자동 수락 켜기", exact: true })
        .click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page
        .locator(
          'button[aria-label="자동 수락 설정: Session a"][aria-pressed="true"]',
        )
        .waitFor();
      assert.equal(requests.result("a", pending.id).answer?.optionId, "allow");
      assert.equal(requests.result("b", neighbor.id).status, "pending");
      await page
        .getByRole("button", { name: "자동 수락 설정: Session a", exact: true })
        .click();
      await page.getByText("자동 수락 1건", { exact: false }).waitFor();
      await page.screenshot({ path: join(dir, "verified.png") });
      await page
        .getByRole("button", { name: "이 세션 자동 수락 끄기", exact: true })
        .click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      assert.equal(auto.state("a").enabled, false);
      const next = permission("a");
      assert.equal(requests.result("a", next.id).status, "pending");
      assert.equal(auto.state("b").enabled, false);
      await page.reload();
      await page
        .locator(
          'button[aria-label="자동 수락 설정: Session a"][aria-pressed="false"]',
        )
        .waitFor();
    } finally {
      await desktop?.close();
      auto.dispose();
      requests.shutdown();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);
