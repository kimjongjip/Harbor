import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { Request, Response } from "express";
import { z } from "zod";
import { installedClaudeExecutable } from "./ide-chat-claude.js";
import { passwordConnection } from "./ssh-connect.js";
import { remoteCodexCommand } from "./ssh.js";
import { askAntigravitySide } from "./side-antigravity.js";
import type { HostConfig, TerminalInfo } from "../shared/types.js";
import type { HistoryDetail } from "../shared/history.js";
import {
  sideBinding,
  type SideBinding,
  type SideReply,
} from "../shared/side-question.js";

export const sideInput = z
  .object({
    binding: z.object({
      hostId: z.string(),
      provider: z.enum(["claude", "codex", "antigravity"]),
      sessionId: z.string(),
      cwd: z.string(),
    }),
    messages: z
      .array(
        z.object({
          role: z.enum(["user", "assistant"]),
          text: z.string().min(1).max(64000),
        }),
      )
      .min(1)
      .max(100),
  })
  .strict();
type Input = z.infer<typeof sideInput>;
type Settings = { model?: string; effort?: string };
type Dependencies = {
  terminal: (id: string) => TerminalInfo | undefined;
  host: (id: string) => HostConfig;
  password: (id: string) => Promise<string | undefined>;
  history: (
    binding: SideBinding,
    host: HostConfig,
    password?: string,
  ) => Promise<HistoryDetail>;
  screen: (id: string) => Promise<string>;
  settings: (
    binding: SideBinding,
    host: HostConfig,
    password?: string,
  ) => Promise<Settings>;
};
export function sidePrompt(
  messages: Input["messages"],
  history?: HistoryDetail,
  screen = "",
) {
  const parent: { role: string; text: string }[] = [];
  let remaining = 32000;
  for (const item of [
    ...(history?.timeline || history?.items || []),
  ].reverse()) {
    if (remaining <= 0) break;
    if (
      !item.text ||
      !["assistant", "user", "command", "change", "tool"].includes(item.kind)
    )
      continue;
    const text = [item.text, item.detail]
      .filter(Boolean)
      .join("\n")
      .slice(-Math.min(remaining, 8000));
    parent.push({ role: item.kind, text });
    remaining -= text.length;
    if (parent.length === 32) break;
  }
  return [
    "You are answering a separate side chat. Use the supplied parent records as reference only. Do not continue the parent task, change files or run commands. Reply directly to the last side-chat user in their language.",
    "Parent records (recent snapshot): " + JSON.stringify(parent.reverse()),
    ...(screen
      ? ["Parent terminal output (reference only): " + JSON.stringify(screen)]
      : []),
    "Side chat: " + JSON.stringify(messages),
  ].join("\n");
}

