import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import webpush from "web-push";
import { _electron } from "playwright";
import { mobileFixture, origin } from "../test/mobile-fixture";

test(
  "phone UI pairs, shares output, sends once, retains uncertain draft, reconnects and answers requests",
  { skip: process.platform !== "win32", timeout: 180000 },
  async (t) => {
    const f = await mobileFixture();
    const closedId = crypto.randomUUID();
    f.state.terminals.push({
      ...f.state.terminals[0],
      id: closedId,
      title: "닫힌 세션",
      exited: true,
    });
    f.state.requests.push({
      ...f.state.requests[0],
      id: crypto.randomUUID(),
      terminal: { kind: "terminal", title: "닫힌 세션", terminalId: closedId },
    });
    const blockId = "abcdef0123456789abcd";
    const answer = {
      id: blockId,
      requestId: "fixture-rich",
      sessionId: "native-fixture",
      text:
        "# 모바일 조판 답변\n\n완료된 답변 내용입니다. $x^2$\n\n| 결과 | 값 |\n| --- | --- |\n| 표시 | 정상 |\n\n" +
        Array.from(
          { length: 12 },
          (_, i) =>
            `- **분석 ${i + 1}:** 휴대폰에서는 문장이 여러 줄로 이어져도 답변 전체를 읽을 수 있어야 합니다. 표와 수식 다음의 설명도 잘리지 않아야 합니다.`,
        ).join("\n\n") +
        "\n\n답변 마지막 문장입니다.",
      marker: `~HBR:${blockId}~`,
      renderer: "rows-v2" as const,
      state: "ready" as const,
      columns: 100,
      viewportRows: 30,
      rows: 50,
      createdAt: 2,
    };
    const originalAnswers = f.operations.answers;
    f.operations.answers = (id) => [...(originalAnswers(id) as any[]), answer];
    // Real failure shape: only the last reservation rows survive in the viewport.
    const reservedScreen =
      "\x1b[?1049h\x1b[2J\x1b[H" +
      Array.from(
        { length: 15 },
        (_, row) => `~HBR:${blockId}:${35 + row}~\r\n`,
      ).join("") +
      "\r\nNative completion status\r\n\r\nREADY > ";
    f.screen.append(reservedScreen);
    let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    let loseAck = false;
    let holdAck = false;
    let holdAttachment = false;
    let releaseResponse: (() => void) | undefined;
    const pendingResponses = new Set<() => void>();
    async function heldResponse() {
      for (let attempt = 0; attempt < 500; attempt++) {
        if (releaseResponse) {
          const respond = releaseResponse;
          releaseResponse = undefined;
          return respond;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Expected delayed fixture response");
    }
    const messages: any[] = [];
    // Isolated loopback proxy models Serve's Host/Origin forwarding, never the user's listener.
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
          if (
            (holdAck && req.url === "/mobile-api/input") ||
            (holdAttachment && req.url?.includes("/attachment?"))
          ) {
            holdAck = holdAttachment = false;
            const forward = () => {
              pendingResponses.delete(forward);
              res.writeHead(response.statusCode!, response.headers);
              response.pipe(res);
            };
            pendingResponses.add(forward);
            releaseResponse = forward;
            return;
          }
          if (loseAck && req.url === "/mobile-api/input") {
            loseAck = false;
            response.resume();
            res.writeHead(504, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "입력은 전달됐지만 응답 확인 시간이 초과됐습니다.",
              }),
            );
            return;
          }
          res.writeHead(response.statusCode!, response.headers);
          response.pipe(res);
        },
      );
      upstream.on("error", () => {
        res.statusCode = 502;
        res.end();
      });
      req.pipe(upstream);
    });
    const sockets = new WebSocketServer({ noServer: true });
    let connectionCount = 0;
    proxy.on("upgrade", (req, socket, head) =>
      sockets.handleUpgrade(req, socket, head, (client) => {
        connectionCount++;
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
          messages.push(JSON.parse(String(data)));
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
    const code = new URL(f.access.pairing().url).hash;
    const main = join(f.directory, "electron.cjs");
    await writeFile(
      main,
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(f.directory, "profile"))});app.commandLine.appendSwitch('disable-gpu');app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:390,height:844,webPreferences:{backgroundThrottling:false,nodeIntegration:false,contextIsolation:true,sandbox:true}});w.loadURL('http://127.0.0.1:${port}/mobile/${code}');});app.on('window-all-closed',()=>app.quit());`,
    );
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
      page.on("pageerror", (e) => errors.push(e.message));
      const initialPreview = page.waitForResponse(
        (r) =>
          r.url().includes(`/terminals/${f.id}/preview`) && r.status() === 200,
      );
      await page
        .getByRole("button", { name: "이 기기 연결", exact: true })
        .click();
      const previewResponse = await initialPreview;
      assert.match((await previewResponse.json()).data, /READY/);
      assert.equal(await page.locator(".session.card:visible").count(), 1);
      assert.equal(
        await page.getByRole("button", { name: /닫힌 세션/ }).count(),
        0,
      );
      await page.waitForTimeout(80);
      const initialSnapshot = f.operations.snapshot;
      let releaseInitial!: () => void;
      f.operations.snapshot = async (id) => {
        await new Promise<void>((resolve) => (releaseInitial = resolve));
        return initialSnapshot(id);
      };
      await page.getByRole("button", { name: /테스트 Codex/ }).click();
      await page
        .locator(".mobile-terminal-flow")
        .getByText("Native completion status", { exact: true })
        .waitFor({ timeout: 2000 });
      assert.match(await page.getByRole("status").innerText(), /이전 화면/);
      await page
        .getByLabel("터미널에 보낼 입력")
        .fill("preview must be read-only");
      assert.equal(
        await page
          .getByRole("button", { name: "보내기 ↵", exact: true })
          .isDisabled(),
        true,
      );
      assert.deepEqual(f.writes, []);
      await page.getByLabel("터미널에 보낼 입력").fill("");
      while (!releaseInitial) await page.waitForTimeout(5);
      releaseInitial();
      f.operations.snapshot = initialSnapshot;
      await page.waitForFunction(
        () => document.querySelector("[role=status]")?.textContent === "연결됨",
      );
      assert.equal(
        f.gateway.controls.view(f.id),
        null,
        "viewing and preloading do not claim input",
      );
      const otherClient = crypto.randomUUID();
      f.gateway.controls.change(f.id, "other-device", "다른 PC", {
        action: "claim",
        clientId: otherClient,
      });
      await page
        .getByLabel("세션 입력 제어")
        .getByText(/다른 PC에서 입력 중/)
        .waitFor();
      await page
        .getByLabel("터미널에 보낼 입력")
        .fill("제어권 전환 전에 전송하면 안 됨");
      assert.equal(
        await page
          .getByRole("button", { name: "보내기 ↵", exact: true })
          .isDisabled(),
        true,
      );
      assert.equal(await page.getByLabel("사진·파일 첨부").isDisabled(), true);
      await page.locator(".session-requests > summary").click();
      assert.match(
        await page.locator(".session-requests > summary").innerText(),
        /요청 1개/,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "첫 항목", exact: true })
          .isDisabled(),
        true,
      );
      await page
        .getByRole("button", { name: "여기서 제어", exact: true })
        .click();
      await page
        .getByLabel("세션 입력 제어")
        .getByText("이 기기에서 입력 중", { exact: true })
        .waitFor();
      assert.notEqual(f.gateway.controls.view(f.id)?.clientId, otherClient);
      assert.equal(
        await page
          .getByRole("button", { name: "첫 항목", exact: true })
          .isEnabled(),
        true,
      );
      assert.equal(
        f.writes.length,
        0,
        "taking control never submits the draft",
      );
      await page.locator(".session-requests > summary").click();
      await page.getByLabel("터미널에 보낼 입력").fill("");
      const inline = page.locator(`[data-mobile-rich="${blockId}"]`);
      await inline.locator("table").waitFor();
      await inline.locator(".katex").first().waitFor();
      assert.match(await inline.innerText(), /완료된 답변 내용/);
      assert.equal(
        await page
          .locator(".terminal-scroll")
          .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        true,
        "phone flow has no blank horizontal scrolling area",
      );
      // A phone-width answer can be much taller than its PC reservation. Its
      // final paragraph must precede the native status, without inner clipping.
      assert.equal(
        await page.evaluate(() => {
          const answer = document.querySelector(".mobile-rich-reader")!;
          const screen = document.querySelector(".xterm-screen")!;
          const last = answer.querySelector(".markdown > p:last-child")!;
          const status = [
            ...document.querySelectorAll(".mobile-native-row"),
          ].find((el) => el.textContent?.includes("Native completion status"))!;
          const body = answer.querySelector(".mobile-rich-body")!;
          return (
            answer.getBoundingClientRect().height >
              screen.getBoundingClientRect().height &&
            last.textContent === "답변 마지막 문장입니다." &&
            last.getBoundingClientRect().bottom <=
              status.getBoundingClientRect().top &&
            body.scrollHeight <= body.clientHeight + 1 &&
            !document
              .querySelector(".mobile-terminal-flow")!
              .textContent?.includes("~HBR:")
          );
        }),
        true,
      );
      await mkdir(resolve(".cache/mobile-review"), { recursive: true });
      await page.screenshot({
        path: resolve(".cache/mobile-review/phone-inline-answer.png"),
      });
      await page.getByLabel("글자 크기 설정", { exact: true }).click();
      await page
        .getByRole("button", { name: "글자 크게", exact: true })
        .click();
      await page.waitForFunction(() => {
        const r = document
          .querySelector(".mobile-rich-reader")!
          .getBoundingClientRect();
        const s = document
          .querySelector(".xterm-screen")!
          .getBoundingClientRect();
        return r.height > s.height;
      });
      await page.getByLabel("글자 크기 설정 닫기").click();
      // Reconnect while reading the expanded answer must not jump to its end.
      const flowScroll = page.locator(".terminal-scroll");
      await flowScroll.evaluate((el) => {
        el.scrollTop = 300;
      });
      await page
        .getByRole("button", { name: "맨 아래로", exact: true })
        .waitFor();
      for (const socket of sockets.clients) socket.terminate();
      await page.waitForFunction(
        () => document.querySelector("[role=status]")?.textContent === "연결됨",
      );
      await inline.locator("table").waitFor();
      assert.ok(
        Math.abs((await flowScroll.evaluate((el) => el.scrollTop)) - 300) < 2,
        "rich answer reading position survives reconnect",
      );
      await page.getByLabel("최신 내용으로 이동").click();
      await page.getByLabel("터미널에 보낼 입력").fill("모바일 테스트");
      await page.getByRole("button", { name: "보내기 ↵", exact: true }).click();
      await page.waitForFunction(
        () =>
          !(
            document.querySelector(
              'textarea[aria-label="터미널에 보낼 입력"]',
            ) as HTMLTextAreaElement
          ).value,
      );
      assert.deepEqual(f.writes, ["\x1b[200~모바일 테스트\x1b[201~", "\r"]);
      await page.getByLabel("터미널에 보낼 입력").fill("전송 확인용");
      loseAck = true;
      await page.getByRole("button", { name: "보내기 ↵", exact: true }).click();
      await page
        .getByRole("alert")
        .filter({ hasText: "자동으로 재전송하지 않습니다" })
        .waitFor();
      assert.equal(f.writes.length, 4);
      assert.equal(
        await page.getByLabel("터미널에 보낼 입력").inputValue(),
        "전송 확인용",
      );
      for (const socket of sockets.clients) socket.terminate();
      await page.waitForFunction(
        () => document.querySelector("[role=status]")?.textContent === "연결됨",
      );
      assert.equal(f.writes.length, 4);
      // One terminal view owns native output, rich answers and older history.
      assert.equal(
        await page.getByRole("navigation").getByRole("button").count(),
        3,
      );
      assert.equal(
        await page.getByRole("button", { name: "대화", exact: true }).count(),
        0,
      );
      assert.equal(
        await page.getByRole("button", { name: /받은함|연구실/ }).count(),
        0,
      );
      assert.equal(await page.locator(".answers").count(), 0);
      await page
        .locator(".mobile-rich-reader .markdown table")
        .first()
        .waitFor();
      await page.locator(".katex").first().waitFor();
      await page.getByLabel("최신 내용으로 이동").click();
      await page
        .getByRole("button", { name: "안내 닫기", exact: true })
        .click();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      assert.equal(overflow, false);
      await mkdir(resolve(".cache/mobile-review"), { recursive: true });
      await page.screenshot({
        path: resolve(".cache/mobile-review/phone-answer.png"),
      });
      await page.locator(".session-requests > summary").click();
      assert.equal(await page.locator(".terminal-scroll").isVisible(), true);
      await page.getByRole("button", { name: "첫 항목", exact: true }).click();
      await page.locator(".session-requests").waitFor({ state: "detached" });
      assert.equal(f.state.requests[0].answer?.optionId, "first");
      await page
        .getByRole("navigation")
        .getByRole("button", { name: "터미널", exact: true })
        .click();
      await page.locator("input[type=file]").setInputFiles({
        name: "sample.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("fixture attachment"),
      });
      await page.waitForFunction(() =>
        (
          document.querySelector(
            'textarea[aria-label="터미널에 보낼 입력"]',
          ) as HTMLTextAreaElement
        ).value.includes("/fixture/.codex/harbor/attachments/"),
      );
      assert.equal(f.upload()?.toString(), "fixture attachment");
      assert.equal(f.writes.length, 4);
      // Repaint with split reservations and unrelated native output between/beside them.
      // Requests and attachments have kept the same terminal visible throughout.
      const repaint =
        "\x1b[2J\x1b[H" +
        `~HBR:${blockId}:40~\r\n~HBR:${blockId}:41~\r\nNATIVE GAP\r\n` +
        `~HBR:${blockId}:42~\r\n~HBR:${blockId}:43~    NATIVE SUFFIX\r\nREADY > `;
      f.screen.append(repaint);
      f.gateway.output(f.id, repaint);
      await page.waitForFunction(() =>
        document
          .querySelector(".mobile-terminal-flow")
          ?.textContent?.includes("NATIVE SUFFIX"),
      );
      assert.equal(
        await inline.count(),
        1,
        "split reservations show the full answer once",
      );
      assert.equal(
        await page.evaluate(() => {
          const answer = document.querySelector(".mobile-rich-reader")!;
          const gap = [...document.querySelectorAll(".mobile-native-row")].find(
            (el) => el.textContent?.includes("NATIVE GAP"),
          )!;
          const suffix = [
            ...document.querySelectorAll(".mobile-native-row"),
          ].find((el) => el.textContent?.includes("NATIVE SUFFIX"))!;
          return (
            answer.getBoundingClientRect().bottom <=
              gap.getBoundingClientRect().top + 1 &&
            gap.getBoundingClientRect().bottom <=
              suffix.getBoundingClientRect().top + 1 &&
            !document
              .querySelector(".mobile-terminal-flow")!
              .textContent?.includes("~HBR:")
          );
        }),
        true,
      );
      // A full native screen is taller than a phone. There must be one scroll
      // surface over both this screen and the native scrollback, initially latest.
      const richHistory =
        "\x1bc\x1b[?2004h" +
        Array.from({ length: 500 }, (_, i) => `OLDER ${i + 1}\r\n`).join("") +
        `~HBR:${blockId}:48~\r\n~HBR:${blockId}:49~\r\nRICH LATEST > `;
      f.screen.append(richHistory);
      f.gateway.output(f.id, richHistory);
      await page.locator(".mobile-history-more").waitFor();
      const firstRow = await page
        .locator(".mobile-native-row")
        .first()
        .getAttribute("data-native-row");
      const anchor = page.locator(
        `.mobile-native-row[data-native-row="${firstRow}"]`,
      );
      const beforeMore = await anchor.evaluate((el) => {
        el.closest(".terminal-scroll")!.scrollTop = 0;
        return el.getBoundingClientRect().top;
      });
      await page.waitForFunction(
        () => !document.querySelector(".mobile-history-more"),
      );
      assert.ok(
        Math.abs(
          (await anchor.evaluate((el) => el.getBoundingClientRect().top)) -
            beforeMore,
        ) < 2,
        "loading older output preserves the reading anchor",
      );
      const richTop = await flowScroll.evaluate((el) => el.scrollTop);
      const richMore = "\r\nNEW LIVE NATIVE\r\nRICH LATEST > ";
      f.screen.append(richMore);
      f.gateway.output(f.id, richMore);
      await page
        .getByRole("button", { name: "새 출력 · 맨 아래로", exact: true })
        .waitFor();
      assert.equal(
        await flowScroll
          .locator(".mobile-terminal-flow")
          .getByText("NEW LIVE NATIVE", { exact: true })
          .count(),
        0,
        "live output cannot overwrite the screen being read",
      );
      assert.ok(
        Math.abs((await flowScroll.evaluate((el) => el.scrollTop)) - richTop) <
          2,
      );
      await page.getByLabel("최신 내용으로 이동").click();
      await flowScroll
        .locator(".mobile-terminal-flow")
        .getByText("NEW LIVE NATIVE", { exact: true })
        .waitFor();
      const history =
        "\x1bc\x1b[?2004h" +
        Array.from({ length: 100 }, (_, i) => `HISTORY ${i + 1}\r\n`).join("") +
        "LATEST PROMPT > ";
      f.screen.append(history);
      f.gateway.output(f.id, history);
      await page.waitForFunction(() => {
        const el = document.querySelector(".terminal-scroll")!;
        return (
          el.scrollHeight > 1200 &&
          el.scrollHeight - el.scrollTop - el.clientHeight < 25
        );
      });
      const scroll = page.locator(".terminal-scroll");
      await scroll.hover();
      await page.mouse.wheel(0, -450);
      await page
        .getByRole("button", { name: "맨 아래로", exact: true })
        .waitFor();
      const readingTop = await scroll.evaluate((el) => el.scrollTop);
      const more = "\r\nLIVE UPDATE\r\nLATEST PROMPT > ";
      f.screen.append(more);
      f.gateway.output(f.id, more);
      await page
        .getByRole("button", { name: "새 출력 · 맨 아래로", exact: true })
        .waitFor();
      assert.ok(
        Math.abs((await scroll.evaluate((el) => el.scrollTop)) - readingTop) <
          2,
      );
      for (const socket of sockets.clients) socket.terminate();
      await page.waitForFunction(
        () => document.querySelector("[role=status]")?.textContent === "연결됨",
      );
      assert.ok(
        Math.abs((await scroll.evaluate((el) => el.scrollTop)) - readingTop) <
          2,
        "reconnect preserves reading position",
      );
      await page.getByLabel("최신 내용으로 이동").click();
      await page.waitForFunction(() => {
        const el = document.querySelector(".terminal-scroll")!;
        return el.scrollHeight - el.scrollTop - el.clientHeight < 25;
      });
      await page.screenshot({
        path: resolve(".cache/mobile-review/phone-terminal-ux.png"),
      });
      // Saved questions/answers are reachable in the terminal's own scroller,
      // even when an alternate-screen CLI has no native scrollback remaining.
      await scroll.evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.locator(".terminal-history .message-user").first().waitFor();
      for (let i = 0; i < 5; i++) {
        if (
          await page
            .locator('.terminal-history [data-message-key="user::question-1"]')
            .count()
        )
          break;
        const count = await page
          .locator(".terminal-history [data-message-key]")
          .count();
        await scroll.evaluate((el) => {
          el.scrollTop = 0;
        });
        await page.waitForFunction(
          (previous) =>
            document.querySelectorAll(".terminal-history [data-message-key]")
              .length > previous,
          count,
        );
      }
      await page
        .locator('.terminal-history [data-message-key="user::question-1"]')
        .waitFor();
      assert.equal(await page.locator(".answers").count(), 0);
      assert.equal(
        await page.locator(".terminal-history .message-user").count(),
        10,
      );
      assert.equal(
        await page.locator(".terminal-history .message-assistant").count(),
        10,
      );
      const frozenHistoryReader = f.operations.conversation!;
      let liveHistoryReads = 0;
      f.operations.conversation = async (...args) => {
        if (!args[2]) liveHistoryReads++;
        return frozenHistoryReader(...args);
      };
      const historyPosition = await scroll.evaluate((el) => el.scrollTop);
      await page.waitForTimeout(10500);
      assert.equal(
        liveHistoryReads,
        0,
        "terminal history does not poll and append below a frozen reader",
      );
      assert.ok(
        Math.abs(
          (await scroll.evaluate((el) => el.scrollTop)) - historyPosition,
        ) < 2,
      );
      await page.getByLabel("최신 내용으로 이동").click();

      // No rich markers at all: live code, diff and long paths must use the same
      // phone-width flow. Full-screen redraws must not steal an upward gesture.
      const workingFrame = (frame: number) =>
        "\x1b[?1049h\x1b[?2026h\x1b[2J\x1b[H" +
        Array.from(
          { length: 20 },
          (_, row) =>
            `\x1b[32m+ FRAME ${frame} line ${row}:\x1b[0m const result = buildPipeline('/workspace/project/src/compiler/long_file.ts');\r\n`,
        ).join("") +
        "─".repeat(98) +
        "\r\n› Working on code …\x1b[?2026l";
      const emit = (text: string) => {
        f.screen.append(text);
        f.gateway.output(f.id, text);
      };
      emit(workingFrame(0));
      await scroll
        .locator(".mobile-terminal-flow")
        .getByText("› Working on code …", { exact: true })
        .waitFor();
      await page.waitForFunction(() => {
        const el = document.querySelector(".terminal-scroll")!;
        return el.scrollHeight - el.scrollTop - el.clientHeight < 25;
      });
      assert.equal(
        await scroll.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        true,
        "working code has no PC-width horizontal overflow",
      );
      const separator = scroll.locator(".mobile-native-separator").last();
      assert.ok(
        await separator.evaluate(
          (el) => el.getBoundingClientRect().height < 35,
        ),
        "a terminal border occupies exactly one native row",
      );
      assert.equal(await separator.innerText(), "");
      const codeRow = scroll
        .locator(".mobile-native-row")
        .filter({ hasText: "FRAME 0 line 18:" });
      assert.ok(
        await codeRow.evaluate((el) => el.getBoundingClientRect().height > 35),
        "long code wraps into readable phone lines",
      );
      await page.screenshot({
        path: resolve(".cache/mobile-review/phone-working-code.png"),
      });
      let frame = 0;
      const updates = setInterval(() => emit(workingFrame(++frame)), 70);
      try {
        await scroll.hover();
        await page.mouse.wheel(0, -420);
        await page
          .getByRole("button", { name: "새 출력 · 맨 아래로", exact: true })
          .waitFor();
        await page.waitForTimeout(250);
        const frozenText = await scroll
          .locator(".mobile-native-row")
          .allTextContents();
        const frozenTop = await scroll.evaluate((el) => el.scrollTop);
        assert.ok(
          await scroll.evaluate(
            (el) => el.scrollHeight - el.clientHeight - el.scrollTop > 300,
          ),
          "the upward gesture actually scrolls while code keeps redrawing",
        );
        await page.waitForTimeout(550);
        assert.deepEqual(
          await scroll.locator(".mobile-native-row").allTextContents(),
          frozenText,
        );
        assert.ok(
          Math.abs((await scroll.evaluate((el) => el.scrollTop)) - frozenTop) <
            2,
        );
        // A second upward gesture can continue reading the preserved frame.
        await page.mouse.wheel(0, -240);
        await page.waitForTimeout(250);
        assert.ok(
          (await scroll.evaluate((el) => el.scrollTop)) < frozenTop - 150,
          `second wheel: before=${frozenTop}, after=${await scroll.evaluate((el) => el.scrollTop)}`,
        );
      } finally {
        clearInterval(updates);
      }
      await page.getByLabel("최신 내용으로 이동").click();
      await page.waitForFunction(
        (expected) =>
          document
            .querySelector(".mobile-terminal-flow")
            ?.textContent?.includes(`FRAME ${expected} line`),
        frame,
      );
      // Exercise a real touch drag as well as wheel scrolling: the iPhone path
      // must move the browser scroller while the CLI continuously redraws.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
      const bounds = await scroll.boundingBox();
      assert.ok(bounds);
      const startTop = await scroll.evaluate((el) => el.scrollTop);
      const touchUpdates = setInterval(() => emit(workingFrame(++frame)), 70);
      try {
        const x = bounds.x + bounds.width / 2,
          y = bounds.y + 45;
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y }],
        });
        for (let i = 1; i <= 8; i++) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x, y: y + i * 24 }],
          });
          await page.waitForTimeout(30);
        }
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        await page
          .getByRole("button", { name: "새 출력 · 맨 아래로", exact: true })
          .waitFor();
        await page.waitForTimeout(300);
        assert.ok(
          (await scroll.evaluate((el) => el.scrollTop)) < startTop - 100,
          "touch dragging scrolls the working terminal upward",
        );
      } finally {
        clearInterval(touchUpdates);
        await cdp.send("Emulation.setTouchEmulationEnabled", {
          enabled: false,
        });
        await cdp.detach();
      }
      await page.getByLabel("최신 내용으로 이동").click();
      await page.waitForFunction(
        (expected) =>
          document
            .querySelector(".mobile-terminal-flow")
            ?.textContent?.includes(`FRAME ${expected} line`),
        frame,
      );
      // Never display the temporary cleared frame inside a synchronized repaint.
      emit("\x1b[?2026h\x1b[2J\x1b[HINCOMPLETE FRAME");
      await page.waitForTimeout(150);
      assert.equal(
        await scroll
          .locator(".mobile-terminal-flow")
          .getByText("INCOMPLETE FRAME", { exact: true })
          .count(),
        0,
      );
      emit("\x1b[2J\x1b[HCOMPLETE FRAME\x1b[?2026l");
      await scroll
        .locator(".mobile-terminal-flow")
        .getByText("COMPLETE FRAME", { exact: true })
        .waitFor();
      emit(history);
      await scroll
        .locator(".mobile-terminal-flow")
        .getByText("LATEST PROMPT >", { exact: true })
        .waitFor();
      // Changing sessions keeps independent drafts and refresh returns to the
      // selected session at its latest output, without sending the saved draft.
      await page.getByLabel("세션 목록", { exact: true }).click();
      await page.getByRole("button", { name: /테스트 Codex/ }).click();
      await page
        .getByLabel("터미널에 보낼 입력")
        .fill("same-session readiness");
      assert.equal(
        await page
          .getByRole("button", { name: "보내기 ↵", exact: true })
          .isEnabled(),
        true,
      );
      await page.getByLabel("터미널에 보낼 입력").fill("");
      const secondId = "22222222-2222-4222-8222-222222222222";
      f.state.terminals.push({
        ...f.state.terminals[0],
        id: secondId,
        title: "두 번째 세션",
        agentSessionId: "second-native",
      });
      f.gateway.changed();
      const connectionsBeforeSwitch = connectionCount;
      await page.getByLabel("터미널에 보낼 입력").fill("첫 세션 초안");
      await page.getByLabel("세션 전환").selectOption(secondId);
      await page.waitForFunction(
        () => document.querySelector("[role=status]")?.textContent === "연결됨",
      );
      assert.equal(
        await page.getByLabel("터미널에 보낼 입력").inputValue(),
        "",
      );
      await page.getByLabel("터미널에 보낼 입력").fill("둘째 세션 초안");
      const liveSnapshot = f.operations.snapshot;
      let releaseLatest!: () => void;
      f.operations.snapshot = async (id) => {
        const snapshot = await liveSnapshot(id);
        await new Promise<void>((resolve) => (releaseLatest = resolve));
        return snapshot;
      };
      await page.getByLabel("세션 전환").selectOption(f.id);
      await scroll
        .locator(".mobile-terminal-flow")
        .getByText("LATEST PROMPT >", { exact: true })
        .waitFor({ timeout: 2000 });
      assert.match(await page.getByRole("status").innerText(), /이전 화면/);
      assert.equal(
        await page
          .getByRole("button", { name: "보내기 ↵", exact: true })
          .isDisabled(),
        true,
      );
      assert.equal(
        connectionCount,
        connectionsBeforeSwitch,
        "session switching must reuse the open transport",
      );
      while (!releaseLatest)
        await new Promise((resolve) => setTimeout(resolve, 5));
      releaseLatest();
      f.operations.snapshot = liveSnapshot;
      await page.waitForFunction(
        () => document.querySelector("[role=status]")?.textContent === "연결됨",
      );
      assert.equal(
        await page.getByLabel("터미널에 보낼 입력").inputValue(),
        "첫 세션 초안",
      );
      await page.reload();
      await page.waitForFunction(
        () => document.querySelector("[role=status]")?.textContent === "연결됨",
      );
      assert.equal(await page.getByLabel("세션 전환").inputValue(), f.id);
      await page.waitForFunction(() => {
        const el = document.querySelector(".terminal-scroll")!;
        return (
          el.scrollHeight > 1200 &&
          el.scrollHeight - el.scrollTop - el.clientHeight < 25
        );
      });
      assert.equal(f.writes.length, 4);
      // Model the iOS visual viewport shrinking around an open software keyboard.
      await page
        .getByLabel("터미널에 보낼 입력")
        .fill("키보드 테스트\n둘째 줄");
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport!, "height", {
          configurable: true,
          value: 400,
        });
        window.visualViewport!.dispatchEvent(new Event("resize"));
      });
      await page.locator(".keyboard-open").waitFor();
      assert.equal(await page.getByRole("navigation").isVisible(), false);
      assert.equal(
        await page
          .getByLabel("보내기 ↵")
          .evaluate((el) => el.getBoundingClientRect().bottom <= 400),
        true,
      );
      assert.equal(
        await page.getByLabel("터미널에 보낼 입력").inputValue(),
        "키보드 테스트\n둘째 줄",
      );
      await page.screenshot({
        path: resolve(".cache/mobile-review/phone-keyboard-ux.png"),
      });
      await page.evaluate(() => {
        delete (window.visualViewport as any).height;
        window.visualViewport!.dispatchEvent(new Event("resize"));
      });
      await page.getByLabel("세션 목록", { exact: true }).click();
      await page.getByLabel("세션 검색").fill("두 번째");
      assert.equal(await page.locator(".session.card:visible").count(), 1);
      await page.getByLabel("검색 지우기").click();
      await page.screenshot({
        path: resolve(".cache/mobile-review/phone-sessions-ux.png"),
      });
      // Older running backends keep inline answer rendering and explicitly say
      // that paired question history requires the new backend, without guessing.
      f.operations.conversation = undefined;
      await page
        .getByRole("navigation")
        .getByRole("button", { name: "터미널", exact: true })
        .click();
      await page.getByLabel("최신 내용으로 이동").click();
      await scroll.evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.getByText(/질문이 포함된 대화 기록은 PC Harbor/).waitFor();
      await page.locator(".terminal-history .markdown table").first().waitFor();
      // The OS permission/push service is mocked; enrollment, device API, UI and
      // unsubscribe are real. This is not a claim of iPhone delivery testing.
      const pushes: any[] = [];
      t.mock.method(webpush, "sendNotification", async (_s: any, data: any) => {
        pushes.push(JSON.parse(data));
        return { statusCode: 201, body: "", headers: {} };
      });
      await page.evaluate(`(() => {
        let subscription = null;
        const manager = {
          getSubscription: async () => subscription,
          subscribe: async () =>
            (subscription = {
              options: {},
              toJSON: () => ({
                endpoint: "https://web.push.apple.com/browser-fixture",
                keys: { p256dh: "a".repeat(87), auth: "a".repeat(22) },
              }),
              unsubscribe: async () => {
                subscription = null;
                return true;
              },
            }),
        };
        const permission = {
          permission: "default",
          requestPermission: async () => {
            permission.permission = "granted";
            return "granted";
          },
        };
        Object.defineProperty(window, "Notification", {
          configurable: true,
          value: permission,
        });
        Object.defineProperty(window, "PushManager", {
          configurable: true,
          value: function () {},
        });
        Object.defineProperty(navigator.serviceWorker, "ready", {
          configurable: true,
          value: Promise.resolve({ pushManager: manager }),
        });
        Object.defineProperty(navigator.serviceWorker, "getRegistration", {
          configurable: true,
          value: async () => ({ pushManager: manager }),
        });
      })()`);
      await page
        .getByRole("navigation")
        .getByRole("button", { name: "설정", exact: true })
        .click();
      const notificationSettings = page.getByLabel("모바일 알림 설정");
      await notificationSettings
        .getByText("알림: 꺼짐", { exact: true })
        .waitFor();
      await notificationSettings
        .getByRole("button", { name: "답변 완료 알림 켜기", exact: true })
        .click();
      await notificationSettings
        .getByText("알림: 켜짐", { exact: true })
        .waitFor();
      await notificationSettings
        .getByRole("button", { name: "테스트 알림 보내기", exact: true })
        .click();
      await notificationSettings
        .getByText(/푸시 서비스에 테스트 알림/)
        .waitFor();
      assert.equal(pushes.length, 1);
      assert.equal(f.access.view().devices[0].notifications, true);
      await page.screenshot({
        path: resolve(".cache/mobile-review/phone-notifications.png"),
      });
      await notificationSettings
        .getByRole("button", { name: "알림 끄기", exact: true })
        .click();
      await notificationSettings
        .getByText("알림: 꺼짐", { exact: true })
        .waitFor();
      assert.equal(f.access.view().devices[0].notifications, false);
      await page.evaluate(
        (id) =>
          navigator.serviceWorker.dispatchEvent(
            new MessageEvent("message", {
              data: {
                type: "harbor-open",
                url: `${location.origin}/mobile/?terminal=${id}`,
              },
            }),
          ),
        secondId,
      );
      await page.waitForFunction(
        (id) =>
          (
            document.querySelector(
              '[aria-label="세션 전환"]',
            ) as HTMLSelectElement
          )?.value === id,
        secondId,
      );
      assert.equal(
        (await page.locator(".terminal-workspace").count()) > 0 ||
          (await page.locator(".terminal-scroll").isVisible()),
        true,
      );
      // Notifications received during a delayed send/upload switch sessions
      // after the receipt without carrying the old composer into that session.
      const composer = page.getByLabel("터미널에 보낼 입력");
      const waitReady = () =>
        page.waitForFunction(
          () =>
            document.querySelector("[role=status]")?.textContent === "연결됨",
        );
      const openNotification = (id: string) =>
        page.evaluate(
          (terminalId) =>
            navigator.serviceWorker.dispatchEvent(
              new MessageEvent("message", {
                data: {
                  type: "harbor-open",
                  url: `${location.origin}/mobile/?terminal=${terminalId}`,
                },
              }),
            ),
          id,
        );
      await waitReady();
      await composer.fill("둘째 세션에서 계속 쓸 초안");
      await page.getByLabel("세션 전환").selectOption(f.id);
      await waitReady();
      await composer.fill("첫 세션에 한 번만 전송");
      holdAck = true;
      await page.getByRole("button", { name: "보내기 ↵", exact: true }).click();
      const releaseInput = await heldResponse();
      await openNotification(secondId);
      assert.equal(await page.getByLabel("세션 전환").inputValue(), f.id);
      releaseInput();
      await page.waitForFunction(
        (id) =>
          (
            document.querySelector(
              '[aria-label="세션 전환"]',
            ) as HTMLSelectElement
          ).value === id,
        secondId,
      );
      await page.waitForFunction(
        () =>
          !(
            document.querySelector(
              'textarea[aria-label="터미널에 보낼 입력"]',
            ) as HTMLTextAreaElement
          ).readOnly,
      );
      assert.equal(await composer.inputValue(), "둘째 세션에서 계속 쓸 초안");
      await page.getByLabel("세션 전환").selectOption(f.id);
      await waitReady();
      assert.equal(await composer.inputValue(), "");

      holdAttachment = true;
      await page.locator('.file-button input[type="file"]').setInputFiles({
        name: "handoff.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("isolated fixture"),
      });
      const releaseUpload = await heldResponse();
      await openNotification(secondId);
      assert.equal(await page.getByLabel("세션 전환").inputValue(), f.id);
      releaseUpload();
      await page.waitForFunction(
        (id) =>
          (
            document.querySelector(
              '[aria-label="세션 전환"]',
            ) as HTMLSelectElement
          ).value === id,
        secondId,
      );
      await page.waitForFunction(
        () =>
          !(
            document.querySelector(
              'textarea[aria-label="터미널에 보낼 입력"]',
            ) as HTMLTextAreaElement
          ).readOnly,
      );
      assert.equal(await composer.inputValue(), "둘째 세션에서 계속 쓸 초안");
      await page.getByLabel("세션 전환").selectOption(f.id);
      await waitReady();
      assert.match(await composer.inputValue(), /handoff\.txt/);

      const writesBeforeRestore = [...f.writes];
      const beforeRestore = connectionCount;
      const restoredSocket = page.waitForEvent("websocket");
      await page.evaluate(() =>
        window.dispatchEvent(
          new PageTransitionEvent("pageshow", { persisted: true }),
        ),
      );
      await restoredSocket;
      await waitReady();
      assert.equal(
        connectionCount,
        beforeRestore + 1,
        "cached iOS page obtains a fresh live snapshot",
      );
      assert.deepEqual(
        f.writes,
        writesBeforeRestore,
        "foreground restoration never replays input",
      );
      await page.evaluate(() => {
        Object.defineProperty(navigator, "onLine", {
          configurable: true,
          value: false,
        });
        window.dispatchEvent(new Event("offline"));
      });
      await page
        .getByRole("status")
        .filter({ hasText: "네트워크 연결 대기 중" })
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "보내기 ↵", exact: true })
          .isDisabled(),
        true,
      );
      await page.evaluate(() => {
        Object.defineProperty(navigator, "onLine", {
          configurable: true,
          value: true,
        });
        window.dispatchEvent(new Event("online"));
      });
      await waitReady();
      assert.deepEqual(
        f.writes,
        writesBeforeRestore,
        "network restoration never resends the attachment draft",
      );
      await composer.fill("새 대화가 덮어쓰면 안 되는 초안");
      holdAttachment = true;
      await page.locator('.file-button input[type="file"]').setInputFiles({
        name: "old-session.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("old native fixture"),
      });
      const oldNativeUpload = await heldResponse();
      const subscriptionsBeforeChange = messages.length;
      f.state.terminals[0].agentSessionId = "replacement-native";
      f.gateway.changed();
      for (
        let attempt = 0;
        attempt < 500 && messages.length === subscriptionsBeforeChange;
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(
        messages.length > subscriptionsBeforeChange,
        "native change resubscribes before applying upload result",
      );
      oldNativeUpload();
      await page
        .getByRole("alert")
        .filter({ hasText: "첨부 중 대화가 변경" })
        .waitFor();
      assert.equal(
        await composer.inputValue(),
        "새 대화가 덮어쓰면 안 되는 초안",
      );
      // Live updates / reconnect are presentation-only: no layout ACK, resize,
      // marker rewriting or extra input was sent to the shared terminal.
      assert.ok(messages.length >= 2);
      assert.ok(messages.every((m) => m.type === "subscribe"));
      assert.equal((await f.screen.snapshot()).replay.cols, 100);
      assert.deepEqual(errors, []);
    } catch (error) {
      const page = app && (await app.firstWindow());
      if (page) {
        await mkdir(resolve(".cache/mobile-review"), { recursive: true });
        await page.screenshot({
          path: resolve(".cache/mobile-review/phone-failure.png"),
        });
        await writeFile(
          resolve(".cache/mobile-review/phone-failure.html"),
          await page.content(),
        );
      }
      throw error;
    } finally {
      for (const respond of pendingResponses) respond();
      await app?.close();
      for (const s of sockets.clients) s.terminate();
      sockets.close();
      await new Promise<void>((r) => {
        proxy.close(() => r());
        proxy.closeAllConnections();
      });
      await f.close();
    }
  },
);
