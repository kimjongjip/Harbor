import { managedClaudeServer, type ManagedPeerCall } from "./managed-peers.js";
import { editResult, toolDescription, toolResult } from "./claude-history-items.js";
import {attachTargets,claudeApprovalTargets} from "./managed-auto-accept.js";
import { spawn } from "node:child_process";
import { claudeWorkId } from "./terminal-work.js";
import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
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
import { claudeUsage, type TerminalUsage } from "../shared/terminal-usage.js";
import { terminalAgents,type TerminalAgent } from "../shared/terminal-agents.js";
import { passwordConnection } from "./ssh-connect.js";
import { remoteCodexCommand } from "./ssh.js";

export interface ClaudeChatEvents {
  usage?(value:TerminalUsage):void;
  item(item: MessageItem): void;
  approval(
    value: Approval,
  ): Promise<{ approved?: boolean; answers?: Record<string, string> }>;
  removeApproval(id: string): void;
  native(id: string, model?: string): void;
}
export interface ClaudeChatTurn {
  images?: string[];
  host: HostConfig;
  password?: string;
  nativeId: string;
  resume: boolean;
  cwd: string;
  model?: string;
  reviewOnly?: boolean;
  sideReader?: {url:string;token:string};
  effort?: import("../shared/ide-chat.js").ChatEffort;
  acceptEdits?: boolean;
  readOnly?: boolean;
  peerCall?: ManagedPeerCall;
  text: string;
  requestId: string;
  events: ClaudeChatEvents;
  beforeDispatch?: () => void | Promise<void>;
}
export interface ClaudeChatRun {
  readonly processId?: number;
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
        if (!(await stat(candidate)).isFile()) continue;
        await access(
          candidate,
          process.platform === "win32" || suffix.endsWith(".js")
            ? constants.R_OK
            : constants.X_OK,
        );
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
    nativeId?: string,
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
        const scoped = nativeId ? `export HARBOR_CLAUDE_WORK_ID=${claudeWorkId(nativeId)}; ${command}` : command;
        connection.exec(scoped, (error, channel) => {
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
  private model?: string;
  private lastInput?: unknown;
  private crew:TerminalAgent[]=[];
  private currentMessage = "";
  private blocks = new Map<string, string>();
  private streamTools = new Map<string, {id:string; name:string; json:string}>();
  private tools = new Map<string, MessageItem>();
  private hasAnswer = false;
  constructor(
    private readonly events: ClaudeChatEvents,
    private readonly requestId: string,
    private readonly nativeSession?:string,
  ) {}
  private observeUsage(m:any) {
    const model=string(m.model || m.message?.model);
    if(model && model!==this.model){this.model=model;this.lastInput=undefined;}
    const result=m.type==="result" && m.subtype==="success" && !m.is_error;
    const assistant=m.type==="assistant" && !m.error && !!m.message?.usage;
    const prev=this.crew.find(a=>a.id===m.task_id);
    const task=m.type==="system" && ["task_started","task_progress","task_notification"].includes(m.subtype) &&
      (m.task_type==="local_agent" || m.subagent_type || prev);
    if(!result && !assistant && !task)return;
    if(assistant)this.lastInput=m.message.usage;
    if(task){
      const entry={...prev,id:m.task_id,name:m.subagent_type||prev?.name||"Claude",task:m.description||prev?.task,
        activity:m.last_tool_name || m.summary || prev?.activity,
        tokens:m.usage?.total_tokens!==undefined?{scope:"observed",total:m.usage.total_tokens}:prev?.tokens,
        state:m.subtype==="task_notification"?m.status:"working"};
      this.crew=terminalAgents([entry,...this.crew.filter(a=>a.id!==m.task_id)])||[];
    }
    const snapshot=claudeUsage({session_id:m.session_id,model:{id:this.model},
      context_window:{current_usage:this.lastInput,context_window_size:result && this.model ? m.modelUsage?.[this.model]?.contextWindow:undefined},
      cost:{total_cost_usd:result ? m.total_cost_usd:undefined},
      ...(this.crew.length ? {harbor_agents:this.crew,harbor_agent_details:1}:{}),
    });
    if(snapshot)this.events.usage?.({...snapshot,...(snapshot.costUsd!==null?{costSource:"api-estimate" as const}:{})});
  }
  private tool(id:string, name:string, input?:unknown) {
    if (!id || !name) return;
    const fields = input && typeof input === "object" ? input as Record<string,unknown> : {};
    const change = name === "Edit" ? [typeof fields.old_string === "string" && fields.old_string && "기존 내용\n"+fields.old_string,
      typeof fields.new_string === "string" && fields.new_string && "변경 내용\n"+fields.new_string] :
      name === "Write" ? [typeof fields.content === "string" && fields.content] : [];
    const shown = [toolDescription({input}),...change].filter(Boolean).join("\n").slice(0,24000);
    const row: MessageItem = {
      id, toolUseId:id, kind: name === "Bash" || name === "PowerShell" ? "command" : "tool",
      text:name, status:"started", detail:shown || this.tools.get(id)?.detail,
    };
    this.tools.set(id,row);
    this.events.item(row);
  }
  consume(raw: unknown) {
    const m = raw as any;
    if (!m || typeof m !== "object") return;
    if (m.parent_tool_use_id) return;
    if (this.events.usage && typeof m.session_id==="string" && m.session_id===this.nativeSession) this.observeUsage(m);
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
      const tool = this.streamTools.get(id);
      if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
        const {id:toolId,name,input} = e.content_block;
        if (typeof toolId === "string" && typeof name === "string") {
          this.streamTools.set(id,{id:toolId,name,json:""});
          this.tool(toolId,name,input);
        }
        return;
      }
      if (tool && e?.type === "content_block_delta" && e.delta?.type === "input_json_delta") {
        tool.json = (tool.json + string(e.delta.partial_json)).slice(0,64000);
        return;
      }
      if (tool && e?.type === "content_block_stop") {
        this.streamTools.delete(id);
        if (tool.json) {
          try { this.tool(tool.id,tool.name,JSON.parse(tool.json)); }
          catch { /* The following assistant block contains the complete tool input. */ }
        }
        return;
      }
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
          this.tool(string(block.id),string(block.name),block.input);
        }
      }
      if (m.error) throw new Error(`Claude: ${string(m.error)}`);
    } else if (m.type === "tool_progress" && string(m.tool_use_id) && string(m.tool_name)) {
      if (!this.tools.has(m.tool_use_id)) this.tool(m.tool_use_id,m.tool_name);
      const row=this.tools.get(m.tool_use_id)!;
      const elapsed = Number(m.elapsed_time_seconds);
      if (Number.isFinite(elapsed) && elapsed >= 0)
        this.events.item({...row,detail:[row.detail,`실행 중 · ${Math.floor(elapsed)}초`].filter(Boolean).join("\n")});
    } else if (m.type === "system" && ["task_started","task_progress","task_notification"].includes(m.subtype) &&
               string(m.task_id) && !m.ambient && !m.skip_transcript) {
      const text=string(m.description) || string(m.summary);
      if (text) this.events.item({id:"task:"+(string(m.run_id)||m.task_id),kind:"tool",text:text.slice(0,2000),
        detail:[m.last_tool_name,m.summary !== text && m.summary].filter(v=>typeof v==="string" && v).join("\n").slice(0,24000),
        status:m.subtype === "task_notification" ? m.status || "completed" : "inProgress"});
    } else if (m.type === "tool_use_summary" && string(m.summary) && string(m.uuid)) {
      this.events.item({id:m.uuid,kind:"notice",text:m.summary.slice(0,8000),status:"completed"});
    } else if (m.type === "user" && Array.isArray(m.message?.content)) {
      const results = m.message.content.filter((block:any) => block?.type === "tool_result");
      for (const block of results) {
          if (!string(block.tool_use_id)) continue;
          const patch = results.length === 1 && !block.is_error ? editResult(m.tool_use_result) : undefined;
          this.events.item({
            id: `${string(block.tool_use_id)}:result`,
            toolUseId:block.tool_use_id, kind: "tool",
            text: patch?.text || "도구 결과",
            detail:(patch?.detail || toolResult(block)).slice(0,24000),
            ...(patch?.format ? {format:patch.format} : {}),
            status: block.is_error ? "failed" : "completed",
          });
          this.tools.delete(block.tool_use_id);
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
    let processId: number | undefined;
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
      // Only classify this SDK's actual named tool with its unmodified inputs.
      if(!turn.reviewOnly&&!turn.readOnly&&!context.agentID&&!context.mcpServer&&!context.matchedAskRule&&!context.defaultToNo&&!context.blockedPath&&!context.decisionReason)
        attachTargets(approval,claudeApprovalTargets(name,input));
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
          message: {
            role: "user",
            content: turn.images?.length
              ? [
                  ...(turn.text.trim()
                    ? [{ type: "text" as const, text: turn.text }]
                    : []),
                  ...turn.images.map((url) => {
                    const comma = url.indexOf(",");
                    const media_type = url.slice(5, url.indexOf(";")) as
                      "image/png" | "image/jpeg" | "image/webp" | "image/gif";
                    return {
                      type: "image" as const,
                      source: {
                        type: "base64" as const,
                        media_type,
                        data: url.slice(comma + 1),
                      },
                    };
                  }),
                ]
              : turn.text,
          },
          parent_tool_use_id: null,
          uuid: randomUUID(),
        };
        await inputDone;
      };
      const parser = new ClaudeChatMessages(turn.events, turn.requestId,turn.nativeId);
      running = (dependencies.query || query)({
        prompt: input(),
        options: {
          ...(turn.peerCall && !turn.reviewOnly
            ? { mcpServers: { harbor: managedClaudeServer(turn.peerCall) } }
            : {}),
          cwd: turn.cwd,
          model: turn.model || undefined,
          ...(turn.resume
            ? { resume: turn.nativeId }
            : { sessionId: turn.nativeId }),
          pathToClaudeCodeExecutable: executable,
          permissionMode: turn.acceptEdits && !turn.readOnly && !turn.reviewOnly ? "acceptEdits" : "default",
          ...(turn.effort && turn.effort !== "none" && turn.effort !== "minimal" && turn.effort !== "ultra" ? { effort: turn.effort } : {}),
          ...(turn.reviewOnly
            ? {
                tools: [],
                mcpServers: turn.sideReader ? {harbor_side:{type:"http",url:turn.sideReader.url,headers:{Authorization:"Bearer "+turn.sideReader.token}}} : {},
                ...(turn.sideReader && {allowedTools:["mcp__harbor_side__read_parent"]}),
                strictMcpConfig: true,
                settingSources: [],
                persistSession: true,
              }
            : {}),
          canUseTool: permissions,
          ...(turn.readOnly && !turn.reviewOnly ? {tools:["Read","Glob","Grep"],mcpServers:{},strictMcpConfig:true} : {}),
          settingSources: turn.reviewOnly || turn.readOnly ? [] : ["user", "project", "local"],
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
                turn.nativeId,
              );
            const child = (dependencies.spawn || spawn)(
              options.command,
              options.args,
              {
                cwd: options.cwd,
                env: { ...options.env, HARBOR_CLAUDE_WORK_ID: claudeWorkId(turn.nativeId) },
                signal: options.signal,
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
              },
            );
            processId = child.pid;
            const clearPid = () => { if (processId === child.pid) processId = undefined; };
            child.once("exit", clearPid);
            child.once("error", clearPid);
            // The SDK does not drain stderr for a custom spawner.
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
      get processId() { return processId; },
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
