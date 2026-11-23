import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import express from "express";
import { build } from "esbuild";
import { _electron } from "playwright";
import { LabQuestions, labQuestionRouter } from "../server/lab-questions";

test(
  "independent answers can be opened, debated and revisited in the research UI",
  { skip: process.platform !== "win32", timeout: 60000 },
  async (t) => {
    const root = resolve(".cache/lab-question-browser");
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "run-"));
    t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 4 }));
    const lab = new LabQuestions(
      dir,
      async (m, p) =>
        m.provider +
        " says " +
        (p.includes("다음 확인 사항")
          ? "conclusion"
          : p.includes("각 주장과 근거")
            ? "review"
            : "first answer"),
      (m) => m.hostId,
    );
    const web = express();
    web.use(express.json());
    web.use("/api/lab-questions", labQuestionRouter(lab));
    web.use(express.static(dir));
    await build({
      stdin: {
        contents: `import React from "react";import {createRoot} from "react-dom/client";import {LabQuestions} from "./src/client/LabQuestions";import {api} from "./src/client/api";createRoot(document.getElementById("root")).render(<LabQuestions hosts={[{id:"local",name:"Local"},{id:"remote",name:"Remote"}]} hostId="local" debate={false} request={api} RenderAnswer={({text})=><p>{text}</p>}/>);`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      jsx: "automatic",
      outfile: join(dir, "fixture.js"),
      logLevel: "silent",
    });
    await writeFile(
      join(dir, "index.html"),
      '<meta charset=utf-8><div id=root></div><script src="/fixture.js"></script>',
    );
    const server = web.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    t.after(() => {
      lab.close();
      server.close();
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = "http://127.0.0.1:" + address.port;
    const main = join(dir, "main.cjs");
    await writeFile(
      main,
      'const {app,BrowserWindow}=require("electron");app.setPath("userData",' +
        JSON.stringify(join(dir, "profile")) +
        ");app.whenReady().then(()=>new BrowserWindow({show:false}).loadURL(" +
        JSON.stringify(url) +
        "));",
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({
      args: [main],
      env: env as Record<string, string>,
    });
    try {
      const page = await app.firstWindow();
      await page
        .getByLabel("질문", { exact: true })
        .fill("Which result is correct?");
      await page.getByLabel("함께 읽을 자료").fill("fixture table");
      await page
        .getByRole("checkbox", { name: "Gemini · Antigravity" })
        .check();
      await page.getByLabel("Gemini · Antigravity 서버").selectOption("remote");
      await page.getByLabel("Gemini · Antigravity 모델").fill("gemini-fixture");
      await page
        .getByRole("button", { name: "각자에게 묻기", exact: true })
        .click();
      await page
        .getByText("antigravity says first answer", { exact: true })
        .waitFor();
      await page.getByRole("button", { name: "받은 답으로 토론하기" }).click();
      await page.getByText("codex says conclusion", { exact: true }).waitFor();
      await page.reload();
      await page.getByLabel("질문 기록").selectOption(lab.list()[0].id);
      await page.getByText("codex says conclusion", { exact: true }).waitFor();
      assert.equal(lab.list().length, 1);
    } finally {
      await app.close();
    }
  },
);
