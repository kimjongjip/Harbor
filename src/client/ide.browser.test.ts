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
  "Markdown opens as a readable document, preserves edits and resolves relative resources",
  { skip: process.platform !== "win32", timeout: 150000 },
  async () => {
    const root = resolve(".cache/ide-markdown-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    const documentText =
      "# 편하게 읽는 문서\n\n[아래 절로 이동](#아래-절) · [다음 문서](./next.md)\n\n| 항목 | 값 |\n|---|---|\n| 읽기 | 지원 |\n\n수식 $x^2 + y^2$\n\n```mermaid\nflowchart LR\n  A[문서] --> B[편집]\n```\n\n![그림](./figure.png)\n\n## 아래 절\n\n" +
      "읽는 동안 글을 선택해서 복사할 수 있습니다.\n\n".repeat(20);
    await writeFile(
      join(directory, "fixture.tsx"),
      `
import React from 'react';import{createRoot}from'react-dom/client';
import IdeWorkspace from '/src/client/ide/IdeWorkspace';import{monaco}from'/src/client/ide/monaco';import'/src/client/styles.css';import'/src/client/themes.css';
window.monaco=monaco;window.reads=[];window.saved=[];
let files={'/home/fixture/docs/guide.md':${JSON.stringify(documentText)},'/home/fixture/docs/next.md':${JSON.stringify("# 다음 문서\n\n[돌아가기](./guide.md)")}};
const info=path=>({terminalId:'fixture-terminal',hostId:'fixture',root:'/home/fixture',cwd:'/home/fixture/elsewhere',path,content:files[path],version:'1',binding:'fixture-binding',encoding:'utf-8',bom:false});
const api={tree:async()=>({...info('/home/fixture'),entries:[{name:'guide.md',path:'/home/fixture/docs/guide.md',kind:'file',size:200,modifiedAt:0,mode:0}],parent:null,truncated:false}),read:async(id,path)=>{window.reads.push({id,path});return info(path.replace('/./','/'))},save:async(file,content)=>{files[file.path]=content;window.saved.push(content);return{...file,content,version:'2'}}};
createRoot(document.getElementById('root')).render(<div style={{height:'100vh'}}><IdeWorkspace api={api} terminalId="fixture-terminal" hostId="fixture" hostLabel="Markdown fixture"/></div>);`,
    );
    await writeFile(
      join(directory, "index.html"),
      '<html data-theme="light"><body style="margin:0"><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>',
    );
    await build({
      configFile: false,
      root: directory,
      cacheDir: join(directory, "vite"),
      plugins: [react()],
      logLevel: "error",
      resolve: { alias: { "/src": resolve("src") } },
      build: { outDir: join(directory, "compiled"), minify: false },
    });
    const fixtureApp = express();
    const resourceRequests: { cwd: unknown; path: unknown }[] = [];
    fixtureApp.get("/api/hosts/fixture/files/resolve", (_req, res) =>
      res.json({ path: "/home/fixture/docs" }),
    );
    fixtureApp.get("/api/hosts/fixture/files/preview", (req, res) => {
      resourceRequests.push({ cwd: req.query.cwd, path: req.query.path });
      res.json({ kind: "image", path: "/home/fixture/docs/figure.png" });
    });
    fixtureApp.get("/api/hosts/fixture/files/image", (_req, res) =>
      res
        .type("png")
        .send(
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2mIAAAAASUVORK5CYII=",
            "base64",
          ),
        ),
    );
    fixtureApp.use(express.static(join(directory, "compiled")));
    const server = createServer(fixtureApp);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const main = join(directory, "electron.cjs");
    await writeFile(
      main,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1350,height:900,webPreferences:{backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadURL('http://127.0.0.1:${(server.address() as any).port}/');});app.on('window-all-closed',()=>app.quit());`,
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => value !== undefined),
    ) as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      app = await _electron.launch({ args: [main], env });
      const page = await app.firstWindow();
      page.setDefaultTimeout(25000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.getByRole("button", { name: "guide.md", exact: true }).click();
      await page
        .getByRole("heading", { name: "편하게 읽는 문서", exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "읽기", exact: true })
          .getAttribute("aria-pressed"),
        "true",
      );
      assert.equal(await page.locator(".ide-source-host").isVisible(), false);
      await page.locator(".ide-reading .katex").first().waitFor();
      await page.locator(".ide-reading .mermaid-diagram svg").waitFor();
      await page
        .getByRole("columnheader", { name: "항목", exact: true })
        .waitFor();
      await page.locator('.ide-reading img[alt="그림"]').waitFor();
      assert.deepEqual(resourceRequests[0], {
        cwd: "/home/fixture/docs",
        path: "./figure.png",
      });
      await page.locator(".ide-reading-scroll").evaluate((element) =>
        element.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: -100,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      await page
        .getByRole("button", { name: "문서 글자 크기 초기화", exact: true })
        .filter({ hasText: "110%" })
        .waitFor();
      assert.equal(
        await page
          .locator(".ide-reading-content .markdown")
          .evaluate((el) => getComputedStyle(el).fontSize),
        "17.6px",
      );
      await page
        .getByRole("button", { name: "문서 목차", exact: true })
        .click();
      await page
        .getByRole("navigation", { name: "Markdown 목차" })
        .getByRole("button", { name: "아래 절", exact: true })
        .click();
      assert.ok(
        (await page
          .locator(".ide-reading-scroll")
          .evaluate((element) => element.scrollTop)) > 0,
      );
      await page.evaluate(() => {
        const text = document.querySelector(".ide-reading-content p")!;
        const range = document.createRange();
        range.selectNodeContents(text);
        const selected = window.getSelection()!;
        selected.removeAllRanges();
        selected.addRange(range);
      });
      assert.ok(
        (await page.evaluate(() => window.getSelection()?.toString()))?.length,
      );
      await page.getByRole("button", { name: "원문", exact: true }).click();
      const editor = page
        .locator(".ide-source-host .monaco-editor textarea")
        .first();
      await editor.focus();
      await page.keyboard.press("Control+End");
      await page.keyboard.insertText("\n추가한 초안입니다.");
      await page.getByLabel("저장 안 됨").waitFor();
      await page
        .getByRole("button", { name: "나란히 보기", exact: true })
        .click();
      await page
        .locator(".ide-reading")
        .getByText("추가한 초안입니다.", { exact: true })
        .waitFor();
      assert.equal(await page.locator(".ide-source-host").isVisible(), true);
      assert.equal(await page.locator(".ide-reading").isVisible(), true);
      await page.getByRole("button", { name: "읽기", exact: true }).click();
      await page
        .getByRole("button", { name: "파일 저장", exact: true })
        .click();
      await page.waitForFunction(() => (window as any).saved.length === 1);
      assert.match(
        await page.evaluate(() => (window as any).saved[0]),
        /추가한 초안/,
      );
      await page.getByRole("link", { name: "다음 문서", exact: true }).click();
      await page
        .getByRole("heading", { name: "다음 문서", exact: true })
        .waitFor();
      assert.equal(
        await page.evaluate(() => (window as any).reads.at(-1).path),
        "/home/fixture/docs/./next.md",
      );
      await page.getByRole("tab", { name: "guide.md", exact: true }).click();
      await page.getByText("추가한 초안입니다.", { exact: true }).waitFor();
      await mkdir(resolve("artifacts"), { recursive: true });
      await page.screenshot({
        path: resolve("artifacts/ide-markdown-reading-fixture.png"),
      });
      assert.deepEqual(errors, []);
    } finally {
      await app
        ?.evaluate(({ BrowserWindow }) => {
          for (const window of BrowserWindow.getAllWindows()) window.destroy();
        })
        .catch(() => {});
      await app?.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      const target = resolve(directory);
      assert.ok(
        relative(root, target) && !relative(root, target).startsWith(".."),
      );
      await rm(target, { recursive: true, force: true });
    }
  },
);

test(
  "IDE opens real Monaco, keeps drafts, compares concurrent writes and quotes the source terminal",
  { skip: process.platform !== "win32", timeout: 120000 },
  async () => {
    const root = resolve(".cache/ide-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    const fixture = join(directory, "fixture.tsx");
    await writeFile(
      fixture,
      `
import React,{useState}from'react';import{createRoot}from'react-dom/client';
import IdeWorkspace from '/src/client/ide/IdeWorkspace';import{IdeApiError}from'/src/client/ide/types';import{monaco}from'/src/client/ide/monaco';
import'/src/client/styles.css';import'/src/client/themes.css';
window.monaco=monaco;window.quotes=[];
let file={terminalId:'fixture-terminal',hostId:'fixture-host',root:'/fixture',path:'/fixture/code.ts',content:'const answer = 42;\\n',version:'1',binding:'fixture-binding'};
window.externalChange=()=>{file={...file,content:'const answer = 99;\\n',version:String(Number(file.version)+1)}};
const api={tree:async()=>({...file,entries:[{name:'code.ts',path:file.path,kind:'file',size:20,modifiedAt:0,mode:0}],parent:'/fixture',truncated:false}),read:async()=>({...file}),save:async(old,content)=>{if(old.version!==file.version)throw new IdeApiError('파일이 다른 곳에서 수정되었습니다.','EDITOR_CONFLICT',{...file});file={...file,content,version:String(Number(file.version)+1)};return{...file}}};
function Fixture(){const[visible,setVisible]=useState(true);return <><button id="toggle" onClick={()=>setVisible(!visible)}>보기 전환</button><div style={{height:650}}><IdeWorkspace api={api} terminalId="fixture-terminal" hostId="fixture-host" hostLabel="Fixture" visible={visible} onQuote={async selection=>{window.quotes.push(selection)}}/></div></>};
createRoot(document.getElementById('root')).render(<Fixture/>);`,
    );
    await writeFile(
      join(directory, "index.html"),
      '<html data-theme="light"><body style="margin:0"><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>',
    );
    await build({
      configFile: false,
      root: directory,
      cacheDir: join(directory, "vite"),
      plugins: [react()],
      logLevel: "error",
      resolve: { alias: { "/src": resolve("src") } },
      build: { outDir: join(directory, "compiled"), minify: false },
    });
    const fixtureApp = express();
    fixtureApp.use(express.static(join(directory, "compiled")));
    const server = createServer(fixtureApp);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = `http://127.0.0.1:${(server.address() as any).port}/`;
    const main = join(directory, "electron.cjs");
    await writeFile(
      main,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1280,height:850,webPreferences:{backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadURL(${JSON.stringify(address)});});app.on('window-all-closed',()=>app.quit());`,
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => value !== undefined),
    ) as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      app = await _electron.launch({ args: [main], env });
      const page = await app.firstWindow();
      page.setDefaultTimeout(20000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.getByRole("button", { name: "code.ts", exact: true }).click();
      await page
        .locator(".monaco-editor textarea")
        .first()
        .waitFor({ state: "attached" });
      await page.locator(".monaco-editor textarea").first().focus();
      await page.keyboard.press("Control+End");
      await page.keyboard.insertText("// my draft");
      await page.getByLabel("저장 안 됨").waitFor();
      await page.locator("#toggle").click();
      await page.locator("#toggle").click();
      assert.match(
        await page.evaluate(() =>
          (window as any).monaco.editor.getModels()[0].getValue(),
        ),
        /my draft/,
      );
      await page.evaluate(() => (window as any).externalChange());
      await page
        .getByRole("button", { name: "파일 저장", exact: true })
        .click();
      await page
        .locator(".ide-conflict")
        .waitFor()
        .catch(async (error) => {
          throw new Error(
            `${error.message}\nBrowser errors: ${JSON.stringify(errors)}\nUI: ${await page.locator("body").innerText()}`,
          );
        });
      await page.locator(".monaco-diff-editor").waitFor();
      await mkdir(resolve("artifacts"), { recursive: true });
      await page.screenshot({
        path: resolve("artifacts/ide-conflict-fixture.png"),
      });
      assert.match(
        await page.evaluate(() =>
          (window as any).monaco.editor
            .getModels()
            .find((m: any) => m.uri.scheme === "harbor-editor")
            .getValue(),
        ),
        /my draft/,
      );
      page.on("dialog", (dialog) => dialog.accept());
      await page
        .getByRole("button", { name: "내 편집 내용 저장", exact: true })
        .click();
      await page.locator(".ide-conflict").waitFor({ state: "detached" });
      await page
        .getByRole("button", { name: "편집기 나누기", exact: true })
        .click();
      assert.equal(await page.getByTestId("ide-editor-pane").count(), 2);
      await page.locator(".monaco-editor textarea").first().focus();
      await page.keyboard.press("Control+a");
      await page.getByRole("button", { name: "인용", exact: true }).click();
      await page.waitForFunction(() => (window as any).quotes.length === 1);
      const quote = await page.evaluate(() => (window as any).quotes[0]);
      assert.equal(quote.terminalId, "fixture-terminal");
      assert.equal(quote.path, "/fixture/code.ts");
      assert.match(quote.text, /my draft/);
      await page
        .getByRole("button", { name: "찾기 및 바꾸기", exact: true })
        .click();
      await page.locator(".find-widget.visible").waitFor();
      await page.waitForFunction(() => {
        const widget = document.querySelector(".find-widget.visible");
        return (
          widget &&
          getComputedStyle(widget).transform === "matrix(1, 0, 0, 1, 0, 0)"
        );
      });
      await page.screenshot({
        path: resolve("artifacts/ide-workspace-fixture.png"),
      });
      assert.deepEqual(errors, []);
    } finally {
      await app?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const resolved = resolve(directory);
      assert.ok(
        relative(root, resolved) && !relative(root, resolved).startsWith(".."),
      );
      await rm(resolved, { recursive: true, force: true });
    }
  },
);

test(
  "IDE reopens Korean text explicitly, retains encoding on refresh/save and previews binary files",
  { skip: process.platform !== "win32", timeout: 120000 },
  async () => {
    const root = resolve(".cache/ide-encoding-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    await writeFile(
      join(directory, "fixture.tsx"),
      `
import React from 'react';import{createRoot}from'react-dom/client';
import IdeWorkspace from '/src/client/ide/IdeWorkspace';import{IdeApiError}from'/src/client/ide/types';import{monaco}from'/src/client/ide/monaco';
import'/src/client/styles.css';import'/src/client/themes.css';
window.monaco=monaco;window.reads=[];window.saves=[];window.previews=[];
const base={terminalId:'encoding-terminal',hostId:'encoding-host',root:'/home/fixture',cwd:'/home/fixture/project',binding:'encoding-binding'};
const documents={
  '/home/fixture/korean.txt':{...base,path:'/home/fixture/korean.txt',content:'한글 문서\\r\\n',version:'1',encoding:'cp949',bom:false},
  '/home/fixture/unicode.txt':{...base,path:'/home/fixture/unicode.txt',content:'UTF-16 한글 😀\\r\\n',version:'1',encoding:'utf-16be',bom:true}
};
const names=['korean.txt','unicode.txt','image.png','archive.bin'];
const api={
  tree:async()=>({...base,path:base.root,parent:null,truncated:false,entries:names.map(name=>({name,path:base.root+'/'+name,kind:'file',size:64,modifiedAt:0,mode:0}))}),
  read:async(terminalId,path,encoding)=>{
    window.reads.push({terminalId,path,encoding});
    if(path.endsWith('korean.txt')&&encoding!=='cp949')throw new IdeApiError('UTF-8로 읽을 수 없는 파일입니다. 인코딩을 선택하세요.','EDITOR_ENCODING_REQUIRED',undefined,{...base,path,size:12,preview:'download',encodings:['cp949']});
    if(!documents[path])throw new IdeApiError('이미지·문서 또는 바이너리 파일입니다.','EDITOR_BINARY',undefined,{...base,path,size:64,preview:path.endsWith('.png')?'image':'download'});
    return{...documents[path]};
  },
  save:async(file,content)=>{window.saves.push({path:file.path,encoding:file.encoding,bom:file.bom,content});documents[file.path]={...file,content,version:String(Number(file.version)+1)};return{...documents[file.path]}}
};
createRoot(document.getElementById('root')).render(<div style={{height:700}}><IdeWorkspace api={api} terminalId={base.terminalId} hostId={base.hostId} hostLabel="Encoding fixture" workspaceCwd={base.cwd} onPreview={file=>window.previews.push(file)}/></div>);`,
    );
    await writeFile(
      join(directory, "index.html"),
      '<html data-theme="light"><body style="margin:0"><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>',
    );
    await build({
      configFile: false,
      root: directory,
      cacheDir: join(directory, "vite"),
      plugins: [react()],
      logLevel: "error",
      resolve: { alias: { "/src": resolve("src") } },
      build: { outDir: join(directory, "compiled"), minify: false },
    });
    const fixtureApp = express();
    fixtureApp.use(express.static(join(directory, "compiled")));
    const server = createServer(fixtureApp);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = `http://127.0.0.1:${(server.address() as any).port}/`;
    const main = join(directory, "electron.cjs");
    await writeFile(
      main,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1280,height:850,webPreferences:{backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadURL(${JSON.stringify(address)});});app.on('window-all-closed',()=>app.quit());`,
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => value !== undefined),
    ) as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      app = await _electron.launch({ args: [main], env });
      const page = await app.firstWindow();
      page.setDefaultTimeout(20000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page
        .getByRole("button", { name: "korean.txt", exact: true })
        .click();
      const reopen = page.getByRole("button", {
        name: "한글 Windows (CP949)로 열기",
        exact: true,
      });
      await reopen.waitFor();
      assert.equal(await page.getByRole("tab").count(), 0);
      assert.equal(await page.evaluate(() => (window as any).saves.length), 0);
      assert.equal(
        await page.locator(".ide-root").innerText(),
        "/home/fixture",
      );
      await reopen.click();
      await page.locator(".ide-status").filter({ hasText: "CP949" }).waitFor();
      await page
        .getByRole("tab", { name: "korean.txt", exact: true })
        .waitFor();
      assert.equal(await page.locator(".ide-error").count(), 0);
      assert.equal(
        await page.evaluate(() =>
          (window as any).monaco.editor.getModels()[0].getValue(),
        ),
        "한글 문서\r\n",
      );
      await page
        .getByRole("button", { name: "파일 새로고침", exact: true })
        .click();
      await page.waitForFunction(() => (window as any).reads.length === 3);
      assert.equal(
        await page.evaluate(() => (window as any).reads.at(-1).encoding),
        "cp949",
      );
      await page.locator(".monaco-editor textarea").first().focus();
      await page.keyboard.press("Control+End");
      await page.keyboard.insertText("수정");
      await page.getByLabel("저장 안 됨").waitFor();
      await page
        .getByRole("button", { name: "파일 저장", exact: true })
        .click();
      await page.waitForFunction(() => (window as any).saves.length === 1);
      const saved = await page.evaluate(() => (window as any).saves[0]);
      assert.equal(saved.encoding, "cp949");
      assert.equal(saved.bom, false);
      assert.equal(saved.content, "한글 문서\r\n수정");
      await page
        .getByRole("button", { name: "unicode.txt", exact: true })
        .click();
      await page
        .locator(".ide-status")
        .filter({ hasText: "UTF-16BE BOM" })
        .waitFor();
      assert.equal(await page.getByRole("tab").count(), 2);
      assert.equal(await page.locator(".ide-error").count(), 0);
      await page
        .getByRole("button", { name: "image.png", exact: true })
        .click();
      await page.waitForFunction(() => (window as any).previews.length === 1);
      const preview = await page.evaluate(() => (window as any).previews[0]);
      assert.equal(preview.path, "/home/fixture/image.png");
      assert.equal(preview.hostId, "encoding-host");
      assert.equal(preview.terminalId, "encoding-terminal");
      assert.equal(await page.getByRole("tab").count(), 2);
      await page
        .getByRole("button", { name: "미리보기 열기", exact: true })
        .click();
      await page.waitForFunction(() => (window as any).previews.length === 2);
      await page
        .getByRole("button", { name: "archive.bin", exact: true })
        .click();
      const download = page.getByRole("button", {
        name: "파일 보기 / 다운로드",
        exact: true,
      });
      await download.waitFor();
      assert.equal(
        await page.evaluate(() => (window as any).previews.length),
        2,
      );
      await download.click();
      await page.waitForFunction(() => (window as any).previews.length === 3);
      assert.equal(
        await page.evaluate(() => (window as any).previews.at(-1).path),
        "/home/fixture/archive.bin",
      );
      assert.equal(
        await page
          .getByRole("button", {
            name: "한글 Windows (CP949)로 열기",
            exact: true,
          })
          .count(),
        0,
      );
      assert.equal(await page.getByRole("tab").count(), 2);
      assert.deepEqual(errors, []);
    } finally {
      await app?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const resolved = resolve(directory);
      assert.ok(
        relative(root, resolved) && !relative(root, resolved).startsWith(".."),
      );
      await rm(resolved, { recursive: true, force: true });
    }
  },
);
