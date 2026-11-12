import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron } from "playwright";
import { desktopWorkbenchFixture } from "../test/desktop-workbench-fixture";
import { desktopBrowserProxy } from "../test/desktop-browser-proxy";

for (const provider of ["codex", "claude"] as const)
  test(
    `${provider} PC spectator keeps typesetting, row metrics and explicit ownership through live resize and takeover`,
    { skip: process.platform !== "win32", timeout: 65000 },
    async () => {
      const f = await desktopWorkbenchFixture();
      const proxy = await desktopBrowserProxy(f.url);
      const prompt = provider === "codex" ? "›" : "❯";
      f.second.agentKind = provider;
      f.timeline.push(
        { id: "q", kind: "user", text: "Update sample", turnId: "turn" },
        {
          id: "cmd",
          kind: "command",
          text: "node sample.js",
          detail: "SAVED OUTPUT",
          turnId: "turn",
          status: "completed",
        },
        {
          id: "a",
          kind: "assistant",
          text: "## Rendered answer\n\n**Result**\n\n| Item | Value |\n| --- | --- |\n| Check | Passed |\n\n```js\nconst result = 42;\n```",
          turnId: "turn",
          phase: "final_answer",
          turnStatus: "completed",
        },
      );
      const draw = (cols: number) =>
        "\x1b[2J\x1b[H" +
        prompt +
        " Update sample\r\nRAW ANSWER\r\n\x1b[7;1H" +
        (provider === "claude" ? "─".repeat(cols) + "\r\n" : "") +
        prompt +
        " UNSENT DRAFT\r\n" +
        (provider === "claude" ? "─".repeat(cols) + "\r\n" : "") +
        "  ? for shortcuts";
      f.output(draw(100));
      f.gateway.controls.local(f.second.id);
      const invite = f.access.pairing("desktop");
      const main = join(f.directory, "spectator.cjs");
      await writeFile(
        main,
        `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(f.directory, "profile"))});app.commandLine.appendSwitch('disable-gpu');app.whenReady().then(()=>new BrowserWindow({show:false,width:1280,height:900,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}}).loadURL(${JSON.stringify(proxy.url + new URL(invite.url).hash)}));app.on('window-all-closed',()=>app.quit());`,
      );
      let browser: Awaited<ReturnType<typeof _electron.launch>> | undefined;
      let releaseRead: (() => void) | undefined;
      const evidence = resolve(".cache/desktop-spectator-evidence");
      await mkdir(evidence, { recursive: true });
      try {
        const env = Object.fromEntries(
          Object.entries(process.env).filter(
            (p): p is [string, string] => p[1] !== undefined,
          ),
        );
        delete env.ELECTRON_RUN_AS_NODE;
        browser = await _electron.launch({ args: [main], env });
        const page = await browser.firstWindow();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.getByLabel("기기 이름", { exact: true }).fill("Viewer PC");
        await page
          .getByRole("button", { name: "등록하고 세션 보기", exact: true })
          .click();
        const pane = page.locator(`[data-terminal-id="${f.second.id}"]`).last();
        const bar = pane.getByRole("status", {
          name: "터미널 제어 상태",
          exact: true,
        });
        await bar.getByText("보기 전용", { exact: true }).waitFor();
        const answer = pane.getByRole("heading", {
          name: "Rendered answer",
          exact: true,
        });
        await answer.waitFor();
        assert.equal(await pane.locator(".markdown table").count(), 1);
        assert.equal(await pane.locator(".markdown pre").count(), 1);
        const beforeInput = f.inputs.length;
        await pane.locator(".xterm-helper-textarea").focus();
        await page.keyboard.type("SHOULD_NOT_SEND");
        assert.equal(f.inputs.length, beforeInput);
        await page.evaluate(() => document.fonts.ready);
        f.output(draw(100));
        await page.waitForTimeout(100);
        const rowHeight = await pane
          .locator(".terminal-native-row")
          .last()
          .evaluate((e) => parseFloat((e as HTMLElement).style.lineHeight));
        const barHeight = (await bar.boundingBox())!.height;
        await page.evaluate((id) => {
          const root = document.querySelector(`[data-terminal-id="${id}"]`)!;
          (window as any).rowHeights = [];
          (window as any).savedAnswer = root.querySelector(".markdown h2");
          (window as any).rowObserver = new MutationObserver(() => {
            for (const row of root.querySelectorAll<HTMLElement>(
              ".terminal-native-row",
            ))
              (window as any).rowHeights.push(parseFloat(row.style.lineHeight));
          });
          (window as any).rowObserver.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["style"],
          });
        }, f.second.id);
        for (const [cols, rows] of [
          [60, 12],
          [120, 45],
          [55, 11],
          [100, 30],
        ]) {
          f.resizeScreen(cols, rows);
          // Split native redraw: the saved answer must survive the empty middle.
          f.output("\x1b[2J\x1b[H");
          await page.waitForTimeout(70);
          assert.equal(await answer.isVisible(), true);
          f.output(draw(cols));
          await page.waitForTimeout(100);
          assert.equal(await answer.isVisible(), true);
        }
        const heights: number[] = await page.evaluate(() => {
          (window as any).rowObserver.disconnect();
          return (window as any).rowHeights;
        });
        assert.ok(heights.length > 0);
        assert.ok(
          heights.every((h) => Math.abs(h - rowHeight) < 1),
          `stable ${rowHeight}px rows: ${Math.min(...heights)}..${Math.max(...heights)}`,
        );
        await bar
          .getByRole("button", { name: "여기서 제어", exact: true })
          .click();
        await bar.getByText("이 창에서 제어", { exact: true }).waitFor();
        assert.equal(
          (await bar.boundingBox())!.height,
          barHeight,
          "control status must not resize the terminal",
        );
        await pane.locator(".xterm-helper-textarea").focus();
        await page.keyboard.type("x");
        await page.waitForFunction(() =>
          document.body.textContent?.includes("shortcutsx"),
        );
        assert.equal(f.inputs.join(""), "x");

        const ownedBy = f.gateway.controls.view(f.second.id)!.clientId;
        await page.locator(`[data-terminal-tab="${f.id}"]`).click();
        await page.locator(`[data-terminal-tab="${f.second.id}"]`).click();
        await bar.getByText("이 창에서 제어", { exact: true }).waitFor();
        assert.equal(
          f.gateway.controls.view(f.second.id)?.clientId,
          ownedBy,
          "an internal tab switch keeps the current unexpired lease",
        );

        // Hold an old GET response while the server transfers control. The push
        // must precede its resize, and that late read must not restore ownership.
        let captured: (() => void) | undefined;
        const seenRead = new Promise<void>((r) => {
          captured = r;
        });
        const heldRead = new Promise<void>((r) => {
          releaseRead = r;
        });
        await page.route(
          `**/api/terminals/${f.second.id}/control`,
          async (route) => {
            if (route.request().method() !== "GET") return route.continue();
            const response = await route.fetch();
            captured?.();
            await heldRead;
            await route.fulfill({ response });
          },
        );
        await page.evaluate(() =>
          document.dispatchEvent(new Event("visibilitychange")),
        );
        await seenRead;
        await page.locator(`[data-terminal-tab="${f.id}"]`).click();
        const hostLease = f.gateway.controls.change(
          f.second.id,
          "local",
          "Host PC",
          { clientId: "local", action: "claim", takeover: true },
        );
        f.resizeScreen(72, 14);
        f.output(draw(72));
        await page.locator(`[data-terminal-tab="${f.second.id}"]`).click();
        await bar
          .getByText("보기 전용", { exact: true })
          .waitFor({ timeout: 1000 });
        await pane.getByText("Host PC에서 입력 중", { exact: true }).waitFor();
        await page.waitForFunction(
          ({ id, height }) => {
            const screen = document.querySelector<HTMLElement>(
              `[data-terminal-id="${id}"] .xterm-screen`,
            );
            return (
              !!screen &&
              Math.abs(parseFloat(screen.style.height) - height * 14) < 2
            );
          },
          { id: f.second.id, height: rowHeight },
        );
        releaseRead!();
        await page.unrouteAll({ behavior: "wait" });
        await page.waitForTimeout(100);
        assert.equal(await bar.getAttribute("data-control-mode"), "view");
        assert.equal(await answer.count(), 1);
        await pane.locator(".xterm-helper-textarea").focus();
        await page.keyboard.type("NO");
        assert.equal(f.inputs.join(""), "x");
        f.gateway.controls.change(f.second.id, "local", "Host PC", {
          clientId: "local",
          action: "release",
          token: hostLease.token,
        });
        await page.waitForTimeout(3200);
        assert.equal(
          f.gateway.controls.view(f.second.id),
          null,
          "viewers must not silently take an expired/free lease",
        );
        assert.equal(await bar.getAttribute("data-control-mode"), "view");
        await page.screenshot({ path: join(evidence, `${provider}.png`) });
        assert.deepEqual(errors, []);
      } catch (error) {
        await (
          await browser?.firstWindow()
        )
          ?.screenshot({ path: join(evidence, `${provider}-failure.png`) })
          .catch(() => {});
        throw error;
      } finally {
        releaseRead?.();
        await browser?.close();
        await proxy.close();
        await f.close();
      }
    },
  );
