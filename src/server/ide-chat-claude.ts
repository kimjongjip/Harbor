import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk/core";
import type {
  Options,
  PermissionResult,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { Client, ClientChannel } from "ssh2";
import type { Approval, HostConfig, MessageItem } from "../shared/types.js";
import { passwordConnection } from "./ssh-connect.js";
import { remoteCodexCommand } from "./ssh.js";

export interface ClaudeChatEvents {
  item(item: MessageItem): void;
  approval(
    value: Approval,
  ): Promise<{ approved?: boolean; answers?: Record<string, string> }>;
  removeApproval(id: string): void;
  native(id: string, model?: string): void;
}
export interface ClaudeChatTurn {
  host: HostConfig;
  password?: string;
  nativeId: string;
  resume: boolean;
  cwd: string;
  model?: string;
  text: string;
  requestId: string;
  events: ClaudeChatEvents;
  beforeDispatch?: () => void | Promise<void>;
}
export interface ClaudeChatRun {
  done: Promise<void>;
  interrupt(): Promise<void>;
  close(): void;
}
export type ClaudeChatFactory = (turn: ClaudeChatTurn) => ClaudeChatRun;
export type ClaudeQuery = typeof query;

/** Resolve the installed CLI, including npm shims, without invoking a shell. */
export async function installedClaudeExecutable(): Promise<string> {
  const dirs = [
    ...new Set([
      ...(process.env.PATH || "").split(path.delimiter),
      path.join(os.homedir(), ".local", "bin"),
      ...(process.env.APPDATA ? [path.join(process.env.APPDATA, "npm")] : []),
    ]),
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const suffix of process.platform === "win32"
      ? [
          "claude.exe",
          "node_modules/@anthropic-ai/claude-code/bin/claude.exe",
          "node_modules/@anthropic-ai/claude-code/cli.js",
        ]
      : ["claude", "node_modules/@anthropic-ai/claude-code/cli.js"]) {
      const candidate = path.join(dir.replace(/^"|"$/g, ""), suffix);
      try {
        await access(candidate);
        return candidate;
      } catch {
        /* next PATH entry */
      }
    }
  }
  throw new Error(
    "이 컴퓨터에 Claude Code가 설치되어 있지 않습니다. Claude CLI 설치·로그인 후 다시 보내 주세요.",
  );
}

/** A byte-stream SSH process. No PTY, shell keystrokes, or remote credentials in argv. */
export class ClaudeSshProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  private connection?: Client;
  private channel?: ClientChannel;
  private ended = false;
  private exitReceived = false;
  private exitSignal: NodeJS.Signals | null = null;
  private stderr = "";
  constructor(
    host: HostConfig,
    password: string | undefined,
    options: SpawnOptions,
    connect: typeof passwordConnection = passwordConnection,
  ) {
    super();
    this.stdin.on("error", () => {});
    this.stdout.on("error", () => {});
    const abort = () => this.kill("SIGTERM");
    options.signal?.addEventListener("abort", abort, { once: true });
    this.once("exit", () =>
      options.signal?.removeEventListener("abort", abort),
    );
    // Do not forward the local SDK environment to a different host. The remote
    // CLI loads its own login, settings and environment through the login shell.
    void connect(host, password)
      .then((connection) => {
        if (this.killed) {
          connection.end();
          return;
        }
        this.connection = connection;
        connection.on("error", (error) => this.fail(error));
        connection.on("close", () => {
          if (this.ended) return;
          if (this.exitReceived) this.finish(this.exitCode, this.exitSignal);
          else
            this.fail(
              new Error(
                this.stderr.trim() || "Claude SSH 연결이 종료되었습니다.",
              ),
            );
        });
        const command = remoteCodexCommand(
          { codexPath: "claude" },
          options.args,
          options.cwd,
        );
        connection.exec(command, (error, channel) => {
          if (error) {
            this.fail(error);
            return;
          }
          if (this.killed) {
            channel.close();
            connection.end();
            return;
          }
          this.channel = channel;
          this.stdin.pipe(channel);
          channel.pipe(this.stdout);
          channel.stderr.on("data", (data: Buffer) => {
            this.stderr = (this.stderr + data.toString()).slice(-6000);
          });
          channel.on("error", (err: Error) => this.fail(err));
          // SSH exit-status can arrive BEFORE the final stdout bytes. Only the
          // channel close/EOF completes the byte stream consumed by the SDK.
          channel.on("exit", (code: number | null, signal?: string) => {
            this.exitReceived = true;
            this.exitCode = code;
            this.exitSignal = (signal as NodeJS.Signals) || null;
          });
          channel.on("close", () =>
            this.finish(
              this.exitReceived ? this.exitCode : this.killed ? 0 : 1,
              this.exitSignal,
            ),
          );
        });
      })
      .catch((error) =>
        this.fail(error instanceof Error ? error : new Error(String(error))),
      );
  }
  private fail(error: Error) {
    if (this.ended) return;
    this.emit("error", error);
    this.finish(1, null);
  }
  private finish(code: number | null, signal: NodeJS.Signals | null) {
    if (this.ended) return;
    this.ended = true;
    this.exitCode = code;
    this.stdin.unpipe();
    this.stdin.destroy();
    this.stdout.end();
    this.channel?.close();
    this.connection?.end();
    this.emit("exit", code, signal);
  }
  kill(signal: NodeJS.Signals): boolean {
    if (this.ended) return false;
    this.killed = true;
    // Closing this dedicated exec channel only terminates this managed engine.
    try {
      this.channel?.signal(signal.replace(/^SIG/, ""));
    } catch {
      /* channel may already be gone */
    }
    this.finish(null, signal);
    return true;
  }
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function detail(value: unknown) {
  return (JSON.stringify(value, null, 2) || "").slice(0, 24000);
}

