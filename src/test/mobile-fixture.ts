import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { createServer } from "node:net";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { MobileAccess } from "../server/mobile-access";
import { MobileGateway, type MobileOperations } from "../server/mobile-gateway";
import { TerminalScreen } from "../server/terminal-screen";
import type { MobileState } from "../shared/mobile";
export const origin = "https://fixture.example.ts.net";
export async function mobileFixture() {
  const root = resolve(".cache/mobile-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "run-"));
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const access = new MobileAccess(directory);
  access.configure(true, origin, port);
  const id = randomUUID(),
    requestId = randomUUID();
  const state: MobileState = {
    runtimeId: randomUUID(),
    hosts: [{ id: "fixture", name: "테스트 서버", kind: "local" }],
    terminals: [
      {
        id,
        hostId: "fixture",
        title: "테스트 Codex",
        cwd: "/fixture",
        exited: false,
        connectionState: "connected",
        agentState: "idle",
        agentKind: "codex",
        agentSessionId: "native-fixture",
      },
    ],
    requests: [
      {
        id: requestId,
        kind: "question",
        terminal: { kind: "terminal", title: "테스트 Codex", terminalId: id },
        title: "검토 방향",
        question: "어느 항목을 먼저 확인할까요?",
        options: [{ id: "first", label: "첫 항목" }],
        status: "pending",
        createdAt: Date.now(),
      },
    ],
    labs: [],
  };
  const screen = new TerminalScreen();
  screen.resize(100, 30);
  screen.append("\x1b[?2004hHarbor mobile fixture\r\nREADY > ");
  const writes: string[] = [];
  let upload: Buffer | undefined;
  const operations: MobileOperations = {
    state: () => state,
    snapshot: () => screen.snapshot(),
    write: (terminalId, data) => {
      if (terminalId !== id) throw new Error("wrong terminal");
      writes.push(data);
    },
    answer: (rid, answer) => {
      if (rid !== requestId) throw new Error("wrong request");
      state.requests[0].status = "answered";
      state.requests[0].answer = answer;
      gateway.changed();
      return { ok: true };
    },
    answers: () => [
      {
        id: "answer",
        requestId: "answer",
        sessionId: "native-fixture",
        text: "# 완료 답변\n\n수식 $x^2$\n\n| 결과 | 값 |\n| --- | --- |\n| 검증 | 통과 |",
        createdAt: 1,
        state: "ready",
      },
    ],
    conversation: async (terminalId, sessionId, cursor) => {
      if (terminalId !== id || sessionId !== "native-fixture")
        throw new Error("wrong conversation");
      const all = Array.from({ length: 10 }, (_, i) => [
        {
          id: `question-${i + 1}`,
          kind: "user" as const,
          text: `질문 ${i + 1}: 어떤 결과인지 자세히 알려주세요.\n질문의 두 번째 줄입니다.`,
        },
        {
          id: `reply-${i + 1}`,
          kind: "assistant" as const,
          text:
            i === 9
              ? (operations.answers(id) as any[]).at(-1).text
              : `답변 ${i + 1}: 측정 결과와 근거를 설명합니다.\n\n이전 문맥도 빠짐없이 확인할 수 있습니다.`,
        },
      ]).flat();
      const end = all.length - Number(cursor || 0),
        start = Math.max(0, end - 6);
      return {
        sessionId,
        provider: "codex",
        items: all.slice(start, end),
        nextCursor: start > 0 ? String(all.length - start) : null,
      };
    },
    upload: async (_id, name, input) => {
      const chunks: Buffer[] = [];
      for await (const chunk of input) chunks.push(Buffer.from(chunk));
      upload = Buffer.concat(chunks);
      return { path: "/fixture/.codex/harbor/attachments/" + name };
    },
  };
  const gateway = new MobileGateway(access, operations);
  await gateway.start();
  const url = `http://127.0.0.1:${port}`;
  async function http(
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    method = body === undefined ? "GET" : "POST",
  ) {
    return new Promise<Response>((ok, fail) => {
      const req = request(
        url + path,
        {
          method,
          agent: false,
          headers: {
            host: new URL(origin).host,
            origin,
            "x-harbor-mobile": "1",
            ...(body !== undefined
              ? { "content-type": "application/json" }
              : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const resultHeaders = new Headers();
            for (const [key, value] of Object.entries(res.headers))
              if (value)
                resultHeaders.set(
                  key,
                  Array.isArray(value) ? value.join(";") : value,
                );
            ok(
              new Response(
                [204, 205, 304].includes(res.statusCode!)
                  ? null
                  : Buffer.concat(chunks),
                {
                  status: res.statusCode,
                  headers: resultHeaders,
                },
              ),
            );
          });
          res.on("error", fail);
        },
      );
      req.on("error", fail);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function pair() {
    const invite = access.pairing();
    const code = new URLSearchParams(new URL(invite.url).hash.slice(1)).get(
      "pair",
    );
    const response = await http("/mobile-api/pair", {
      code,
      name: "Fixture phone",
    });
    if (response.status !== 200) throw new Error(await response.text());
    return response.headers.get("set-cookie")!.split(";")[0];
  }
  return {
    gateway,
    access,
    state,
    screen,
    writes,
    id,
    requestId,
    operations,
    url,
    http,
    pair,
    upload: () => upload,
    directory,
    async close() {
      await gateway.stop();
      screen.dispose();
      const rel = relative(root, directory);
      if (!rel || rel.startsWith(".."))
        throw new Error("Unsafe fixture directory");
      await rm(directory, { recursive: true, force: true });
    },
  };
}