// Only provider reply events are eligible for display or insertion into the parent.
export function sideAnswer(provider: "codex" | "claude", output: string) {
  if (provider === "claude") {
    const r = JSON.parse(output);
    if (
      r.type === "result" &&
      !r.is_error &&
      r.subtype === "success" &&
      typeof r.result === "string" &&
      r.result.trim()
    )
      return r.result as string;
  } else {
    let final: string | undefined,
      completed = false;
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.type === "turn.failed" || r.type === "error")
        throw Error("Codex 옆 질문 실행이 실패했습니다.");
      if (
        r.type === "item.completed" &&
        r.item?.type === "agent_message" &&
        r.item.phase !== "commentary" &&
        typeof r.item.text === "string"
      )
        final = r.item.text;
      if (r.type === "turn.completed") completed = true;
    }
    if (completed && final?.trim()) return final;
  }
  throw Error("옆 질문의 최종 답변을 받지 못했습니다.");
}
async function textReply(
  host: HostConfig,
  password: string | undefined,
  b: SideBinding,
  settings: Settings,
  prompt: string,
  signal: AbortSignal,
) {
  const { model, effort } = settings;
  if (b.provider === "antigravity")
    return askAntigravitySide(host, password, model, prompt, signal);
  const claude = b.provider === "claude";
  const executable = claude
    ? host.kind === "local"
      ? await installedClaudeExecutable()
      : "claude"
    : host.codexPath || "codex";
  const args = claude
    ? [
        "--print",
        "--output-format",
        "json",
        "--tools",
        "",
        "--strict-mcp-config",
        "--no-session-persistence",
      ]
    : [
        "exec",
        "--json",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "-c",
        'approval_policy="never"',
      ];
  if (model) args.push("--model", model);
  if (!claude && effort)
    args.push("-c", "model_reasoning_effort=" + JSON.stringify(effort));
  if (!claude) args.push("-");
  const ssh =
    host.kind === "ssh" ? await passwordConnection(host, password) : undefined;
  let kill = () => {};
  try {
    signal.throwIfAborted();
    let stdout: Readable, stdin: Writable, closed: Promise<number | null>;
    if (ssh) {
      const ch = await new Promise<import("ssh2").ClientChannel>(
        (resolve, reject) =>
          ssh.exec(
            remoteCodexCommand({ codexPath: executable }, args, b.cwd),
            (err, c) => (err ? reject(err) : resolve(c)),
          ),
      );
      stdout = ch;
      stdin = ch;
      ch.stderr.resume();
      kill = () => {
        try {
          ch.signal("TERM");
        } finally {
          ch.close();
        }
      };
      closed = new Promise((resolve, reject) => {
        ch.once("close", resolve);
        ch.once("error", reject);
      });
    } else {
      const js = /\.(?:js|cjs|mjs)$/i.test(executable);
      const env = { ...process.env };
      for (const key of [
        "CLAUDECODE",
        "CODEX_THREAD_ID",
        "HARBOR_SESSION_TOKEN",
        "HARBOR_HOOK_TOKEN",
        "HARBOR_HOOK_URL",
        "HARBOR_AGY_BRIDGE",
      ])
        delete env[key];
      if (js) env.ELECTRON_RUN_AS_NODE = "1";
      const proc = spawn(
        js ? process.execPath : executable,
        js ? [executable, ...args] : args,
        {
          cwd: b.cwd || undefined,
          windowsHide: true,
          stdio: ["pipe", "pipe", "ignore"],
          env,
        },
      );
      stdout = proc.stdout;
      stdin = proc.stdin;
      kill = () => {
        proc.kill();
      };
      closed = new Promise((resolve, reject) => {
        proc.once("close", resolve);
        proc.once("error", reject);
      });
    }
    let size = 0;
    const chunks: Buffer[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const abort = () => reject(Error("옆 질문이 취소되었습니다."));
      signal.addEventListener("abort", abort, { once: true });
      const clear = () => signal.removeEventListener("abort", abort);
      closed.then(
        (code) => {
          clear();
          code === 0
            ? resolve()
            : reject(
                Error(
                  "옆 질문 실행이 종료됐습니다. CLI 로그인이나 모델 설정을 확인하세요.",
                ),
              );
        },
        (e) => {
          clear();
          reject(e);
        },
      );
      stdout.on("error", reject);
      stdin.on("error", reject);
      stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= 4000000) chunks.push(chunk);
        else reject(Error("옆 질문 출력이 너무 큽니다."));
      });
      if (signal.aborted) abort();
      else stdin.end(prompt);
    });
    await done;
    kill = () => {}; // A successful close already released the process or channel.
    return {
      text: sideAnswer(b.provider, Buffer.concat(chunks).toString("utf8")),
      model,
    };
  } finally {
    try {
      kill();
    } finally {
      ssh?.end();
    }
  }
}
export function createSideQuestions(deps: Dependencies, run = textReply) {
  const busy = new Set<string>();
  return async (
    id: string,
    input: Input,
    signal: AbortSignal,
    authorize: () => void,
  ): Promise<SideReply> => {
    const b = input.binding;
    const guard = () => {
      signal.throwIfAborted();
      authorize();
      const t = deps.terminal(id),
        bound = t && sideBinding(t);
      if (
        !bound ||
        bound.hostId !== b.hostId ||
        bound.provider !== b.provider ||
        bound.sessionId !== b.sessionId ||
        bound.cwd !== b.cwd
      )
        throw Object.assign(Error("원래 터미널의 대화가 변경됐습니다."), {
          status: 409,
        });
    };
    guard();
    if (
      input.messages.at(-1)?.role !== "user" ||
      input.messages.reduce((n, m) => n + m.text.length, 0) > 100000
    )
      throw Error("옆 대화의 질문 또는 길이를 확인하세요.");
    if (busy.has(id))
      throw Object.assign(Error("이 터미널의 옆 질문이 아직 진행 중입니다."), {
        status: 409,
      });
    busy.add(id);
    try {
      const host = deps.host(b.hostId),
        password = await deps.password(b.hostId);
      guard();
      const [history, settings] = b.sessionId
        ? await Promise.all([
            deps.history(b, host, password).catch(() => undefined),
            deps.settings(b, host, password).catch((): Settings => ({})),
          ])
        : [undefined, {} as Settings];
      if (
        history &&
        (history.thread.hostId !== b.hostId ||
          history.thread.id !== b.sessionId)
      )
        throw Error("본 대화 기록이 일치하지 않습니다.");
      const screen = history?.items.length ? "" : await deps.screen(id);
      guard();
      const reply = await run(
        host,
        password,
        b,
        settings,
        sidePrompt(input.messages, history, screen),
        signal,
      );
      guard();
      if (!reply.text.trim() || reply.text.length > 64000)
        throw Error("옆 답변 길이를 확인하세요.");
      return {
        text: reply.text,
        model: reply.model,
        effort: settings.effort,
        context: !!(history?.items.length || screen),
      };
    } finally {
      busy.delete(id);
    }
  };
}

export type SideQuestions = ReturnType<typeof createSideQuestions>;
export async function serveSideQuestion(
  req: Request,
  res: Response,
  ask: SideQuestions,
  authorize: () => void,
) {
  authorize();
  const controller = new AbortController();
  const close = () => controller.abort();
  res.once("close", close);
  try {
    const result = await ask(
      String(req.params.id),
      sideInput.parse(req.body),
      AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]),
      authorize,
    );
    if (!res.destroyed) res.set("Cache-Control", "no-store").json(result);
  } finally {
    res.off("close", close);
  }
}
