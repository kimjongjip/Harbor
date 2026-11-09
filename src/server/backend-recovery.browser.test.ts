import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import { _electron } from "playwright";

test(
  "desktop restores its exited backend in the same window, limits crash loops, and quits without respawning",
  { skip: process.platform !== "win32", timeout: 90000 },
  async () => {
    const root = path.resolve(".cache/desktop-backend-tests");
    await mkdir(root, { recursive: true });
    const fixture = await mkdtemp(path.join(root, "run-"));
    const state = path.join(fixture, "state");
    await mkdir(path.join(fixture, "dist"));
    await mkdir(state);
    const version = JSON.parse(await readFile("package.json", "utf8")).version;
    await cp("desktop", path.join(fixture, "desktop"), { recursive: true });
    await writeFile(
      path.join(fixture, "package.json"),
      JSON.stringify({
        name: "harbor-backend-fixture",
        version,
        main: "fixture-main.cjs",
      }),
    );
    await writeFile(
      path.join(fixture, "fixture-main.cjs"),
      "const {BrowserWindow}=require('electron'); BrowserWindow.prototype.show=function(){}; require('./desktop/main.cjs');",
    );
    const code = `import{createServer}from'node:http';import{writeFileSync,appendFileSync}from'node:fs';import path from'node:path';
const directory=process.env.HARBOR_DATA_DIR,port=Number(process.env.HARBOR_PORT);
const client="window.states=[];const accept=s=>{window.states.push(s);document.querySelector('#status').textContent=s.phase;};window.harborDesktop.onBackendState(accept);window.harborDesktop.backendState().then(accept);document.querySelector('#retry').onclick=()=>window.harborDesktop.retryBackend();";
const server=createServer((req,res)=>{if(req.url==='/api/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,name:'codex-harbor',version:${JSON.stringify(version)}}));}else if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(client);}else{res.setHeader('Content-Type','text/html');res.end('<h1>Isolated backend recovery</h1><output id="status"></output><button id="retry">Retry</button><script src="/fixture.js"></script>');}});
server.listen(port,'127.0.0.1',()=>{writeFileSync(path.join(directory,'fixture-server.json'),JSON.stringify({pid:process.pid,parent:process.ppid}));appendFileSync(path.join(directory,'launches.txt'),process.pid+'\\n');});
process.on('message',message=>{if(message?.type==='harbor:shutdown')server.close(()=>process.exit(0));});`;
    await writeFile(path.join(fixture, "dist", "server.mjs"), code);
    const reservation = createServer();
    await new Promise<void>((resolve) =>
      reservation.listen(0, "127.0.0.1", resolve),
    );
    const port = (reservation.address() as any).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
      ),
    ) as Record<string, string>;
    Object.assign(env, {
      HARBOR_PORT: String(port),
      HARBOR_DATA_DIR: state,
      HARBOR_DESKTOP_PROFILE: path.join(fixture, "profile"),
      HARBOR_NODE: process.execPath,
      NODE_ENV: "production",
    });
    let desktop: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    let latest: { pid: number; parent: number } | undefined;
    const launched = async () =>
      (await readFile(path.join(state, "launches.txt"), "utf8"))
        .trim()
        .split("\n").length;
    const wait = async (condition: () => Promise<boolean>) => {
      for (let i = 0; i < 100; i++) {
        if (await condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(await condition(), "desktop reached expected recovery state");
    };
    try {
      desktop = await _electron.launch({
        args: [fixture, "--force-device-scale-factor=1"],
        env,
      });
      const page = await desktop.firstWindow();
      await page
        .locator("#status")
        .getByText("ready", { exact: true })
        .waitFor();
      const mainPid = await desktop.evaluate(() => process.pid);
      const crash = async () => {
        latest = JSON.parse(
          await readFile(path.join(state, "fixture-server.json"), "utf8"),
        );
        assert.equal(
          latest!.parent,
          mainPid,
          "kill only the isolated desktop's fixture child",
        );
        process.kill(latest!.pid);
      };
      for (let recovery = 1; recovery <= 3; recovery++) {
        await crash();
        await page.waitForFunction(
          () => document.querySelector("#status")?.textContent === "recovering",
        );
        await wait(async () => (await launched()) === recovery + 1);
        await page.waitForFunction(
          () => document.querySelector("#status")?.textContent === "ready",
        );
        assert.equal(
          desktop.windows().length,
          1,
          "restore backend, not the user's window",
        );
      }
      await crash();
      await page.waitForFunction(
        () => document.querySelector("#status")?.textContent === "failed",
      );
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.equal(
        await launched(),
        4,
        "automatic retries stop after three exits",
      );
      await page.locator("#retry").click();
      await wait(async () => (await launched()) === 5);
      await page.waitForFunction(
        () => document.querySelector("#status")?.textContent === "ready",
      );
      const events = (
        await readFile(path.join(state, "desktop-events.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(
        events.filter((e) => e.event === "backend-recovered").length,
        4,
      );
      assert.equal(
        events.filter((e) => e.event === "backend-exit" && !e.expected).length,
        4,
      );
      latest = JSON.parse(
        await readFile(path.join(state, "fixture-server.json"), "utf8"),
      );
      await desktop.close();
      desktop = undefined;
      await wait(async () => {
        try {
          process.kill(latest!.pid, 0);
          return false;
        } catch {
          return true;
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.equal(
        await launched(),
        5,
        "normal quit must not resurrect a backend",
      );
    } finally {
      await desktop?.close();
      assert.ok(fixture.startsWith(root + path.sep));
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
