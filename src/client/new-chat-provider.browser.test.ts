import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { build } from "esbuild";
import { _electron } from "playwright";

test(
  "switching the AI on an explicit new draft keeps that draft and creates a distinct conversation on send",
  {
    skip: process.platform !== "win32",
    timeout: 120000,
  },
  async (t) => {
    const root = resolve(".cache/new-chat-provider");
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "run-"));
    t.after(() => {
      if (!/^run-\w+$/.test(relative(root, dir)))
        throw Error("Unexpected fixture path");
      return rm(dir, { recursive: true, force: true, maxRetries: 3 });
    });
    await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: "tsx",
        contents: `
        import React from "react";
        import {createRoot} from "react-dom/client";
        import Panel from "./src/client/ide/IdeChatPanel";
        const app = createRoot(document.getElementById("root"));
        const reply = value => new Response(JSON.stringify(value));
        let snapshots;
        async function request(path, init = {}) {
          const body = init.body && JSON.parse(init.body);
          if (body) window.writes.push({path,body});
          if (path.includes("/folders")) return reply({path:"/fixture",parent:"/",folders:[]});
          if (path.includes("/models?")) return reply({models:[],supportsAutoAccept:true});
          if (path === "/conversations") {
            const id = "test-" + (snapshots.size + 1);
            const chat = {id,runtimeId:"runtime",nativeId:"native-"+id,hostId:"local",provider:body.provider,
              cwd:body.cwd||"/fixture",model:"fixture",title:body.provider+"-"+id,status:"idle",items:[],
              approvals:[],revision:1,updatedAt:1};
            snapshots.set(id,chat);
            return reply(chat);
          }
          const [, , id, action] = path.split("/");
          const chat = snapshots.get(id);
          if (chat && action === "messages") {
            chat.items.push({id:id+"-user",kind:"user",turnId:id,text:body.text},
              {id:id+"-answer",kind:"assistant",turnId:id,phase:"final_answer",text:"Answer for "+body.text});
            chat.revision++;
            return reply({ok:true,requestId:body.requestId,status:"submitted"});
          }
          if (chat && !action) return reply(chat);
          return reply({});
        }
        window.fetch = () => Promise.resolve(reply({}));
        window.mount = mode => {
          snapshots = new Map();
          window.writes = [];
          app.render(<main key={mode} data-fixture={mode}>
            <Panel active hostId="local" hostName="Fixture" request={request}
              rememberScope={"test-"+mode} presentation={mode==="ide" ? undefined : "terminal"}
              mobileWorkspace={mode==="mobile"}/>
          </main>);
        };
      `,
      },
      jsx: "automatic",
      platform: "browser",
      target: "es2022",
      bundle: true,
      outfile: join(dir, "fixture.js"),
      loader: {
        ".css": "empty",
        ".woff2": "empty",
        ".woff": "empty",
        ".ttf": "empty",
        ".svg": "empty",
      },
      logLevel: "silent",
    });
    await writeFile(
      join(dir, "index.html"),
      '<meta charset="utf-8"><div id="root"></div><script src="./fixture.js"></script>',
    );
    const main = join(dir, "main.cjs");
    await writeFile(
      main,
      `const {app,BrowserWindow}=require("electron");
    app.setPath("userData",${JSON.stringify(join(dir, "profile"))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:760})
      .loadFile(${JSON.stringify(join(dir, "index.html"))}));`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({
      args: [main],
      env: env as Record<string, string>,
    });
    try {
      const page = await app.firstWindow();
      await page.waitForFunction(
        () => typeof (window as any).mount === "function",
      );
      const input = page.getByLabel("AI에게 보낼 메시지");
      const provider = page.getByLabel("AI 제공자");
      const send = page.getByRole("button", {
        name: "AI 메시지 전송",
        exact: true,
      });
      const writes = () =>
        page.evaluate(() => (window as any).writes) as Promise<
          { path: string; body: Record<string, unknown> }[]
        >;
      async function submit(text: string) {
        await input.fill(text);
        await send.click();
        await page.getByText("Answer for " + text, { exact: true }).waitFor();
      }
      for (const mode of ["terminal", "ide", "mobile"]) {
        await page.evaluate((mode) => (window as any).mount(mode), mode);
        await page.locator(`[data-fixture="${mode}"]`).waitFor();
        await submit("old Codex conversation");
        await provider.selectOption("claude");
        await submit("old Claude conversation");
        await page
          .getByRole("button", { name: "새 대화", exact: true })
          .click();
        await input.fill("new draft");
        const before = (await writes()).length;
        const tabs = page.getByRole("tab");
        const count = await tabs.count();
        const selected =
          mode === "terminal"
            ? await page.getByRole("tab", { selected: true }).elementHandle()
            : null;
        await provider.selectOption("codex");
        assert.equal(await input.inputValue(), "new draft");
        assert.equal(
          await page
            .getByText("Answer for old Codex conversation", { exact: true })
            .count(),
          0,
        );
        assert.equal(await tabs.count(), count);
        if (selected)
          assert.equal(await selected.getAttribute("aria-selected"), "true");
        assert.equal((await writes()).length, before);
        await send.click();
        await page.getByText("Answer for new draft", { exact: true }).waitFor();
        const requests = await writes();
        const creates = requests.filter((r) => r.path === "/conversations");
        assert.deepEqual(
          creates.map((r) => r.body.provider),
          ["codex", "claude", "codex"],
        );
        assert.equal(creates[2].body.cwd, "/fixture");
        assert.equal(creates[2].body.resumeId, undefined);
        assert.ok(
          requests.some(
            (r) =>
              r.path === "/conversations/test-3/messages" &&
              r.body.text === "new draft",
          ),
        );
        if (mode === "terminal") {
          for (const [title, text] of [
            ["codex-test-1", "old Codex conversation"],
            ["claude-test-2", "old Claude conversation"],
          ]) {
            await tabs.filter({ hasText: title }).click();
            await page
              .getByText("Answer for " + text, { exact: true })
              .waitFor();
          }
        }
      }
    } finally {
      await app.close();
    }
  },
);
