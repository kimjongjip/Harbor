import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { _electron } from "playwright";
import { Files } from "../server/files";
import { EditorFiles } from "../server/editor-files";
import { IdeChats } from "../server/ide-chat";
import { IdeLiveChats } from "../server/ide-chat-live";
import { TerminalScreen } from "../server/terminal-screen";
import type { HostConfig } from "../shared/types";
import { mobileFixture, origin } from "../test/mobile-fixture";

test(
  "paired desktop shares existing terminals, hands off input and lazily edits the same workspace",
  {
    skip: process.platform !== "win32",
    timeout: 120000,
  },
  async () => {
    const f = await mobileFixture();
    f.state.hosts.push({
      id: "empty-host",
      name: "터미널 없는 서버",
      kind: "local",
    });
    const root = join(f.directory, "project");
    await mkdir(root);
    const filename = join(root, "hello.ts");
    await writeFile(filename, "export const value = 1;\n");
    const docs = join(root, "docs");
    await mkdir(docs);
    const markdown =
      "# 원격 PC에서 읽는 문서\n\n[다음 문서](./details.md) · [아래 계획으로 이동](#계획)\n\n" +
      "| 항목 | 상태 |\n| --- | --- |\n| Markdown 읽기 | 정상 |\n\n수식 $x^2 + y^2$\n\n" +
      "```mermaid\nflowchart LR\n  A[문서 읽기] --> B[다음 문서]\n```\n\n## 계획\n\n" +
      "터미널 제어 권한을 가져오지 않고 문서를 읽습니다.\n\n".repeat(15);
    await writeFile(join(docs, "README.md"), markdown);
    await writeFile(
      join(docs, "details.md"),
      "# 연결된 원격 문서\n\n[돌아가기](./README.md)\n\n같은 문서 폴더에서 열었습니다.\n",
    );
    f.state.terminals[0].cwd = root;
    const secondId = crypto.randomUUID();
    f.state.terminals.push({
      ...f.state.terminals[0],
      id: secondId,
      title: "두 번째 PC 세션",
      agentSessionId: "native-second",
    });
    const second = new TerminalScreen();
    second.resize(90, 24);
    second.append("SECOND SESSION READY > ");
    const writes: { id: string; data: string }[] = [];
    const resizes: { id: string; cols: number; rows: number }[] = [];
    const annotations: { id: string; text: string; comment: string }[] = [];
    const directMessages: string[] = [];
    const chats = new IdeChats({
      runtimeId: f.state.runtimeId,
      hub: {} as never,
      host: () =>
        ({ id: "fixture", kind: "local", defaultCwd: root }) as HostConfig,
      password: () => undefined,
      resolveCwd: async () => root,
      historyList: async () => ({ data: [], nextCursor: null }),
      historyRead: async () => {
        throw new Error("No synthetic history");
      },
      nativeActive: () => false,
      live: new IdeLiveChats({
        terminals: () => f.state.terminals,
        terminal: (id) => f.state.terminals.find((item) => item.id === id),
        readHistory: async (hostId, provider, nativeId) => ({
          thread: {
            id: nativeId,
            hostId,
            provider,
            title: "이미 열린 대화",
            cwd: root,
            preview: "",
            source: "cli",
            updatedAt: 1,
            active: true,
          },
          items: [
            {
              id: "live-question",
              kind: "user",
              text: "이 터미널에서 하던 질문입니다.",
            },
            {
              id: "live-answer",
              kind: "assistant",
              text: "실행 중인 대화를 IDE에 표시합니다.",
            },
          ],
          nextCursor: null,
        }),
        codex: {
          available: () => true,
          currentSession: (id) =>
            f.state.terminals.find((item) => item.id === id)?.agentSessionId,
          submitUser: async () => {
            throw new Error("Unexpected live input");
          },
        },
        claude: {
          available: () => false,
          send: async () => {
            throw new Error("Unexpected channel input");
          },
        },
      }),
      claude: (turn) => {
        directMessages.push(turn.text);
        turn.events.native(turn.nativeId);
        turn.events.item({
          id: "direct-answer",
          kind: "assistant",
          text: "선택한 코드를 검토했습니다.",
        });
        return {
          done: Promise.resolve(),
          interrupt: async () => {},
          close() {},
        };
      },
    });
    f.operations.ideChat = chats;
    f.operations.write = (id, data) => writes.push({ id, data });
    f.operations.annotate = (id, text, comment) => {
      annotations.push({ id, text, comment });
      return { reference: `[#${annotations.length} annotation]` };
    };
    const blockId = "aabbccddeeff00112233";
    const richText =
      "# 공유한 답변\n\n수식 $x^2$\n\n| 항목 | 값 |\n| --- | --- |\n| 읽기 | 정상 |\n\n답변의 마지막 문장입니다.";
    f.screen.append(
      "\r\n" +
        Array.from(
          { length: 16 },
          (_, row) => `~HBR:${blockId}:${row}~\r\n`,
        ).join("") +
        "NATIVE AFTER ANSWER > ",
    );
    f.operations.answers = (id) =>
      id === f.id
        ? [
            {
              id: blockId,
              sessionId: "native-fixture",
              requestId: "remote-fixture",
              text: richText,
              marker: `~HBR:${blockId}~`,
              renderer: "rows-v2",
              state: "ready",
              columns: 100,
              viewportRows: 30,
              rows: 16,
              createdAt: 1,
            },
          ]
        : [];
    f.operations.snapshot = (id) =>
      (id === f.id ? f.screen : second).snapshot();
    f.operations.resize = (id, cols, rows) => {
      resizes.push({ id, cols, rows });
      (id === f.id ? f.screen : second).resize(cols, rows);
      f.gateway.resize(id, cols, rows);
    };
    const files = new Files(() => undefined);
    files.resolvePath = async (_host, filename, cwd) => {
      assert.equal(filename, "~");
      assert.equal(cwd, "~");
      return root;
    };
    f.operations.editor = new EditorFiles({
      files,
      terminal: (id) => f.state.terminals.find((item) => item.id === id),
      host: () =>
        ({ id: "fixture", kind: "local", defaultCwd: root }) as HostConfig,
    });
    // Mount the editor on this isolated listener only, before the test windows open.
    await f.gateway.stop();
    await f.gateway.start();
    const proxy = createServer((req, res) => {
      const upstream = request(
        f.url + req.url,
        {
          method: req.method,
          headers: {
            ...req.headers,
            host: new URL(origin).host,
            ...(req.headers.origin ? { origin } : {}),
          },
        },
        (response) => {
          const forward = () => {
            res.writeHead(response.statusCode!, response.headers);
            response.pipe(res);
          };
          // Network latency must not turn a burst into one round trip per key.
          if (req.url === "/mobile-api/input") setTimeout(forward, 80);
          else forward();
        },
      );
      upstream.on("error", () => {
        res.statusCode = 502;
        res.end();
      });
      req.pipe(upstream);
    });
    const sockets = new WebSocketServer({ noServer: true });
    proxy.on("upgrade", (req, socket, head) =>
      sockets.handleUpgrade(req, socket, head, (client) => {
        const remote = new WebSocket(
          f.url.replace("http:", "ws:") + "/mobile-ws",
          {
            headers: {
              host: new URL(origin).host,
              origin,
              cookie: req.headers.cookie || "",
            },
          },
        );
        const pending: string[] = [];
        client.on("message", (data) => {
          if (remote.readyState === WebSocket.OPEN) remote.send(String(data));
          else pending.push(String(data));
        });
        remote.on("open", () => {
          for (const data of pending) remote.send(data);
        });
        remote.on("message", (data) => {
          if (client.readyState === WebSocket.OPEN) client.send(String(data));
        });
        remote.on("close", (code) => client.close(code === 1006 ? 1011 : code));
        client.on("close", () => remote.close());
        remote.on("error", () => client.close());
        client.on("error", () => remote.close());
      }),
    );
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const port = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/desktop/`;
    const invite = new URL(f.access.pairing("desktop").url).hash;
    const main = join(f.directory, "desktop-review.cjs");
    await writeFile(
      main,
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(f.directory, "profile"))});app.commandLine.appendSwitch('disable-gpu');app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1200,height:850,webPreferences:{backgroundThrottling:false,nodeIntegration:false,contextIsolation:true,sandbox:true}});w.loadURL(${JSON.stringify(url + invite)});});app.on('window-all-closed',()=>app.quit());`,
    );
    let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      delete env.ELECTRON_RUN_AS_NODE;
      app = await _electron.launch({ args: [main], env });
      const page = await app.firstWindow();
      const errors: string[] = [];
      const requests: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => requests.push(request.url()));
      await page
        .getByRole("button", { name: "등록하고 세션 보기", exact: true })
        .click();
      await page.waitForFunction(
        () =>
          document.querySelector(".remote-app > main > header [role=status]")
            ?.textContent === "연결됨",
      );
      assert.equal(
        await page
          .getByRole("navigation", { name: "열린 세션" })
          .getByRole("button")
          .count(),
        2,
      );
      assert.equal(writes.length, 0);
      assert.equal(resizes.length, 0);
      assert.equal(
        f.gateway.controls.view(f.id),
        null,
        "opening a desktop is read-only until input/control",
      );
      assert.equal(
        requests.some((url) => url.includes("/editor/")),
        false,
        "terminal startup never loads editor files",
      );
      await page.locator(".remote-rich-block table").waitFor();
      await page.locator(".remote-rich-block .katex").first().waitFor();
      await page
        .getByRole("button", { name: "전체 답변", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "전체 답변" })
        .getByText("답변의 마지막 문장입니다.", { exact: true })
        .waitFor();
      await page
        .getByRole("dialog", { name: "전체 답변" })
        .getByRole("button", { name: "닫기", exact: true })
        .click();
      assert.equal(
        writes.length,
        0,
        "reading the full typeset answer never injects input",
      );
      // Terminal-generated reports are not user gestures and must never claim control.
      const queries = "\x1b[6n\x1b[c\x1b[>c";
      f.screen.append(queries);
      f.gateway.output(f.id, queries);
      await page.waitForTimeout(350);
      assert.equal(
        writes.length,
        0,
        "cursor/device reports do not enter the input queue while viewing",
      );
      assert.equal(
        f.gateway.controls.view(f.id),
        null,
        "protocol replies never claim input ownership",
      );
      assert.equal(
        resizes.length,
        0,
        "protocol replies never resize the shared terminal",
      );

      // A second authenticated tab sees the same running processes with a distinct input owner.
      const otherWindow = app.waitForEvent("window");
      await app.evaluate(({ BrowserWindow }, destination) => {
        const window = new BrowserWindow({
          show: false,
          width: 1100,
          height: 800,
          webPreferences: {
            backgroundThrottling: false,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        void window.loadURL(destination);
      }, url);
      const other = await otherWindow;
      other.on("pageerror", (error) => errors.push(error.message));
      await other.waitForFunction(
        () =>
          document.querySelector(".remote-app > main > header [role=status]")
            ?.textContent === "연결됨",
      );
      await page
        .getByRole("button", { name: "여기서 제어", exact: true })
        .click();
      await page
        .getByRole("button", { name: "이 PC에서 제어 중", exact: true })
        .waitFor();
      await other.getByText(/에서 제어 중 · 읽기 전용/).waitFor();
      const firstOwner = f.gateway.controls.view(f.id)!.clientId;
      const input = page.locator(".remote-xterm .xterm-helper-textarea");
      const inputAck = page.waitForResponse(
        (response) =>
          response.url().endsWith("/mobile-api/input") &&
          response.status() === 200,
      );
      await input.focus();
      await input.pressSequentially("echo shared");
      await input.press("Enter");
      await inputAck;
      const end = Date.now() + 5000;
      while (
        writes.map((item) => item.data).join("") !== "echo shared\r" &&
        Date.now() < end
      )
        await page.waitForTimeout(30);
      assert.equal(writes.map((item) => item.data).join(""), "echo shared\r");
      assert.ok(
        writes.length < 8,
        "keyboard bursts are batched while acknowledgement is pending",
      );
      assert.ok(writes.every((item) => item.id === f.id));

      await other
        .getByRole("button", { name: "여기서 제어", exact: true })
        .click();
      await page.getByText(/에서 제어 중 · 읽기 전용/).waitFor();
      assert.notEqual(f.gateway.controls.view(f.id)?.clientId, firstOwner);
      const beforeBlocked = writes.length;
      await input.focus();
      await input.pressSequentially("blocked");
      await page.getByRole("alert").filter({ hasText: /제어/ }).waitFor();
      assert.equal(
        writes.length,
        beforeBlocked,
        "a read-only tab never injects input into the peer's terminal",
      );

      // IDE reading is available without taking the other tab's input lease.
      const readerOwner = f.gateway.controls.view(f.id)?.clientId;
      const writesBeforeReading = writes.length;
      await page.getByRole("button", { name: "IDE", exact: true }).click();
      await page
        .getByText("실행 중인 대화를 IDE에 표시합니다.", { exact: true })
        .waitFor();
      assert.equal(
        f.state.terminals.length,
        2,
        "IDE reuses the open CLI instead of starting another one",
      );
      assert.equal(
        await page.locator(".remote-app > aside").isVisible(),
        false,
      );
      assert.equal(
        await page.locator("#remote-terminal-dock").isVisible(),
        false,
      );
      await page.getByRole("tree", { name: "작업 폴더 파일" }).waitFor();
      await page
        .getByRole("tree", { name: "작업 폴더 파일" })
        .getByRole("button", { name: "docs", exact: true })
        .click();
      await page
        .getByRole("button", { name: "README.md", exact: true })
        .click();
      const reader = page.locator(".ide-reading");
      await reader
        .getByRole("heading", { name: "원격 PC에서 읽는 문서", exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "읽기", exact: true })
          .getAttribute("aria-pressed"),
        "true",
        "paired desktop Markdown opens directly in its reading pane",
      );
      assert.equal(await page.locator(".ide-source-host").isVisible(), false);
      await reader
        .getByRole("columnheader", { name: "항목", exact: true })
        .waitFor();
      await reader.locator(".katex").first().waitFor();
      await reader.locator(".mermaid-diagram svg").waitFor();
      await reader.locator(".ide-reading-scroll").evaluate((element) => {
        element.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: -100,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await reader
        .getByRole("button", { name: "문서 글자 크기 초기화", exact: true })
        .filter({ hasText: "110%" })
        .waitFor();
      assert.equal(
        await reader
          .locator(".remote-markdown")
          .evaluate((element) => getComputedStyle(element).fontSize),
        "17.6px",
      );
      await reader
        .getByRole("button", { name: "문서 목차", exact: true })
        .click();
      await reader
        .getByRole("navigation", { name: "Markdown 목차" })
        .getByRole("button", { name: "계획", exact: true })
        .click();
      assert.ok(
        await reader
          .locator(".ide-reading-scroll")
          .evaluate((element) => element.scrollTop > 0),
      );
      await reader
        .getByRole("link", { name: "다음 문서", exact: true })
        .click();
      await reader
        .getByRole("heading", { name: "연결된 원격 문서", exact: true })
        .waitFor();
      await reader
        .getByText("같은 문서 폴더에서 열었습니다.", { exact: true })
        .waitFor();
      await reader.getByRole("link", { name: "돌아가기", exact: true }).click();
      await reader
        .getByRole("heading", { name: "원격 PC에서 읽는 문서", exact: true })
        .waitFor();
      assert.equal(
        f.gateway.controls.view(f.id)?.clientId,
        readerOwner,
        "Markdown reads, links, outline and zoom preserve the other tab's input lease",
      );
      assert.equal(
        writes.length,
        writesBeforeReading,
        "reading Markdown never injects terminal input",
      );
      assert.equal(await readFile(join(docs, "README.md"), "utf8"), markdown);
      assert.equal(
        requests.some((url) => url.includes("/api/hosts/")),
        false,
        "paired Markdown uses desktop-authorized file routes, never local-only preview routes",
      );
      await page.getByRole("button", { name: "hello.ts", exact: true }).click();
      await page.locator(".monaco-editor").first().waitFor();
      assert.notEqual(f.gateway.controls.view(f.id)?.clientId, firstOwner);
      await page
        .getByRole("button", { name: "여기서 제어", exact: true })
        .click();
      const editor = page.locator(".monaco-editor textarea").first();
      await editor.focus();
      await editor.press("Control+Home");
      await editor.press("Control+A");
      await page.keyboard.insertText("export const value = 2;\n");
      const saved = page.waitForResponse(
        (response) =>
          response.url().includes("/desktop-api/editor/") &&
          response.request().method() === "PUT" &&
          response.status() === 200,
      );
      await page
        .getByRole("button", { name: "파일 저장", exact: true })
        .click();
      await saved;
      await page.getByRole("tab", { name: "hello.ts", exact: true }).waitFor();
      assert.equal(
        await readFile(filename, "utf8"),
        "export const value = 2;\n",
      );
      const beforeQuote = writes.length;
      await page
        .getByLabel("AI 제공자", { exact: true })
        .selectOption("claude");
      await editor.focus();
      await editor.press("Control+A");
      await page.getByRole("button", { name: "인용", exact: true }).click();
      await page.getByLabel("AI에게 보낼 메시지").fill("이 변경을 검토해줘");
      await page
        .getByRole("button", { name: "AI 메시지 전송", exact: true })
        .click();
      await page
        .getByText("선택한 코드를 검토했습니다.", { exact: true })
        .waitFor();
      const quote = writes
        .slice(beforeQuote)
        .map((item) => item.data)
        .join("");
      assert.equal(annotations.length, 0);
      assert.equal(directMessages.length, 1);
      assert.match(directMessages[0], /hello\.ts/);
      assert.match(directMessages[0], /export const value = 2/);
      assert.match(directMessages[0], /이 변경을 검토해줘/);
      assert.equal(
        quote,
        "",
        "IDE chat sends a structured message without writing to any terminal",
      );

      await editor.focus();
      await editor.press("Control+A");
      await page.keyboard.insertText("export const value = 3;\n");
      await page.getByLabel("저장 안 됨", { exact: true }).waitFor();

      await page.getByLabel("IDE 세션", { exact: true }).selectOption(secondId);
      await page.waitForFunction(
        () =>
          document.querySelector(".remote-app > main > header [role=status]")
            ?.textContent === "연결됨",
      );
      assert.equal(f.gateway.controls.view(secondId), null);
      assert.equal(
        f.state.terminals.length,
        2,
        "remote clients never create extra terminal processes",
      );
      await mkdir(resolve(".cache/desktop-review"), { recursive: true });
      await page.screenshot({
        path: resolve(".cache/desktop-review/remote-ide.png"),
      });
      await page
        .getByRole("button", { name: "파일 저장", exact: true })
        .click();
      await page
        .locator(".ide-error")
        .getByText("이 파일을 연 터미널을 다시 선택한 뒤 저장하세요.", {
          exact: true,
        })
        .waitFor();
      assert.equal(
        f.gateway.controls.view(secondId),
        null,
        "saving A's retained tab does not claim B's terminal",
      );
      assert.equal(
        requests.some((url) => url.includes(`/terminals/${secondId}/control`)),
        false,
        "wrong-session save fails before requesting a lease",
      );
      assert.equal(
        await readFile(filename, "utf8"),
        "export const value = 2;\n",
        "wrong-session save never changes the original file",
      );
      await page.getByLabel("저장 안 됨", { exact: true }).waitFor();

      f.state.terminals.forEach((terminal) => {
        terminal.exited = true;
      });
      f.gateway.changed();
      await page.waitForFunction(
        () =>
          document.querySelectorAll('nav[aria-label="열린 세션"] button')
            .length === 0,
      );
      assert.equal(
        await page.locator(".monaco-editor").first().isVisible(),
        true,
        "closing the final terminal does not unmount unsaved editors",
      );
      assert.equal(
        await page.getByLabel("저장 안 됨", { exact: true }).count(),
        1,
      );
      assert.match(
        await page.locator(".monaco-editor .view-lines").first().innerText(),
        /value\s*=\s*3/,
      );
      assert.equal(
        await readFile(filename, "utf8"),
        "export const value = 2;\n",
      );
      await page.screenshot({
        path: resolve(".cache/desktop-review/remote-retained-draft.png"),
      });
      // Starting a new IDE conversation needs a server, not a running CLI.
      const terminalCount = f.state.terminals.length;
      const writesBeforeEmptyHost = writes.length;
      await page.getByLabel("AI 제공자", { exact: true }).selectOption("codex");
      await page
        .getByLabel("IDE 서버", { exact: true })
        .selectOption("empty-host");
      await page.getByText("Codex와 새 대화", { exact: true }).waitFor();
      assert.equal(
        await page.getByLabel("IDE 서버", { exact: true }).inputValue(),
        "empty-host",
      );
      assert.equal(
        await page.getByLabel("IDE 세션", { exact: true }).isDisabled(),
        true,
      );
      const emptyHostComposer = page.getByLabel("AI에게 보낼 메시지", {
        exact: true,
      });
      assert.equal(await emptyHostComposer.isEnabled(), true);
      assert.equal(await emptyHostComposer.inputValue(), "");
      await emptyHostComposer.fill("이 서버에서 새 대화를 준비합니다.");
      assert.equal(
        await page
          .getByRole("button", { name: "AI 메시지 전송", exact: true })
          .isEnabled(),
        true,
      );
      assert.equal(
        f.state.terminals.length,
        terminalCount,
        "selecting a server does not spawn a terminal",
      );
      assert.equal(
        writes.length,
        writesBeforeEmptyHost,
        "drafting without a terminal never injects shell input",
      );
      assert.equal(
        directMessages.length,
        1,
        "a new-server draft does not start an AI until sent",
      );
      await page
        .getByLabel("IDE 서버", { exact: true })
        .selectOption("fixture");
      assert.equal(
        await emptyHostComposer.inputValue(),
        "",
        "drafts remain scoped to their server",
      );
      await page
        .getByLabel("AI 제공자", { exact: true })
        .selectOption("claude");
      await page
        .getByText("선택한 코드를 검토했습니다.", { exact: true })
        .waitFor();
      assert.equal(
        await page.getByLabel("저장 안 됨", { exact: true }).count(),
        1,
        "switching to a server without terminals preserves the original unsaved editor",
      );
      assert.deepEqual(errors, []);
    } catch (error) {
      const page = app && (await app.firstWindow());
      if (page) {
        await mkdir(resolve(".cache/desktop-review"), { recursive: true });
        await page.screenshot({
          path: resolve(".cache/desktop-review/remote-failure.png"),
        });
        await writeFile(
          resolve(".cache/desktop-review/remote-failure.html"),
          await page.content(),
        );
      }
      throw error;
    } finally {
      // This fixture deliberately keeps unsaved documents. Destroy only its
      // isolated windows so Electron's beforeunload prompt cannot block cleanup.
      await app
        ?.evaluate(({ BrowserWindow }) => {
          for (const window of BrowserWindow.getAllWindows()) window.destroy();
        })
        .catch(() => {});
      await app?.close().catch(() => {});
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      await new Promise<void>((r) => {
        proxy.close(() => r());
        proxy.closeAllConnections();
      });
      files.shutdown();
      chats.close();
      second.dispose();
      await f.close();
    }
  },
);
