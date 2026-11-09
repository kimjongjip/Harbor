import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import { build } from "esbuild";
import { _electron } from "playwright";

test(
  "held text drag extends across questions and answers during wheel and edge scrolling",
  { skip: process.platform !== "win32", timeout: 60000 },
  async () => {
    const root = resolve(".cache/conversation-selection-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    await build({
      stdin: {
        contents: `import{conversationSelection}from'./src/client/conversation-selection';const body=document.querySelector('#conversation');body.innerHTML=Array.from({length:60},(_,index)=>'<article data-turn="'+Math.floor(index/2)+'"><p id="line-'+index+'">'+(index%2?'Assistant answer':'User question')+' '+index+' across this continuous transcript.</p></article>').join('');window.disposeSelection=conversationSelection(body);`,
        resolveDir: process.cwd(),
        sourcefile: "conversation-selection-fixture.ts",
        loader: "ts",
      },
      bundle: true,
      outfile: join(directory, "fixture.js"),
      format: "esm",
      logLevel: "silent",
    });
    const app = express();
    app.use(express.static(directory));
    app.get("/", (_req, res) =>
      res
        .type("html")
        .send(
          '<!doctype html><html><head><style>body{margin:20px;font:16px Arial}#conversation{height:350px;width:700px;overflow:auto;user-select:text;border:1px solid gray;scroll-behavior:auto}article{padding:0 15px}p{line-height:30px;margin:0}</style></head><body><div id="conversation"></div><script type="module" src="/fixture.js"></script></body></html>',
        ),
    );
    const server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const main = join(directory, "electron.cjs");
    await writeFile(
      main,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.commandLine.appendSwitch('disable-gpu');app.whenReady().then(()=>{new BrowserWindow({show:false,width:800,height:500,webPreferences:{backgroundThrottling:false,contextIsolation:true,sandbox:true}}).loadURL('http://127.0.0.1:${(server.address() as { port: number }).port}/');});app.on('window-all-closed',()=>app.quit());`,
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
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.locator("#line-0").waitFor();
      const start = (await page.locator("#line-0").boundingBox())!;
      await page.mouse.move(start.x + 2, start.y + 14);
      await page.mouse.down();
      await page.mouse.move(start.x + 220, start.y + 110, { steps: 10 });
      const before = await page.evaluate(() => {
        const selection = window.getSelection()!;
        (window as any).selectionAnchor = selection.anchorNode;
        return selection.toString();
      });
      assert.ok(before.includes("User question 0"));
      assert.ok(before.includes("Assistant answer 1"));
      await page.mouse.wheel(0, 360);
      await page.waitForFunction(
        () => document.querySelector("#conversation")!.scrollTop > 300,
      );
      const after = await page.evaluate(() => ({
        text: window.getSelection()!.toString(),
        sameAnchor:
          window.getSelection()!.anchorNode === (window as any).selectionAnchor,
      }));
      assert.equal(after.sameAnchor, true);
      assert.ok(after.text.length > before.length);
      assert.ok(after.text.includes("User question 12"));
      const box = (await page.locator("#conversation").boundingBox())!;
      const beforeEdge = await page
        .locator("#conversation")
        .evaluate((element) => element.scrollTop);
      await page.mouse.move(box.x + 260, box.y + box.height - 6, { steps: 5 });
      await page.waitForFunction(
        (top) => document.querySelector("#conversation")!.scrollTop > top + 50,
        beforeEdge,
      );
      assert.equal(
        await page.evaluate(
          () =>
            window.getSelection()!.anchorNode ===
            (window as any).selectionAnchor,
        ),
        true,
      );
      await page.mouse.up();
      await page.waitForTimeout(80);
      const releasedTop = await page
        .locator("#conversation")
        .evaluate((element) => element.scrollTop);
      await page.waitForTimeout(100);
      assert.equal(
        await page
          .locator("#conversation")
          .evaluate((element) => element.scrollTop),
        releasedTop,
      );
      // Reverse selections must extend upward using the original anchor too.
      await page.evaluate(() => {
        document.querySelector("#conversation")!.scrollTop = 900;
        window.getSelection()!.removeAllRanges();
      });
      await page.mouse.move(box.x + 330, box.y + 220);
      await page.mouse.down();
      await page.mouse.move(box.x + 50, box.y + 90, { steps: 6 });
      const reverseBefore = await page.evaluate(() => {
        const selection = window.getSelection()!;
        (window as any).selectionAnchor = selection.anchorNode;
        return selection.toString();
      });
      await page.mouse.wheel(0, -360);
      await page.waitForFunction(
        () => document.querySelector("#conversation")!.scrollTop < 600,
      );
      const reverseAfter = await page.evaluate(() => ({
        text: window.getSelection()!.toString(),
        sameAnchor:
          window.getSelection()!.anchorNode === (window as any).selectionAnchor,
      }));
      assert.equal(reverseAfter.sameAnchor, true);
      assert.ok(reverseAfter.text.length > reverseBefore.length);
      await page.mouse.up();
      await page.evaluate(() => (window as any).disposeSelection());
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
