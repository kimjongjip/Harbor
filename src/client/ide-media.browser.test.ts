import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { deflateSync, crc32 } from "node:zlib";
import { randomFillSync } from "node:crypto";
import express from "express";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import { _electron } from "playwright";
import { Files } from "../server/files.js";
import { EditorFiles, createEditorRouter } from "../server/editor-files.js";
import { sendMediaFile } from "../server/file-media.js";
import type { HostConfig, TerminalInfo } from "../shared/types.js";
import { pdfResources } from "../../vite.config.js";

function largePng() {
  const width = 3200,
    height = 2400,
    stride = width * 3 + 1;
  const pixels = randomFillSync(Buffer.alloc(stride * height));
  for (let y = 0; y < height; y++) pixels[y * stride] = 0;
  const chunk = (name: string, content: Buffer) => {
    const type = Buffer.from(name),
      size = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    size.writeUInt32BE(content.length);
    crc.writeUInt32BE(crc32(Buffer.concat([type, content])));
    return Buffer.concat([size, type, content, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function largePdf() {
  const text = "BT /F1 24 Tf 50 740 Td (LARGE PDF PREVIEW VERIFIED) Tj ET\n";
  const second = "BT /F1 24 Tf 50 740 Td (SECOND PAGE VERIFIED) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}endstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>",
    `<< /Length ${Buffer.byteLength(second)} >>\nstream\n${second}endstream`,
  ];
  let value = "%PDF-1.7\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(value));
    value += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  value += `%${"x".repeat(3 * 1024 * 1024)}\n`;
  const xref = Buffer.byteLength(value);
  return Buffer.from(
    value +
      `xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
      offsets
        .slice(1)
        .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
        .join("") +
      `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}

test(
  "IDE opens PDF and images in central tabs, preserves drafts and creates no popup",
  { skip: process.platform !== "win32", timeout: 180000 },
  async () => {
    const parent = resolve(".cache/ide-media-browser-tests");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, "run-")),
      docs = join(directory, "documents");
    await mkdir(docs);
    await writeFile(join(docs, "large.png"), largePng());
    await writeFile(join(docs, "large.pdf"), largePdf());
    await writeFile(
      join(docs, "large.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#4563d4"/><!--' +
        "x".repeat(21 * 1024 * 1024) +
        "--></svg>",
    );
    await writeFile(join(docs, "large.jpg"), Buffer.alloc(0));
    await writeFile(join(docs, "draft.md"), "# Keep this draft\n");
    const host = {
      id: "fixture",
      kind: "local",
      name: "Media fixture",
      defaultCwd: docs,
    } as HostConfig;
    const terminal = {
      id: "fixture-terminal",
      hostId: host.id,
      cwd: docs,
      exited: false,
      connectionState: "connected",
      agentSessionId: "fixture-native",
    } as TerminalInfo;
    const files = new Files(() => undefined),
      originalResolve = files.resolvePath.bind(files);
    files.resolvePath = async (h, p, c) =>
      p === "~" && c === "~" ? docs : originalResolve(h, p, c);
    const editor = new EditorFiles({
      files,
      terminal: () => terminal,
      host: () => host,
    });
    await writeFile(
      join(directory, "fixture.tsx"),
      `
import React from 'react';import{createRoot}from'react-dom/client';import IdeWorkspace from'/src/client/ide/IdeWorkspace';import IdeMediaPreview from'/src/client/ide/IdeMediaPreview';import{createIdeApi}from'/src/client/ide/types';import{monaco}from'/src/client/ide/monaco';import{PreviewProvider,usePreview}from'/src/client/ResourcePreview';import{ThemeProvider}from'/src/client/Theme';import{TypographyProvider}from'/src/client/Typography';import{setToken}from'/src/client/api';import'/src/client/styles.css';import'/src/client/themes.css';import'/src/client/rich-content.css';
setToken('fixture-token');window.monaco=monaco;
const api=createIdeApi((p,init)=>fetch(p,{...init,headers:{...init.headers,'X-Harbor-Token':'fixture-token'}}));
function Workspace(){const preview=usePreview();return <IdeWorkspace api={api} terminalId="fixture-terminal" hostId="fixture" hostLabel="Media fixture" renderMedia={(file,kind,view)=><IdeMediaPreview file={file} kind={kind} view={view}/>} onPreview={f=>preview(f.path,{hostId:f.hostId,cwd:f.root})}/>}
const target=new URLSearchParams(location.hash.slice(1)).get('target');createRoot(document.getElementById('root')).render(<ThemeProvider><TypographyProvider><PreviewProvider hosts={[${JSON.stringify(host)}]} onFolder={()=>{}} standalone={!!target} initialTarget={target?JSON.parse(target):undefined}>{!target&&<Workspace/>}</PreviewProvider></TypographyProvider></ThemeProvider>);`,
    );
    await writeFile(
      join(directory, "index.html"),
      '<html><body style="margin:0"><div id="root" style="height:100vh"></div><script type="module" src="./fixture.tsx"></script></body></html>',
    );
    await build({
      configFile: false,
      root: directory,
      cacheDir: join(directory, "vite"),
      plugins: [react(), pdfResources()],
      logLevel: "error",
      resolve: { alias: { "/src": resolve("src") } },
      build: { outDir: join(directory, "compiled"), minify: false },
    });
    const app = express(),
      requests: { name: string; status: number; range?: string }[] = [];
    app.use(
      "/api/editor",
      createEditorRouter(editor, {
        authorize: (req) => {
          assert.equal(req.headers["x-harbor-token"], "fixture-token");
        },
      }),
    );
    app.get("/api/hosts/fixture/files/preview", async (req, res) => {
      assert.equal(req.headers["x-harbor-token"], "fixture-token");
      res.json(
        await files.preview(
          host,
          String(req.query.path),
          String(req.query.cwd),
        ),
      );
    });
    for (const type of ["image", "pdf"] as const)
      app.get(`/api/hosts/fixture/files/${type}`, async (req, res) => {
        if (req.query.token !== "fixture-token") {
          res.status(403).end();
          return;
        }
        const file = await files[type](host, String(req.query.path));
        res.once("finish", () =>
          requests.push({
            name: file.name,
            status: res.statusCode,
            range: req.headers.range,
          }),
        );
        await sendMediaFile(req, res, file);
      });
    app.use("/fonts", express.static(resolve("public/fonts")));
    app.use(express.static(join(directory, "compiled")));
    const server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await writeFile(
      join(directory, "main.cjs"),
      `const{app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.whenReady().then(()=>{
session.defaultSession.webRequest.onHeadersReceived({urls:['${origin}/*']},(details,callback)=>{const headers={...details.responseHeaders};if(details.resourceType==='mainFrame')headers['Content-Security-Policy']=["default-src 'self';script-src 'self' 'wasm-unsafe-eval';style-src 'self' 'unsafe-inline';font-src 'self' data:;img-src 'self' data: blob:;connect-src 'self';object-src 'none';frame-src "+(new URL(details.url).searchParams.get('preview')==='1'?"'self'":"'none'")+";base-uri 'none'"];callback({responseHeaders:headers});});
const w=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,plugins:false}});w.webContents.setWindowOpenHandler(()=>({action:'allow',overrideBrowserWindowOptions:{show:false,width:1100,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,plugins:true}}}));w.loadURL('${origin}/');});app.on('window-all-closed',()=>app.quit());`,
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k, v]) => k !== "ELECTRON_RUN_AS_NODE" && v !== undefined,
      ),
    ) as Record<string, string>;
    let desktop: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      desktop = await _electron.launch({
        args: [join(directory, "main.cjs")],
        env,
      });
      // Encode an actual JPEG, then add legal comment segments to exercise the old 20MiB boundary.
      const jpeg = Buffer.from(
        await desktop.evaluate(
          ({ nativeImage }, filename) =>
            nativeImage.createFromPath(filename).toJPEG(85).toString("base64"),
          join(docs, "large.png"),
        ),
        "base64",
      );
      const comment = Buffer.alloc(65537, 65);
      comment[0] = 255;
      comment[1] = 254;
      comment.writeUInt16BE(65535, 2);
      const count = Math.ceil(
        (22 * 1024 * 1024 - jpeg.length) / comment.length,
      );
      await writeFile(
        join(docs, "large.jpg"),
        Buffer.concat([
          jpeg.subarray(0, 2),
          ...Array.from({ length: count }, () => comment),
          jpeg.subarray(2),
        ]),
      );
      const page = await desktop.firstWindow();
      page.setDefaultTimeout(25000);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.getByRole("button", { name: "draft.md", exact: true }).click();
      await page.getByRole("button", { name: "원문", exact: true }).click();
      await page.locator(".monaco-editor textarea").first().focus();
      await page.keyboard.press("Control+End");
      await page.keyboard.insertText("UNSAVED MEDIA DRAFT");
      let popups = 0;
      page.on("popup", () => popups++);
      for (const name of ["large.png", "large.jpg", "large.svg", "large.pdf"]) {
        await page.getByRole("button", { name, exact: true }).click();
        await page.locator(".ide-main .ide-media-host").waitFor();
        assert.equal(await page.locator(".ide-error").count(), 0);
        assert.equal(
          await page
            .getByRole("tab", { name, exact: true })
            .getAttribute("aria-selected"),
          "true",
        );
        assert.equal(
          await page
            .getByRole("button", { name: "파일 저장", exact: true })
            .isDisabled(),
          true,
        );
        if (name.endsWith(".pdf")) {
          await page.waitForFunction(() =>
            document
              .querySelector(".ide-pdf-scroll .textLayer")
              ?.textContent?.includes("LARGE PDF PREVIEW VERIFIED"),
          );
          await page
            .locator('.ide-pdf-scroll .page[data-page-number="1"] canvas')
            .waitFor();
          await page
            .getByRole("button", { name: "PDF 다음 페이지", exact: true })
            .click();
          await page.waitForFunction(
            () =>
              document.querySelector<HTMLInputElement>(
                '[aria-label="PDF 페이지"]',
              )?.value === "2",
          );
          await page.waitForFunction(() =>
            [...document.querySelectorAll(".ide-pdf-scroll .textLayer")].some(
              (el) => el.textContent?.includes("SECOND PAGE VERIFIED"),
            ),
          );
          await page
            .getByRole("button", { name: "PDF 확대", exact: true })
            .click();
          await page
            .getByRole("textbox", { name: "PDF 내용 찾기", exact: true })
            .fill("SECOND");
          await page
            .getByRole("button", { name: "PDF 찾기", exact: true })
            .click();
          await page.locator(".ide-pdf-scroll .highlight").first().waitFor();
          await page.screenshot({ path: join(parent, "central-pdf.png") });
        } else {
          await page.waitForFunction(() => {
            const img = document.querySelector<HTMLImageElement>(
              ".ide-image-scroll img",
            );
            return img?.complete && img.naturalWidth > 0;
          });
          const dimensions = await page
            .locator(".ide-image-scroll img")
            .evaluate((el) => ({
              width: (el as HTMLImageElement).naturalWidth,
              height: (el as HTMLImageElement).naturalHeight,
            }));
          assert.deepEqual(
            dimensions,
            name.endsWith(".svg")
              ? { width: 640, height: 480 }
              : { width: 3200, height: 2400 },
          );
          if (name.endsWith(".png")) {
            await page
              .getByRole("button", { name: "이미지 확대", exact: true })
              .click();
            assert.ok(
              (await page.locator(".ide-media-controls").innerText()).includes(
                "125%",
              ),
            );
            await page.screenshot({ path: join(parent, "central-image.png") });
          }
        }
        assert.equal(popups, 0);
        assert.equal(desktop.windows().length, 1);
        assert.equal(
          await page.evaluate(
            () => (window as any).monaco.editor.getModels().length,
          ),
          1,
          "Media tabs must not allocate text models",
        );
        assert.ok(
          await page.evaluate(() =>
            (window as any).monaco.editor
              .getModels()[0]
              .getValue()
              .includes("UNSAVED MEDIA DRAFT"),
          ),
        );
      }
      assert.equal(await page.getByRole("tab").count(), 5);
      await page
        .getByRole("button", { name: "large.pdf", exact: true })
        .click();
      assert.equal(
        await page.getByRole("tab").count(),
        5,
        "Reopening media must reuse its tab",
      );
      await page.getByRole("tab", { name: "large.png", exact: true }).click();
      assert.ok(
        (await page.locator(".ide-media-controls").innerText()).includes(
          "125%",
        ),
        "Image zoom survives tab switching",
      );
      await page.getByRole("tab", { name: "large.pdf", exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLInputElement>('[aria-label="PDF 페이지"]')
            ?.value === "2",
      );
      await page
        .getByRole("button", { name: "편집기 나누기", exact: true })
        .click();
      await page.getByRole("tab", { name: /^draft.md/ }).click();
      await page
        .locator(".ide-pane-shell")
        .first()
        .locator(".monaco-editor textarea")
        .waitFor();
      await page
        .locator(".ide-pane-shell")
        .nth(1)
        .locator(".ide-pdf-scroll canvas")
        .first()
        .waitFor();
      await page.screenshot({ path: join(parent, "central-split.png") });
      await page
        .getByRole("button", { name: "large.pdf 닫기", exact: true })
        .click();
      assert.equal(
        await page.getByRole("tab", { name: "large.pdf", exact: true }).count(),
        0,
      );
      assert.equal(await page.getByRole("tab").count(), 4);
      assert.equal(popups, 0);
      for (const name of ["large.png", "large.jpg", "large.svg", "large.pdf"])
        assert.ok(
          requests.some(
            (r) => r.name === name && [200, 206].includes(r.status),
          ),
          name,
        );
      assert.deepEqual(errors, []);
      await writeFile(
        join(parent, "result.json"),
        JSON.stringify(
          {
            requests,
            files: await Promise.all(
              ["large.png", "large.jpg", "large.svg", "large.pdf"].map(
                async (name) => ({
                  name,
                  bytes: (await readFile(join(docs, name))).length,
                }),
              ),
            ),
            draftPreserved: true,
          },
          null,
          2,
        ),
      );
    } finally {
      // Only close the Electron instance created by this fixture.
      await desktop
        ?.evaluate(({ BrowserWindow }) => {
          for (const w of BrowserWindow.getAllWindows()) w.destroy();
        })
        .catch(() => {});
      await desktop?.close().catch(() => {});
      files.shutdown();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
);