/** Consume SDK messages, not screen output; each tool/text block has a stable ID. */
export class ClaudeChatMessages {
  private currentMessage = "";
  private blocks = new Map<string, string>();
  private hasAnswer = false;
  constructor(
    private readonly events: ClaudeChatEvents,
    private readonly requestId: string,
  ) {}
  consume(raw: unknown) {
    const m = raw as any;
    if (!m || typeof m !== "object") return;
    if (m.parent_tool_use_id) return;
    if (m.session_id)
      this.events.native(
        string(m.session_id),
        string(m.model || m.message?.model) || undefined,
      );
    if (m.type === "stream_event") {
      const e = m.event;
      if (e?.type === "message_start")
        this.currentMessage = string(e.message?.id) || this.requestId;
      const id = `${this.currentMessage || this.requestId}:${Number(e?.index) || 0}`;
      if (
        e?.type === "content_block_start" &&
        e.content_block?.type === "text"
      ) {
        this.blocks.set(id, string(e.content_block.text));
      } else if (
        e?.type === "content_block_delta" &&
        e.delta?.type === "text_delta"
      ) {
        const text = (this.blocks.get(id) || "") + string(e.delta.text);
        this.blocks.set(id, text);
        this.hasAnswer = true;
        this.events.item({ id, kind: "assistant", text, status: "inProgress" });
      }
    } else if (m.type === "assistant") {
      const messageId =
        string(m.message?.id) || string(m.uuid) || this.requestId;
      for (const [index, block] of (Array.isArray(m.message?.content)
        ? m.message.content
        : []
      ).entries()) {
        if (block.type === "text") {
          // Partial SDK assistant frames can contain one block. Reconcile with
          // the streamed block by content before using its array index.
          const match = [...this.blocks.entries()].find(
            ([id, text]) =>
              id.startsWith(`${messageId}:`) && text === block.text,
          );
          const id = match?.[0] || `${messageId}:${index}`;
          this.blocks.set(id, string(block.text));
          this.hasAnswer = true;
          this.events.item({
            id,
            kind: "assistant",
            text: string(block.text),
            status: "completed",
          });
        } else if (block.type === "tool_use") {
          this.events.item({
            id: string(block.id),
            kind: block.name === "Bash" ? "command" : "tool",
            text: string(block.name),
            detail: detail(block.input),
            status: "inProgress",
          });
        }
      }
      if (m.error) throw new Error(`Claude: ${string(m.error)}`);
    } else if (m.type === "user" && Array.isArray(m.message?.content)) {
      for (const block of m.message.content)
        if (block.type === "tool_result") {
          this.events.item({
            id: `${string(block.tool_use_id)}:result`,
            kind: "tool",
            text: "도구 결과",
            detail:
              typeof block.content === "string"
                ? block.content
                : detail(block.content),
            status: block.is_error ? "failed" : "completed",
          });
        }
    } else if (m.type === "result") {
      if (m.is_error || m.subtype !== "success")
        throw new Error(
          Array.isArray(m.errors)
            ? m.errors.join("\n")
            : string(m.result) || `Claude 작업 종료: ${string(m.subtype)}`,
        );
      if (!this.hasAnswer && m.result)
        this.events.item({
          id: `${this.requestId}:answer`,
          kind: "assistant",
          text: string(m.result),
          status: "completed",
        });
    }
  }
}

