import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import { build } from "esbuild";
import { _electron } from "playwright";

test(
  "report inbox persists read state, opens reports without terminal input, and preserves its last good feed",
  { skip: process.platform !== "win32", timeout: 60000 },
  async () => {
    const root = resolve(".cache/report-notices-test");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    await build({
      stdin: {
        contents: `import React,{useEffect}from'react';import{createRoot}from'react-dom/client';import{NotificationsProvider,useNotifications}from'./src/client/Notifications';import{ReportNotificationsSync}from'./src/client/ReportNotifications';import WorkspaceInbox from'./src/client/WorkspaceInbox';import{setToken}from'./src/client/api';import'./src/client/styles.css';import'./src/client/themes.css';import'./src/client/workspace-inbox.css';setToken('fixture-token');window.opened=[];
  function Probe(){const{sync}=useNotifications();useEffect(()=>{sync([{id:'n',terminalId:'existing',title:'Original terminal notice',body:'Existing work completed',at:1,read:false}]);},[]);return <><ReportNotificationsSync hostId="local"/><WorkspaceInbox state={{hosts:[],terminals:[],requests:[],mailbox:[]}} tab="notifications" onTab={()=>{}} terminalId="existing" onOpen={id=>window.opened.push(id)} onError={()=>{}} onClose={()=>{}}/></>};createRoot(document.getElementById('root')).render(<NotificationsProvider><div style={{width:440}}><Probe/></div></NotificationsProvider>);`,
        resolveDir: process.cwd(),
        sourcefile: "reports-fixture.tsx",
        loader: "tsx",
      },
      bundle: true,
      outfile: join(directory, "fixture.js"),
      format: "esm",
      define: { "process.env.NODE_ENV": '"production"' },
      external: ["/fonts/*"],
      loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
      logLevel: "silent",
    });
    const first = {
      version: 1,
      id: "research-2026-11-10",
      title: "오픈소스 조사 · 11월 10일",
      summary: "세션 검색과 로그인 프로필 개선",
      at: 1794268800000,
      markdown:
        "## 승인 대기 후보\n\n기존 대화는 유지하면서 **기록 검색**을 개선합니다.\n\n| 기능 | 상태 |\n| --- | --- |\n| 검색 색인 | 승인 대기 |\n\n[참고 자료](https://example.com/reference)",
    };
    let reports = [first],
      broken = false,
      truncated = false;
    const requests: { method: string; path: string }[] = [];
    const app = express();
    app.use((req, _res, next) => {
      if (req.path.startsWith("/api/"))
        requests.push({ method: req.method, path: req.url });
      next();
    });
    app.get("/api/hosts/local/files/preview", (req, res) => {
      assert.equal(req.headers["x-harbor-token"], "fixture-token");
      const file = String(req.query.path);
      if (file === "~/.harbor/reports/index.json")
        return res.json({
          kind: "text",
          text: broken
            ? "incomplete"
            : JSON.stringify({
                version: 1,
                reports: reports.map(
                  ({ markdown: _, version: __, ...summary }) => summary,
                ),
              }),
          truncated,
        });
      const report = reports.find(
        (item) => file === `~/.harbor/reports/${item.id}.json`,
      );
      if (!report)
        return res.status(404).json({ error: "Missing fixture report" });
      res.json({
        kind: "text",
        text: JSON.stringify(report),
        truncated: false,
      });
    });
    app.use("/fonts", express.static(resolve("public/fonts")));
    app.use(express.static(directory));
    app.get("/", (_req, res) =>
      res
        .type("html")
        .send(
          '<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
        ),
    );
    const server = createServer(app).listen(0, "127.0.0.1");
    await once(server, "listening");
    const main = join(directory, "main.cjs");
    await writeFile(
      main,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:850,webPreferences:{backgroundThrottling:false,contextIsolation:true,sandbox:true}}).loadURL('http://127.0.0.1:${(server.address() as any).port}/'));app.on('window-all-closed',()=>app.quit());`,
    );
    let desktop: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE",
        ),
      );
      desktop = await _electron.launch({ args: [main], env });
      const page = await desktop.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const card = page
        .locator(".inbox-notice")
        .filter({ hasText: first.title });
      await card.waitFor();
      assert.match((await card.getAttribute("class")) || "", /unread/);
      await card.click();
      await page.getByRole("dialog").getByText("승인 대기 후보").waitFor();
      assert.equal(
        await page.locator(".report-notice-content table").count(),
        1,
      );
      assert.deepEqual(await page.evaluate(() => (window as any).opened), []);
      assert.equal(
        requests.filter((request) => request.method !== "GET").length,
        0,
        "reading a report never writes to a terminal or session API",
      );
      await page.screenshot({ path: join(root, "report-open.png") });
      await page.getByLabel("창 닫기", { exact: true }).click();
      assert.doesNotMatch((await card.getAttribute("class")) || "", /unread/);
      await page.reload();
      await card.waitFor();
      assert.doesNotMatch((await card.getAttribute("class")) || "", /unread/);
      broken = true;
      await page.getByLabel("조사 알림 새로고침").click();
      await page.waitForTimeout(150);
      assert.equal(await card.count(), 1);
      broken = false;
      truncated = true;
      await page.getByLabel("조사 알림 새로고침").click();
      await page.waitForTimeout(150);
      assert.equal(await card.count(), 1);
      truncated = false;
      reports = [
        ...reports,
        {
          ...first,
          id: "research-2026-11-11",
          title: "오픈소스 조사 · 11월 11일",
          at: first.at + 86400000,
        },
      ];
      await page.getByLabel("조사 알림 새로고침").click();
      await page
        .getByText("오픈소스 조사 · 11월 11일", { exact: true })
        .waitFor();
      assert.equal(await page.locator(".inbox-notice").count(), 3);
      assert.doesNotMatch((await card.getAttribute("class")) || "", /unread/);
      await page
        .locator(".inbox-notice")
        .filter({ hasText: "Original terminal notice" })
        .click();
      assert.deepEqual(await page.evaluate(() => (window as any).opened), [
        "existing",
      ]);
      assert.deepEqual(errors, []);
    } finally {
      await desktop?.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      assert.ok(resolve(directory).startsWith(root + sep));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
