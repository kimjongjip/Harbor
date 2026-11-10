import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import { build } from "esbuild";
import { _electron } from "playwright";
import { INSTALLABLE_SKILLS } from "../shared/skill-catalog.js";

test(
  "skill library supports Korean discovery, both CLI targets, errors, old servers and responsive layout without changing terminal input",
  { skip: process.platform !== "win32", timeout: 60000 },
  async () => {
    const root = resolve(".cache/skill-browser-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    await build({
      stdin: {
        contents: `import React from'react';import{createRoot}from'react-dom/client';import{SkillLibraryButton}from'./src/client/SkillLibrary';import{setToken}from'./src/client/api';import{darkPalettes,paletteVariables}from'./src/client/theme-palettes';import'./src/client/styles.css';import'./src/client/themes.css';window.dark=()=>{for(const[k,v]of Object.entries(paletteVariables(darkPalettes.dark)))document.documentElement.style.setProperty(k,v);document.documentElement.dataset.appearance='dark'};setToken('fixture-token');createRoot(document.getElementById('root')).render(<main style={{padding:24}}><textarea aria-label="작성 중 입력" defaultValue="한글 English 작성 중"/><SkillLibraryButton host={{id:'fixture',name:'테스트 서버',kind:'ssh',username:'tester'}}/></main>);`,
        resolveDir: process.cwd(),
        sourcefile: "skill-fixture.tsx",
        loader: "tsx",
      },
      bundle: true,
      format: "esm",
      outfile: join(directory, "fixture.js"),
      logLevel: "silent",
    });
    let statusReads = 0,
      oldServer = false,
      fail = false;
    const installed = new Set<string>(),
      mutations: any[] = [];
    const app = express();
    app.use(express.json());
    app.get("/api/hosts/fixture/skills", (_req, res) => {
      statusReads++;
      if (oldServer) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json({
        roots: {
          claude: "/home/tester/.claude/skills",
          codex: "/home/tester/.agents/skills",
        },
        skills: Object.fromEntries(
          INSTALLABLE_SKILLS.map((s) => [
            s.id,
            {
              claude: installed.has(`${s.id}-claude`)
                ? "installed"
                : "available",
              codex: installed.has(`${s.id}-codex`) ? "installed" : "available",
            },
          ]),
        ),
      });
    });
    app.post("/api/hosts/fixture/skills/install", (req, res) => {
      assert.equal(req.headers["x-harbor-token"], "fixture-token");
      mutations.push(req.body);
      res.json({
        results: req.body.ids.flatMap((id: string) =>
          req.body.providers.map((provider: string) => {
            if (fail && provider === "codex")
              return {
                id,
                provider,
                state: "error",
                message: "테스트 연결 실패",
              };
            installed.add(`${id}-${provider}`);
            return { id, provider, state: "installed" };
          }),
        ),
      });
    });
    app.use("/api", (_req, res) =>
      res.status(500).json({ error: "Unexpected endpoint" }),
    );
    app.use(express.static(directory));
    app.get("/", (_req, res) =>
      res
        .type("html")
        .send(
          '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
        ),
    );
    const server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const main = join(directory, "electron.cjs");
    await writeFile(
      main,
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.commandLine.appendSwitch('disable-gpu');app.whenReady().then(()=>new BrowserWindow({show:false,width:1280,height:960,webPreferences:{contextIsolation:true,sandbox:true}}).loadURL('http://127.0.0.1:${(server.address() as any).port}/'));app.on('window-all-closed',()=>app.quit());`,
    );
    let desktop: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      desktop = await _electron.launch({
        args: [main],
        env: env as Record<string, string>,
      });
      const page = await desktop.firstWindow(),
        errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page
        .getByRole("button", { name: "테스트 서버 스킬 설치·사용법" })
        .waitFor();
      assert.equal(statusReads, 0, "closed library performs no status polling");
      await page.evaluate(() => {
        (window as any).inputNode = document.querySelector("textarea");
      });
      await page
        .getByRole("button", { name: "테스트 서버 스킬 설치·사용법" })
        .click();
      const dialog = page.getByRole("dialog", { name: "스킬 라이브러리" });
      await page
        .getByRole("checkbox", { name: "PDF 작업 선택", exact: true })
        .waitFor();
      await page.waitForFunction(
        () =>
          !(
            document.querySelector(
              '[aria-label="PDF 작업 선택"]',
            ) as HTMLInputElement
          )?.disabled,
      );
      assert.equal(await dialog.locator(".skill-card").count(), 50);
      assert.equal(
        await dialog
          .locator(".skill-card")
          .first()
          .getAttribute("data-skill-id"),
        "literature-review",
      );
      assert.match(
        await dialog.locator(".skill-popularity-note").innerText(),
        /개별 스킬의 사용 횟수·품질 평가가 아닙니다/,
      );
      assert.equal(
        await page
          .getByRole("combobox", { name: "설치할 AI", exact: true })
          .inputValue(),
        "both",
      );
      await page.screenshot({ path: join(directory, "skills-light.png") });
      await page
        .getByRole("combobox", { name: "스킬 출처", exact: true })
        .selectOption("orchestra");
      assert.equal(await dialog.locator(".skill-card").count(), 12);
      const flash = dialog.locator(
        '[data-skill-id="optimizing-attention-flash"]',
      );
      assert.match(
        (await flash.locator(".skill-card-details a").getAttribute("href")) ||
          "",
        /Orchestra-Research\/AI-Research-SKILLs\/tree\/[^/]+\/10-optimization\/flash-attention$/,
      );
      await page
        .getByRole("combobox", { name: "스킬 출처", exact: true })
        .selectOption("all");
      await page
        .getByRole("combobox", { name: "스킬 정렬", exact: true })
        .selectOption("stars");
      assert.equal(
        await dialog
          .locator(".skill-card")
          .first()
          .getAttribute("data-skill-id"),
        "systematic-debugging",
      );
      await page
        .getByRole("combobox", { name: "스킬 정렬", exact: true })
        .selectOption("research");
      await page.getByRole("textbox", { name: "스킬 검색" }).fill("graft");
      const graft = dialog.locator('[data-skill-id="graft"]');
      assert.equal(await dialog.locator(".skill-card").count(), 1);
      assert.equal(await graft.getByRole("checkbox").count(), 0);
      assert.match(
        await graft.innerText(),
        /npm install -g @trailhq\/trail-code[\s\S]*trail init/,
      );
      assert.doesNotMatch(await graft.innerText(), /설치 가능|\/graft|\$graft/);
      assert.equal(
        await page
          .getByRole("button", { name: "선택한 스킬 설치", exact: true })
          .isDisabled(),
        true,
      );
      assert.equal(mutations.length, 0);
      await page.screenshot({ path: join(directory, "graft-guide.png") });
      await page.getByRole("textbox", { name: "스킬 검색" }).fill("PDF");
      await page
        .getByRole("checkbox", { name: "PDF 작업 선택", exact: true })
        .check();
      const pdf = dialog.locator('[data-skill-id="pdf"]');
      await pdf.locator("summary").click();
      assert.match(await pdf.innerText(), /\/pdf .*PDF/);
      assert.match(await pdf.innerText(), /\$pdf .*PDF/);
      assert.match(await pdf.innerText(), /Poppler/);
      await page
        .getByRole("button", { name: "선택한 스킬 설치", exact: true })
        .click();
      await page.getByRole("status", { name: "스킬 설치 결과" }).waitFor();
      assert.deepEqual(mutations[0], {
        ids: ["pdf"],
        providers: ["claude", "codex"],
      });
      assert.match(await pdf.innerText(), /Harbor 설치됨/);
      await page.getByRole("textbox", { name: "스킬 검색" }).fill("워드");
      assert.equal(await dialog.locator(".skill-card").count(), 1);
      fail = true;
      await page
        .getByRole("checkbox", { name: "워드 문서 선택", exact: true })
        .check();
      await page
        .getByRole("button", { name: "선택한 스킬 설치", exact: true })
        .click();
      await page.getByText(/테스트 연결 실패/).waitFor();
      assert.match(
        await page.getByRole("status", { name: "스킬 설치 결과" }).innerText(),
        /설치 완료.*Claude[\s\S]*설치 실패.*Codex/,
      );
      fail = false;
      await page
        .getByRole("combobox", { name: "설치할 AI", exact: true })
        .selectOption("codex");
      await page
        .getByRole("button", { name: "선택한 스킬 설치", exact: true })
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector(".skill-results")
          ?.textContent?.includes("설치 완료 · docx · Codex"),
      );
      assert.deepEqual(mutations[2], { ids: ["docx"], providers: ["codex"] });
      await page.getByRole("textbox", { name: "스킬 검색" }).fill("");
      await dialog.locator(".skill-help > summary").click();
      assert.match(
        await dialog.locator(".skill-help").innerText(),
        /계정.*별개/,
      );
      await page.evaluate(() => (window as any).dark());
      await page.screenshot({ path: join(directory, "skills-dark-help.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: join(directory, "skills-mobile.png") });
      assert.equal(
        await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1),
        false,
      );
      await page.getByRole("button", { name: "닫기", exact: true }).click();
      assert.equal(
        await page.getByRole("textbox", { name: "작성 중 입력" }).inputValue(),
        "한글 English 작성 중",
      );
      assert.equal(
        await page.evaluate(
          () =>
            (window as any).inputNode === document.querySelector("textarea"),
        ),
        true,
      );
      oldServer = true;
      await page
        .getByRole("button", { name: "테스트 서버 스킬 설치·사용법" })
        .click();
      await page.getByRole("alert").waitFor();
      assert.match(await page.getByRole("alert").innerText(), /작업을 마친 뒤/);
      assert.equal(
        await page
          .getByRole("button", { name: "선택한 스킬 설치", exact: true })
          .isDisabled(),
        true,
      );
      assert.equal(await dialog.locator(".skill-card").count(), 50);
      assert.deepEqual(errors, []);
    } finally {
      await desktop?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    console.log(`Skill library screenshots: ${directory}`);
  },
);
