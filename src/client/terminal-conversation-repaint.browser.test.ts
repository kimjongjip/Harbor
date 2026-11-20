import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import { build } from "esbuild";
import { _electron } from "playwright";

for (const provider of ["claude", "codex"])
  test(
    `idle ${provider} repaint fragments cannot alternate saved work and the raw screen`,
    { skip: process.platform !== "win32", timeout: 60000 },
    async () => {
      const prompt = provider === "codex" ? "›" : "❯";
      const root = resolve(".cache/conversation-repaint-tests");
      await mkdir(root, { recursive: true });
      const directory = await mkdtemp(join(root, "run-"));
      await build({
        stdin: {
          contents: `
import React,{useState,useEffect}from'react';import{createRoot}from'react-dom/client';
import{Terminal}from'@xterm/xterm';import{TerminalConversation}from'./src/client/TerminalConversation';
import'@xterm/xterm/css/xterm.css';import'./src/client/styles.css';import'./src/client/themes.css';
Object.defineProperty(document,'visibilityState',{get:()=> 'visible'});
window.inputs=[];window.requests=[];window.pendingTool=false;window.reportText='';
window.harborDesktop={workspaceTabs:()=>({})};
window.historyReady=new Promise(resolve=>window.releaseHistory=resolve);
window.freshReady=new Promise(resolve=>window.releaseFresh=resolve);
window.fetch=async(url,options)=>{window.requests.push({url:String(url),method:options?.method});await window.historyReady;
const preview = new URL(url,location.href).searchParams.has('reopen');
if(!preview) await window.freshReady;
const timeline=[{id:'question',kind:'user',text:'Update the sample',turnId:'turn'},
{id:'command',kind:'command',text:window.pendingTool?'Bash':'python3 sample.py',detail:window.pendingTool?'command: python fixture.py':'SAVED COMMAND OUTPUT',toolUseId:'fixture-tool',turnId:'turn',status:window.pendingTool?'started':'completed'}];
if(window.reportText)timeline.push({id:'progress',kind:'assistant',text:window.reportText,turnId:'turn',...('${provider}'==='codex'?{phase:'commentary'}:{})});
if(preview)timeline.push({id:'provisional',kind:'assistant',text:'Last known handoff report',turnId:'turn',phase:'commentary'});
return new Response(JSON.stringify({thread:{id:'session',hostId:'fixture',cwd:'/fixture'},items:timeline,timeline,nextCursor:null}),{headers:{'Content-Type':'application/json',...(preview?{'X-Harbor-History-Snapshot':'1'}:{})}})};
function Fixture(){const[term,setTerm]=useState(null),[info,setInfo]=useState({id:'terminal',hostId:'fixture',cwd:'/fixture',title:'Synthetic repaint',agentKind:'${provider}',agentSessionId:'session',agentState:'working'});
window.setWaiting=(waiting=true)=>setInfo(v=>({...v,agentState:waiting?'waiting':'working'}));
window.refreshHistory=()=>document.dispatchEvent(new Event('visibilitychange'));
useEffect(()=>{const t=new Terminal({cols:90,rows:24,fontSize:14,allowProposedApi:true});t.open(document.getElementById('native'));t.onData(data=>window.inputs.push(data));window.term=t;
window.write=data=>new Promise(done=>t.write(data,done));
window.partial=()=>window.write('\\x1b[2J\\x1b[H${prompt} Update the sample\\r\\n\\x1b[41m184 - OLD RAW DIFF\\x1b[0m\\r\\n\\x1b[42m184 + NEW RAW DIFF\\x1b[0m');
window.footer=()=>window.write('\\x1b[13;1H'+('${provider}'==='claude'?'─'.repeat(90)+'\\r\\n❯ UNSENT DRAFT\\r\\n'+'─'.repeat(90):'• Working\\r\\n› UNSENT DRAFT')+'\\r\\n  ? for shortcuts\\x1b[14;15H');
(async()=>{await window.partial();await window.footer();setTerm(t)})();return()=>t.dispose()},[]);
return <><div style={{position:'relative',height:650,width:1000}}><div id="native"/></div>{term&&<TerminalConversation term={term} info={info}/>}</>}
createRoot(document.getElementById('root')).render(<Fixture/>);`,
          resolveDir: process.cwd(),
          sourcefile: "repaint-fixture.tsx",
          loader: "tsx",
        },
        bundle: true,
        format: "esm",
        outfile: join(directory, "fixture.js"),
        loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
        logLevel: "silent",
      });
      const app = express();
      app.use(express.static(directory));
      app.get("/", (_req, res) =>
        res
          .type("html")
          .send(
            '<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
          ),
      );
      const server = createServer(app);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const main = join(directory, "electron.cjs");
      await writeFile(
        main,
        `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.commandLine.appendSwitch('disable-gpu');app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:850,webPreferences:{backgroundThrottling:false,contextIsolation:true,sandbox:true}}).loadURL('http://127.0.0.1:${(server.address() as { port: number }).port}'));app.on('window-all-closed',()=>app.quit());`,
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
        const surface = page.getByRole("region", { name: "터미널 출력" });
        const work = page.locator('[data-work-item="command"]');
        // The initial history read must not first expose the entire raw
        // transcript. Keep the real composer usable during that read.
        await surface
          .getByText(`${prompt} UNSENT DRAFT`, { exact: true })
          .waitFor();
        assert.equal(await surface.getByText(/OLD RAW DIFF/).count(), 0);
        assert.equal(await surface.getByText("대화를 불러오는 중…").count(), 1);
        await page.evaluate(() => (window as any).releaseHistory());
        const provisional = surface.getByText("Last known handoff report", {
          exact: true,
        });
        await provisional.waitFor();
        await page.waitForFunction(() =>
          (window as any).requests.some(
            (r: any) =>
              r.url.includes("terminalView=") && !r.url.includes("reopen="),
          ),
        );
        await page.evaluate(() => (window as any).releaseFresh());
        await provisional.waitFor({ state: "detached", timeout: 2500 });
        await work.waitFor();
        await page.waitForTimeout(200);
        await page.evaluate(async (prompt) => {
          const w = window as any;
          w.term.resize(90, 36);
          await w.write(
            "\x1b[2J\x1b[H" +
              prompt +
              " Update the sample\r\n● Unrecorded fixture progress · summary\r\n  Active fixture command",
          );
          await w.footer();
        }, prompt);
        const progress = surface.getByText(
          "● Unrecorded fixture progress · summary",
          { exact: true },
        );
        await progress.waitFor();
        const initialY = await progress.evaluate(
          (el) => el.getBoundingClientRect().top,
        );
        // History recall belongs to the CLI even when its redraw has no
        // recognizable composer, and while navigating past multiple prompts.
        await page.evaluate((prompt) => {
          const w = window as any;
          let index = 0;
          w.modeChanges = [];
          w.modeObserver = new MutationObserver((changes) =>
            w.modeChanges.push(...changes),
          );
          w.modeObserver.observe(
            document.querySelector(".terminal-conversation"),
            { attributes: true, attributeFilter: ["hidden"] },
          );
          w.term.resize(90, 36);
          w.recall = w.term.onData((data: string) => {
            if (!/^\x1b(?:\[|O)[AB]$/.test(data)) return;
            index += data.endsWith("A") ? 1 : -1;
            if (!index) {
              void w.write("\x1b[2J\x1b[H").then(() => w.footer());
              return;
            }
            void w.write(
              "\x1b[2J\x1b[HWorking…\r\n" +
                prompt +
                " 이전 프롬프트 " +
                index +
                " FIRST\r\n" +
                Array.from(
                  { length: 23 },
                  (_, i) => "  recalled prompt line " + i,
                ).join("\r\n") +
                "\r\n  이전 프롬프트 " +
                index +
                " LAST\r\n  esc to interrupt",
            );
          });
          w.term.focus();
        }, prompt);
        for (const [key, index] of [
          ["ArrowUp", 1],
          ["ArrowUp", 2],
          ["ArrowDown", 1],
        ] as const) {
          await page.keyboard.press(key);
          const input = surface.locator(
            ".terminal-native-flow:not(.terminal-native-work)",
          );
          await input
            .getByText(prompt + " 이전 프롬프트 " + index + " FIRST", {
              exact: true,
            })
            .waitFor({ timeout: 2500 });
          await input
            .getByText("이전 프롬프트 " + index + " LAST", { exact: true })
            .waitFor({ timeout: 2500 });
          assert.equal(await work.isVisible(), true);
          if (index === 2) {
            await page.evaluate(() => {
              const w = window as any;
              w.reportText = "History arrived while reading the draft";
              w.refreshHistory();
            });
            await page.waitForTimeout(250);
          }
          assert.equal(await progress.isVisible(), true);
          const inputBox = input.locator(
            ".terminal-flow-composer[data-history]",
          );
          assert.equal(
            await inputBox.evaluate((el) => {
              if (el.scrollHeight <= el.clientHeight) return false;
              el.scrollTop = el.scrollHeight;
              return el.scrollTop > 0;
            }),
            true,
            "long prompts scroll within the composer",
          );
          assert.ok(
            Math.abs(
              (await progress.evaluate(
                (el) => el.getBoundingClientRect().top,
              )) - initialY,
            ) <= 1,
            "the activity above the composer must not jump",
          );
          assert.equal(
            await surface
              .getByText("History arrived while reading the draft")
              .count(),
            0,
          );
          assert.equal(
            await page.evaluate(
              () => document.activeElement === (window as any).term.textarea,
            ),
            true,
          );
        }
        await page.keyboard.press("ArrowDown");
        await surface
          .getByText(prompt + " UNSENT DRAFT", { exact: true })
          .waitFor({ timeout: 2500 });
        await surface
          .getByText("History arrived while reading the draft")
          .waitFor({ timeout: 3000 });
        assert.equal(
          await page.evaluate(() => {
            const w = window as any;
            w.modeObserver.disconnect();
            return w.modeChanges.length;
          }),
          0,
          "recall must never expose the raw screen between frames",
        );
        assert.deepEqual(await page.evaluate(() => (window as any).inputs), [
          "\x1b[A",
          "\x1b[A",
          "\x1b[B",
          "\x1b[B",
        ]);
        await page.evaluate(async () => {
          const w = window as any;
          w.recall.dispose();
          w.term.reset();
          w.term.resize(90, 24);
          w.inputs.length = 0;
          await w.partial();
          await w.footer();
        });
        await page.evaluate(() => {
          (window as any).savedWork = document.querySelector(
            '[data-work-item="command"]',
          );
          (window as any).flashes = 0;
          (window as any).observer = new MutationObserver(() => {
            if (!document.querySelector('[data-work-item="command"]'))
              (window as any).flashes++;
          });
          (window as any).observer.observe(
            document.querySelector(".terminal-conversation")!,
            { subtree: true, childList: true },
          );
        });
        // No mouse or keyboard activity: the CLI clears and redraws its footer
        // in separate output chunks while history continues to poll.
        for (let cycle = 0; cycle < 4; cycle++) {
          await page.evaluate(() => {
            (window as any).refreshHistory();
            return (window as any).partial();
          });
          // SSH redraws can span much longer than the old 160ms grace. Also
          // refresh saved history while the native footer is still absent.
          await page.waitForTimeout(cycle === 0 ? 1000 : 240);
          await page.evaluate(() => (window as any).refreshHistory());
          await page.waitForTimeout(160);
          assert.equal(
            await work.count(),
            1,
            "a repaint fragment must keep the saved work mounted",
          );
          assert.equal(
            await page.evaluate(
              () =>
                (window as any).savedWork ===
                document.querySelector('[data-work-item="command"]'),
            ),
            true,
          );
          assert.notEqual(
            await page
              .locator(".terminal-conversation")
              .getAttribute("data-native-live"),
            null,
          );
          await page.evaluate(() => (window as any).footer());
          await page.waitForTimeout(80);
        }
        assert.equal(
          await page.evaluate(() => {
            (window as any).observer.disconnect();
            return (window as any).flashes;
          }),
          0,
          "no intermediate DOM update may flash the raw screen",
        );
        // Real long-running commands replace the composer with task progress.
        // The command heading/diff can be outside the current 80-row tail.
        // Observe EVERY intermediate DOM commit, not just the eventual footer.
        await page.evaluate(() => {
          (window as any).flashes = 0;
          (window as any).observer.observe(
            document.querySelector(".terminal-conversation")!,
            { subtree: true, childList: true },
          );
        });
        for (let cycle = 0; cycle < 3; cycle++) {
          await page.evaluate(async (cycle) => {
            const w = window as any;
            await w.write(
              "\x1b[2J\x1b[H  python simulator.py --case fixture\r\n  elapsed output chunk " +
                cycle,
            );
            w.refreshHistory();
          }, cycle);
          await page.waitForTimeout(350);
          assert.equal(
            await work.count(),
            1,
            "unclassified command fragment must not switch to raw transcript",
          );
          await page.evaluate(async (cycle) => {
            await (window as any).write(
              "\x1b[8;1H  Run the synthetic simulation · " +
                (13 + cycle) +
                "s\r\n    └ $ python simulator.py --case fixture\r\n    (ctrl+b ctrl+b (twice) to run in background)",
            );
          }, cycle);
          await surface
            .getByText("(ctrl+b ctrl+b (twice) to run in background)", {
              exact: true,
            })
            .waitFor({ timeout: 1500 });
          assert.equal(
            await work.count(),
            1,
            "running task view keeps saved work",
          );
          await page.evaluate(() => (window as any).partial());
          await page.waitForTimeout(250);
          await page.evaluate(() => (window as any).footer());
          await page.waitForTimeout(100);
        }
        assert.equal(
          await page.evaluate(() => {
            (window as any).observer.disconnect();
            return (window as any).flashes;
          }),
          0,
        );
        // A hook's waiting state is not evidence of an approval dialog. A
        // normal composer must keep the same saved work, even on a quiet CLI.
        await page.evaluate(() => (window as any).setWaiting());
        await page.waitForTimeout(300);
        assert.equal(
          await work.count(),
          1,
          "waiting with a composer stays typeset",
        );
        assert.equal(
          await page.evaluate(
            () =>
              (window as any).savedWork ===
              document.querySelector('[data-work-item="command"]'),
          ),
          true,
        );
        await page.evaluate(() => (window as any).setWaiting(false));
        // A submitted long prompt can contain numbered requirements and quoted
        // terminal instructions. Its redraw chunks are not approval dialogs.
        await page.evaluate(() => {
          (window as any).flashes = 0;
          (window as any).observer.observe(
            document.querySelector(".terminal-conversation")!,
            { subtree: true, childList: true },
          );
        });
        for (const fragment of [
          `${prompt} 1. Inspect the synthetic simulator\r\n  2. Compare the two implementations\r\n  3. Explain the result`,
          `${prompt} Explain this log message in the final report:\r\n  The example says press Enter to continue, but do not execute it.`,
          `${prompt} Explain this log message in the final report:\r\n  Press Enter to continue, but this is only a quoted example.`,
          `${prompt} The fixture emitted this text:\r\n  Process exited.`,
          `${prompt} Explain this shell example:\r\nPS C:\\fixture>`,
          `${prompt} Explain this exact log line:\r\nPress Enter to continue`,
        ]) {
          await page.evaluate(
            (fragment) => (window as any).write("\x1b[2J\x1b[H" + fragment),
            fragment,
          );
          await page.waitForTimeout(400);
          assert.equal(
            await work.count(),
            1,
            "prompt text must not replace the typeset transcript",
          );
          await page.evaluate(() => (window as any).footer());
          await page.waitForTimeout(100);
        }
        // Even genuine UI-looking fragments must stay stable for their own
        // grace period; an earlier candidate's timer cannot authorize them.
        await page.evaluate(() => (window as any).setWaiting());
        await page.evaluate(() =>
          (window as any).write("\x1b[2J\x1b[HPress Enter to continue"),
        );
        await page.waitForTimeout(60);
        await page.evaluate(() =>
          (window as any).write(
            "\x1b[2J\x1b[H  rendering the next output chunk",
          ),
        );
        await page.waitForTimeout(240);
        await page.evaluate(() =>
          (window as any).write("\x1b[2J\x1b[HPress Enter to continue"),
        );
        await page.waitForTimeout(60);
        assert.equal(
          await work.count(),
          1,
          "a different incomplete redraw needs a fresh stability interval",
        );
        await page.evaluate(() => (window as any).footer());
        await page.waitForTimeout(100);
        assert.equal(
          await page.evaluate(() => {
            (window as any).observer.disconnect();
            return (window as any).flashes;
          }),
          0,
        );
        await page.evaluate(() => (window as any).setWaiting(false));
        // A real prompt echo must still appear immediately, without the repaint
        // grace period applying to ordinary text/cursor changes.
        await page.evaluate(
          (prompt) =>
            (window as any).write("\x1b[14;1H" + prompt + " FAST ECHO\x1b[K"),
          prompt,
        );
        await surface
          .getByText(`${prompt} FAST ECHO`, { exact: true })
          .waitFor();
        // Missing chrome may also mean a real permission dialog or a CLI exit.
        // Admit a persistent new surface even if it sends no further output.
        await page.evaluate(() => {
          (window as any).setWaiting();
          return (window as any).write(
            "\x1b[2J\x1b[HAllow running this command?\r\n❯ 1. Yes\r\n  2. No",
          );
        });
        await surface
          .getByText("Allow running this command?", { exact: true })
          .waitFor({ timeout: 1500 });
        await page.waitForFunction(
          () =>
            !document
              .querySelector(".terminal-conversation")
              ?.hasAttribute("data-native-live"),
          undefined,
          { timeout: 1500 },
        );
        assert.equal(
          await page
            .locator(".terminal-conversation")
            .getAttribute("data-native-live"),
          null,
        );
        await page.evaluate(() =>
          (window as any).write("\x1b[2J\x1b[HProcess exited.\r\n$ "),
        );
        await surface
          .getByText("Process exited.", { exact: true })
          .waitFor({ timeout: 1500 });
        assert.deepEqual(await page.evaluate(() => (window as any).inputs), []);
        assert.equal(
          await page.evaluate(() =>
            (window as any).requests.every((r: any) => r.method === "GET"),
          ),
          true,
        );
        assert.deepEqual(errors, []);
        if (provider === "claude") {
          await page.evaluate(async () => {
            const w = window as any;
            w.pendingTool = true;
            w.setWaiting(false);
            await w.partial();
            await w.footer();
            w.refreshHistory();
          });
          await page.waitForFunction(() =>
            document
              .querySelector('[data-work-item="command"]')
              ?.textContent?.includes("실행 중"),
          );
          const heights: number[] = [];
          for (let cycle = 0; cycle < 6; cycle++) {
            await page.evaluate(async (cycle) => {
              const w = window as any;
              await w.write(
                "\x1b[2J\x1b[H" +
                  (cycle % 2
                    ? "● Running fixture · 49s\r\n  short task preview"
                    : "● Update(fixture.py)\r\n" +
                      Array.from(
                        { length: 9 },
                        (_, i) =>
                          "\x1b[42m" + (80 + i) + " + OLD DIFF ROW\x1b[0m",
                      ).join("\r\n")),
              );
              await w.footer();
            }, cycle);
            await page.waitForTimeout(120);
            assert.equal(
              await surface
                .locator(".terminal-native-work [data-native-row]")
                .count(),
              0,
              "pending command must not alternate with a duplicated native diff",
            );
            heights.push(
              await surface
                .locator(".terminal-conversation-body")
                .evaluate((e) => e.scrollHeight),
            );
          }
          assert.ok(
            Math.max(...heights) - Math.min(...heights) <= 1,
            "tool redraws must not move the document height/scroll anchor",
          );
          await page.evaluate(() =>
            (window as any).write("\x1b[14;1H❯ EDITING DURING TOOL\x1b[K"),
          );
          await surface
            .getByText("❯ EDITING DURING TOOL", { exact: true })
            .waitFor();
          // None of these rows is in saved history. Claude keeps them around
          // a foreground job even when the spinner and tips displace its footer.
          await page.evaluate(() =>
            (window as any).write(
              [
                "\x1b[2J\x1b[H● Update(previous.py)",
                "  42 + OLD EDIT",
                "● The measurement is ready",
                "  and validation continues · summary",
                "",
                "  Run validation · 2m 31s",
                "    └ $ run fixture",
                "    (ctrl+b ctrl+b (twice) to run in background)",
                "",
                "· Processing… (17m 34s)",
                "  └ Tip: adjust effort",
                "",
                "✔ Update installed · /restart to apply",
              ].join("\r\n"),
            ),
          );
          await surface
            .getByText("● The measurement is ready", { exact: true })
            .waitFor();
          await surface
            .getByText("  Run validation · 2m 31s", { exact: true })
            .waitFor();
          assert.equal(await surface.getByText("42 + OLD EDIT").count(), 0);
          await page.evaluate(async () => {
            const w = window as any;
            await w.write(
              "\x1b[2J\x1b[H· Processing… (18s)\r\n\r\n  Please also check the second case\r\n  and compare the results\r\n  ctrl+x ctrl+s to send now",
            );
            await w.footer();
          });
          await surface
            .getByText("Please also check the second case", { exact: true })
            .waitFor();
          await surface
            .getByText("and compare the results", { exact: true })
            .waitFor();
          await surface
            .getByText("ctrl+x ctrl+s to send now", { exact: true })
            .waitFor();
          assert.equal(await work.count(), 1);
          await page.evaluate(() => {
            (window as any).setWaiting();
            return (window as any).write(
              "\x1b[2J\x1b[HAllow running this command?\r\n❯ 1. Yes\r\n  2. No",
            );
          });
          await surface
            .getByText("Allow running this command?", { exact: true })
            .waitFor({ timeout: 2000 });
          assert.deepEqual(
            await page.evaluate(() => (window as any).inputs),
            [],
          );
        }
        await page.evaluate(async () => {
          const w = window as any;
          w.setWaiting(false);
          await w.partial();
          await w.footer();
          w.reportText = "**INTERMEDIATE REPORT**: testing continues";
          w.refreshHistory();
        });
        const report = surface.locator('[data-history-message="progress"]');
        await report
          .locator("strong")
          .getByText("INTERMEDIATE REPORT", { exact: true })
          .waitFor();
        const group = surface.locator(".conversation-work");
        assert.equal(await group.count(), 1);
        await group.locator(":scope > summary").click();
        assert.equal(await work.count(), 0);
        assert.equal(await report.isVisible(), true);
        assert.equal(
          await report.evaluate((node) => !!node.closest(".conversation-work")),
          false,
        );
        await page.evaluate(() => {
          const w = window as any;
          w.reportText += " — **NEW FINDING**";
          w.refreshHistory();
        });
        await report
          .locator("strong")
          .getByText("NEW FINDING", { exact: true })
          .waitFor();
        assert.equal(
          await group.evaluate((node) => (node as HTMLDetailsElement).open),
          false,
        );
        // Drive xterm's keyboard path. The fake CLI echoes the command,
        // draws two different picker screens and restores its composer.
        const reader = page.locator(".terminal-conversation");
        if (provider === "codex") {
          // Keep both sides of the underlying transcript and its ordinary
          // composer, as Codex does when drawing a centered permission dialog.
          await page.evaluate(async () => {
            const w = window as any;
            w.inputs.length = 0;
            const background = Array.from({ length: 20 }, () =>
              "한글 기록 ".repeat(10),
            ).join("\r\n");
            await w.write(
              "\x1b[2J\x1b[H" +
                background +
                "\x1b[21;1H› Ask Codex to do anything\r\n  ? for shortcuts\x1b[21;3H",
            );
            w.paintChoices = (cancel: boolean) =>
              w.write(
                "\x1b7\x1b[5;16H Enable full access?                   " +
                  "\x1b[6;16H Exercise caution                      " +
                  "\x1b[8;16H" +
                  (cancel ? "  " : "\x1b[44m› ") +
                  "1. Yes, continue anyway             \x1b[0m" +
                  "\x1b[9;16H" +
                  (cancel ? "\x1b[44m› " : "  ") +
                  "2. Cancel                           \x1b[0m" +
                  "\x1b[11;16H  enter select · esc back            \x1b8",
              );
            w.choiceKeys = w.term.onData((s: string) => {
              if (s.endsWith("B")) void w.paintChoices(true);
              if (s === "\x1b")
                void w.write("\x1b[2J\x1b[H").then(() => w.footer());
            });
            await w.paintChoices(false);
            w.term.focus();
          });
          await reader.waitFor({ state: "hidden", timeout: 2000 });
          assert.deepEqual(
            await page.evaluate(() => (window as any).inputs),
            [],
          );
          await page.keyboard.press("ArrowDown");
          await page.waitForFunction(
            () => {
              const t = (window as any).term,
                b = t.buffer.active,
                box = t.element
                  .querySelector(".xterm-screen")
                  .getBoundingClientRect();
              return (
                b
                  .getLine(b.baseY + 8)
                  ?.translateToString(true)
                  .includes("› 2. Cancel") &&
                t.element.contains(
                  document.elementFromPoint(
                    box.left + box.width / 2,
                    box.top + box.height / 2,
                  ),
                )
              );
            },
            undefined,
            { timeout: 2000 },
          );
          await page.keyboard.press("Escape");
          await surface.waitFor({ timeout: 2000 });
          assert.equal(await report.isVisible(), true);
          assert.deepEqual(
            await page.evaluate(() => {
              const w = window as any;
              w.choiceKeys.dispose();
              return w.inputs;
            }),
            ["\x1b[B", "\x1b"],
          );
        }
        for (const command of ["/model", "/effort"]) {
          await page.evaluate(
            ({ prompt, command }) => {
              const w = window as any;
              w.inputs.length = 0;
              let stage = 0;
              w.drawPicker = (selected: number) =>
                w.write(
                  "\x1b[2J\x1b[H" +
                    (command === "/model"
                      ? "Select model"
                      : "Reasoning effort") +
                    "\r\n" +
                    (selected === 0 ? "❯ " : "  ") +
                    "First option\r\n" +
                    (selected === 1 ? "❯ " : "  ") +
                    "Second option\r\n↑/↓ to navigate · Enter to select · Esc to cancel",
                );
              w.picker = w.term.onData((s: string) => {
                if (s === "\r" && stage === 0) {
                  stage++;
                  void w.drawPicker(0);
                } else if (s.endsWith("B") && stage === 1) void w.drawPicker(1);
                else if ((s === "\r" || s === "\x1b") && stage === 1) {
                  stage++;
                  void w.write("\x1b[2J\x1b[H").then(() => w.footer());
                } else if (stage === 0) void w.write(s);
              });
              return w
                .write("\x1b[2J\x1b[H" + prompt + " ")
                .then(() => w.term.focus());
            },
            { prompt, command },
          );
          await page.keyboard.type(command);
          await page.waitForFunction(() =>
            document
              .querySelector(".terminal-conversation")
              ?.hasAttribute("data-native-menu"),
          );
          await page.keyboard.press("Enter");
          await page.keyboard.press("ArrowDown");
          await page.waitForFunction(
            () => {
              const buffer = (window as any).term.buffer.active;
              return buffer
                .getLine(buffer.baseY + 2)
                ?.translateToString(true)
                .includes("❯ Second option");
            },
            undefined,
            { timeout: 2500 },
          );
          assert.equal(await reader.isVisible(), false);
          await page.keyboard.press(command === "/model" ? "Enter" : "Escape");
          await surface.waitFor();
          assert.equal(await report.isVisible(), true);
          assert.equal(
            await group.evaluate((node) => (node as HTMLDetailsElement).open),
            false,
          );
          const keys = await page.evaluate(() => {
            const w = window as any;
            w.picker.dispose();
            return w.inputs.join("");
          });
          assert.match(
            keys,
            new RegExp(
              "^" +
                command +
                "\\r\\x1b(?:\\[|O)B" +
                (command === "/model" ? "\\r" : "\\x1b") +
                "$",
            ),
          );
        }
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