export function createClaudeChatFactory(
  dependencies: {
    query?: ClaudeQuery;
    executable?: () => Promise<string>;
    spawn?: typeof spawn;
    connect?: typeof passwordConnection;
  } = {},
): ClaudeChatFactory {
  return (turn) => {
    const abortController = new AbortController();
    let running: ReturnType<ClaudeQuery> | undefined;
    let releaseInput!: () => void;
    const inputDone = new Promise<void>((resolve) => {
      releaseInput = resolve;
    });
    const permissions: NonNullable<Options["canUseTool"]> = async (
      name,
      input,
      context,
    ): Promise<PermissionResult> => {
      const id = randomUUID();
      const rawQuestions: any[] =
        name === "AskUserQuestion" && Array.isArray(input.questions)
          ? input.questions
          : [];
      const approval: Approval = {
        id,
        requestId: id,
        method: name,
        kind: rawQuestions.length
          ? "question"
          : name === "Bash"
            ? "command"
            : /Edit|Write/.test(name)
              ? "file"
              : "permissions",
        title: rawQuestions.length
          ? "Claude 질문"
          : `Claude · ${name} 실행 승인`,
        detail: detail(input),
        questions: rawQuestions.map((q, index) => ({
          id: String(index),
          header: string(q.header),
          question: string(q.question),
          options: Array.isArray(q.options)
            ? q.options.map((o: any) => ({
                label: string(o.label),
                description: string(o.description),
              }))
            : undefined,
        })),
      };
      let abort!: () => void;
      try {
        const denied = new Promise<{ approved: false }>((resolve) => {
          abort = () => resolve({ approved: false });
          context.signal.addEventListener("abort", abort, { once: true });
        });
        if (context.signal.aborted)
          return { behavior: "deny", message: "요청이 취소되었습니다." };
        const answer = await Promise.race([
          turn.events.approval(approval),
          denied,
        ]);
        if (!answer.approved)
          return {
            behavior: "deny",
            message: "사용자가 이 요청을 거절했습니다.",
            decisionClassification: "user_reject",
          };
        const answers = "answers" in answer ? answer.answers : undefined;
        return {
          behavior: "allow",
          decisionClassification: "user_temporary",
          updatedInput: rawQuestions.length
            ? {
                ...input,
                answers: Object.fromEntries(
                  rawQuestions.map((q, index) => [
                    string(q.question),
                    answers?.[String(index)] || "",
                  ]),
                ),
              }
            : input,
        };
      } finally {
        context.signal.removeEventListener("abort", abort);
        turn.events.removeApproval(id);
      }
    };
    const done = (async () => {
      const executable =
        turn.host.kind === "local"
          ? await (dependencies.executable || installedClaudeExecutable)()
          : "claude";
      if (abortController.signal.aborted) return;
      const input = async function* (): AsyncGenerator<SDKUserMessage> {
        // SDK startup and SSH authentication can take time. Recheck the paired
        // caller and native-session binding when the prompt actually leaves.
        await turn.beforeDispatch?.();
        yield {
          type: "user",
          session_id: turn.nativeId,
          message: { role: "user", content: turn.text },
          parent_tool_use_id: null,
          uuid: randomUUID(),
        };
        await inputDone;
      };
      const parser = new ClaudeChatMessages(turn.events, turn.requestId);
      running = (dependencies.query || query)({
        prompt: input(),
        options: {
          cwd: turn.cwd,
          model: turn.model || undefined,
          ...(turn.resume
            ? { resume: turn.nativeId }
            : { sessionId: turn.nativeId }),
          pathToClaudeCodeExecutable: executable,
          permissionMode: "default",
          canUseTool: permissions,
          settingSources: ["user", "project", "local"],
          systemPrompt: { type: "preset", preset: "claude_code" },
          includePartialMessages: true,
          abortController,
          spawnClaudeCodeProcess: (options) => {
            if (turn.host.kind === "ssh")
              return new ClaudeSshProcess(
                turn.host,
                turn.password,
                options,
                dependencies.connect,
              );
            const child = (dependencies.spawn || spawn)(
              options.command,
              options.args,
              {
                cwd: options.cwd,
                env: options.env,
                signal: options.signal,
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
              },
            );
            // The SDK does not install its default stderr consumer for a custom
            // spawner. Always drain this pipe or verbose CLI logs can block it.
            child.stderr?.on("data", () => {});
            return child as unknown as SpawnedProcess;
          },
        },
      });
      try {
        let completed = false;
        for await (const message of running) {
          parser.consume(message);
          if (message.type === "result") {
            completed = true;
            releaseInput();
            break;
          }
        }
        if (!completed && !abortController.signal.aborted)
          throw new Error(
            "Claude 연결이 답변 완료 전에 종료되었습니다. 같은 메시지는 자동 재전송하지 않았습니다.",
          );
      } finally {
        releaseInput();
        running.close();
      }
    })();
    return {
      done,
      async interrupt() {
        if (running) await running.interrupt();
        else abortController.abort();
      },
      close() {
        releaseInput();
        abortController.abort();
        running?.close();
      },
    };
  };
}
