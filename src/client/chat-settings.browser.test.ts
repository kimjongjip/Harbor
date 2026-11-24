import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { _electron } from "playwright";
import { build } from "esbuild";

test(
  "conversation settings retain only edited fields, separate auto-accept from provider permission, and fit desktop and narrow screens",
  { skip: process.platform !== "win32", timeout: 60000 },
  async () => {
    const root = resolve(".cache/chat-settings-review");
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "run-"));
    await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: "tsx",
        contents: `
  import React,{useState} from "react";import{createRoot}from"react-dom/client";
  import {ChatSettings} from "./src/client/ide/ChatSettings";import "./src/client/styles.css";import "./src/client/themes.css";import "./src/client/ide/chat.css";
  const models=[{id:"fixture-a",name:"GPT-6.2 Astra",efforts:["medium","high"],isDefault:true,defaultEffort:"medium"},{id:"fixture-b",name:"Long model display name for a narrow window · second configuration",efforts:["medium","high"]}];
  function Fixture(){
    const [catalog,setCatalog]=useState(models);window.catalog=setCatalog;
    const [open,setOpen]=useState(true),[enabled,setEnabled]=useState(false),[status,setStatus]=useState("idle"),[provider,setProvider]=useState("codex"),[unknown,setUnknown]=useState(false);
    const [initial,setInitial]=useState({model:"fixture-a",effort:"medium",permission:"default"});
    window.editFixture=(p,k,v)=>{setProvider(p);setInitial(k);setEnabled(v);setOpen(true);};window.update=next=>setInitial(next);window.setUnknown=setUnknown;window.setStatus=setStatus;
    return <><textarea aria-label="원래 초안" defaultValue="계속 작성하던 질문"/><button onClick={()=>setOpen(true)}>설정 열기</button>
      {open&&<ChatSettings key={provider} hostName="Compiler" provider={provider} initial={initial} models={catalog} notice="" unknown={unknown?{model:true,effort:true,permission:true}:{}}
      bound={false} active status={status} review={false} autoAccept={enabled} onAutoAccept={async value=>{window.toggleCalls=(window.toggleCalls||0)+1;setEnabled(value);}}
      onSave={async(value,engine,fields)=>{window.saved={value,engine,fields};}} onClose={()=>setOpen(false)} />}</>;
  }createRoot(document.getElementById("root")).render(<Fixture/>);
  `,
      },
      jsx: "automatic",
      bundle: true,
      outfile: join(dir, "fixture.js"),
      loader: { ".woff": "empty", ".woff2": "empty", ".ttf": "empty" },
      logLevel: "silent",
    });
    await writeFile(
      join(dir, "index.html"),
      '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="./fixture.css"><div id="root"></div><script src="./fixture.js"></script>',
    );
    const main = join(dir, "electron.cjs");
    await writeFile(
      main,
      `const{app,BrowserWindow}=require("electron");app.setPath("userData",${JSON.stringify(join(dir, "profile"))});app.whenReady().then(()=>new BrowserWindow({width:1024,height:760,show:false,webPreferences:{sandbox:true}}).loadFile(${JSON.stringify(join(dir, "index.html"))}));`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({
      args: [main],
      env: env as Record<string, string>,
    });
    try {
      const page = await app.firstWindow();
      const dialog = page.getByRole("dialog"),
        toggle = dialog.getByRole("switch", { name: "Harbor 자동 수락" });
      const model = dialog.getByLabel("AI 모델", { exact: true }),
        permission = dialog.getByLabel("AI 권한", { exact: true });
      await dialog.waitFor();
      assert.equal(await toggle.getAttribute("aria-checked"), "false");
      await toggle.click();
      assert.equal(await toggle.getAttribute("aria-checked"), "true");
      assert.equal(await permission.inputValue(), "default");
      await dialog
        .getByLabel("추론 강도", { exact: true })
        .selectOption("high");
      await page.evaluate(() =>
        (window as any).update({
          model: "fixture-b",
          effort: "medium",
          permission: "default",
        }),
      );
      assert.equal(await model.inputValue(), "fixture-b");
      assert.equal(
        await dialog.getByLabel("추론 강도", { exact: true }).inputValue(),
        "high",
      );
      await page.screenshot({ path: join(root, "desktop.png") });
      await dialog.getByRole("button", { name: "적용", exact: true }).click();
      assert.deepEqual(
        await page.evaluate(() => (window as any).saved.fields),
        ["effort"],
      );
      for (const p of ["claude", "antigravity"]) {
        await page.evaluate(
          (p) =>
            (window as any).editFixture(
              p,
              { model: "fixture-b", effort: "high", permission: "default" },
              false,
            ),
          p,
        );
        await page.evaluate(() => (window as any).setStatus("waiting"));
        assert.equal(await model.isDisabled(), true);
        assert.equal(await toggle.isEnabled(), true);
        await toggle.click();
        assert.equal(await toggle.getAttribute("aria-checked"), "true");
        await page.evaluate(() => (window as any).setStatus("idle"));
        assert.equal(await permission.inputValue(), "default");
        assert.equal(
          await permission.locator("option[value=auto-accept]").count(),
          0,
        );
      }
      await page.setViewportSize({ width: 360, height: 560 });
      await page.evaluate(() =>
        document.documentElement.style.setProperty("--ui-font-size", "18px"),
      );
      await page.screenshot({ path: join(root, "narrow.png") });
      const geometry = await dialog.evaluate((el) => {
        const form = el.querySelector("form")!,
          foot = form.querySelector("footer")!,
          field = form.querySelector("select")!,
          r = el.getBoundingClientRect(),
          f = foot.getBoundingClientRect();
        return {
          contained:
            r.left >= 0 &&
            r.right <= innerWidth &&
            r.top >= 0 &&
            r.bottom <= innerHeight,
          footer: f.bottom <= innerHeight,
          wide: el.scrollWidth > el.clientWidth + 1,
          control: field.getBoundingClientRect().height,
        };
      });
      assert.deepEqual(
        { ...geometry, control: geometry.control >= 38 },
        { contained: true, footer: true, wide: false, control: true },
      );
      await page.evaluate(() =>
        (window as any).editFixture(
          "codex",
          { model: "", permission: "default" },
          undefined,
        ),
      );
      await page.evaluate(() => (window as any).setUnknown(true));
      assert.equal(await dialog.getByRole("switch").count(), 0);
      assert.equal(await model.inputValue(), "__unreported");
      assert.equal(
        await page.getByLabel("원래 초안").inputValue(),
        "계속 작성하던 질문",
      );
      await page.evaluate(() => {
        const w = window as any;
        w.setUnknown(false);
        w.catalog([]);
        w.update({
          model: "resolved-build-id",
          permission: "default",
          effort: "high",
        });
      });
      assert.equal(await model.inputValue(), "resolved-build-id");
      await page.evaluate(() =>
        (window as any).catalog([
          {
            id: "latest",
            name: "Latest verified",
            resolvedModel: "resolved-build-id",
            isDefault: false,
            efforts: ["low", "high"],
          },
        ]),
      );
      assert.equal(await model.inputValue(), "latest");
      assert.equal(
        await model.locator("option:checked").innerText(),
        "Latest verified",
      );
      await dialog.getByLabel("추론 강도", { exact: true }).selectOption("low");
      await page.evaluate(() =>
        (window as any).update({
          model: "resolved-build-id",
          effort: "high",
          permission: "read-only",
        }),
      );
      assert.equal(
        await dialog.getByLabel("추론 강도", { exact: true }).inputValue(),
        "low",
      );
      assert.equal(await permission.inputValue(), "read-only");
      assert.equal(await toggle.isDisabled(), true);
    } finally {
      await app.close();
    }
  },
);
