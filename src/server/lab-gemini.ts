import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Client, ClientChannel } from "ssh2";
import { findAntigravity } from "./antigravity.js";
import { passwordConnection } from "./ssh-connect.js";
import { remoteCodexCommand, shellQuote } from "./ssh.js";
import type { HostConfig } from "../shared/types.js";

// Antigravity discovers workspace agents under .agents/agents (Google CLI
// "Custom subagents"). Explicitly restrict this reviewer to a read-only tool.
const agent = "harbor-lab-reviewer";
const definition = [
  "---",
  "name: " + agent,
  "description: Review the supplied material.",
  "mainAgent: true",
  "subagent: false",
  "tools: [view_file]",
  "commandExecutionPolicy: off",
  "mcpServers: []",
  "---",
  "Analyze the material supplied by the user.",
].join("\n");
const args = ["acp", "--stdio", "--agent", agent, "--sandbox"];
function sshExec(client: Client, command: string) {
  return new Promise<ClientChannel>((resolve, reject) =>
    client.exec(command, (e, c) => (e ? reject(e) : resolve(c))),
  );
}
async function prepareRemote(client: Client) {
  const channel = await sshExec(
    client,
    'umask 077 && d=$(mktemp -d /tmp/harbor-lab-XXXXXXXXXX) && mkdir -p "$d/.agents/agents" && printf %s ' +
      shellQuote(Buffer.from(definition).toString("base64")) +
      ' | base64 -d > "$d/.agents/agents/' +
      agent +
      '.md" && printf %s "$d"',
  );
  let path = "";
  channel.on("data", (d: Buffer) => {
    path = (path + d).slice(-256);
  });
  await new Promise<void>((resolve, reject) => {
    channel.on("error", reject);
    channel.on("close", (code: number) =>
      code === 0
        ? resolve()
        : reject(Error("Gemini 검토 폴더를 준비하지 못했습니다.")),
    );
  });
  if (!/^\/tmp\/harbor-lab-[a-zA-Z0-9]+$/.test(path))
    throw Error("잘못된 Gemini 임시 작업 경로입니다.");
  return path;
}
export async function geminiReview(
  host: HostConfig,
  password: string | undefined,
  model: string | undefined,
  prompt: string,
  signal: AbortSignal,
) {
  let client: Client | undefined,
    dir = "",
    stop: () => void = () => {},
    source: Readable,
    sink: Writable;
  signal.throwIfAborted();
  try {
    if (host.kind === "local") {
      const exe = findAntigravity();
      if (!exe) throw Error("Antigravity 실행 파일을 찾지 못했습니다.");
      dir = await mkdtemp(join(tmpdir(), "harbor-lab-"));
      const root = join(dir, ".agents", "agents");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, agent + ".md"), definition);
      signal.throwIfAborted();
      const proc = spawn(exe, args, {
        cwd: dir,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
      proc.on("error", (error) => proc.stdout.destroy(error));
      source = proc.stdout;
      sink = proc.stdin;
      stop = () => {
        proc.stdin.end();
        proc.kill();
      };
    } else {
      client = await passwordConnection(host, password);
      client.on("error", () => {});
      signal.throwIfAborted();
      dir = await prepareRemote(client);
      signal.throwIfAborted();
      const channel = await sshExec(
        client,
        remoteCodexCommand({ codexPath: "agy" }, args, dir),
      );
      channel.stderr.resume();
      source = channel;
      sink = channel;
      stop = () => channel.close();
    }
    let nativeId = "",
      actualModel = "";
    const text = await readAcpAnswer(
      source,
      sink,
      dir,
      model,
      prompt,
      signal,
      (id, m) => {
        nativeId = id;
        actualModel = m;
      },
    );
    return { text, nativeId, model: actualModel };
  } finally {
    stop();
    if (client) {
      // Only files created by this turn are removed. The directory is validated
      // above; native-created additional files are left to the remote tmp policy.
      if (dir)
        await new Promise<void>((done) => {
          const timer = setTimeout(done, 1500);
          client!.exec(
            "rm -f " +
              shellQuote(dir + "/.agents/agents/" + agent + ".md") +
              "; rmdir " +
              [dir + "/.agents/agents", dir + "/.agents", dir]
                .map(shellQuote)
                .join(" "),
            (e, c) => {
              if (e) {
                clearTimeout(timer);
                done();
                return;
              }
              c.resume();
              c.once("close", () => {
                clearTimeout(timer);
                done();
              });
            },
          );
        }).catch(() => {});
      client.end();
    } else if (dir)
      await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(
        () => {},
      );
  }
}

export async function readAcpAnswer(
  source: Readable,
  sink: Writable,
  cwd: string,
  requested: string | undefined,
  prompt: string,
  signal: AbortSignal,
  confirmed?: (sessionId: string, model: string) => void,
) {
  let seq = 0,
    sessionId = "",
    answer = "";
  const reader = createInterface({ input: source });
  let pending:
    | { id: number; ok: (r: any) => void; fail: (error: Error) => void }
    | undefined;
  let failure: Error | undefined;
  const fail = (e: Error) => {
    failure = e;
    pending?.fail(e);
  };
  const end = () => fail(Error("Gemini 응답 전에 연결이 종료됐습니다."));
  const aborted = () => fail(Error("Gemini 질문이 중단됐습니다."));
  const send = (m: unknown) => sink.write(JSON.stringify(m) + "\n");
  const call = (method: string, params: unknown) =>
    new Promise<any>((ok, reject) => {
      if (failure || signal.aborted) {
        reject(failure || Error("질문이 중단됐습니다."));
        return;
      }
      pending = { id: ++seq, ok, fail: reject };
      send({ jsonrpc: "2.0", id: seq, method, params });
    });
  signal.addEventListener("abort", aborted, { once: true });
  source.on("error", fail);
  sink.on("error", fail);
  reader.on("error", fail);
  reader.once("close", end);
  reader.on("line", (line) => {
    try {
      const m = JSON.parse(line);
      if (m.method && m.id !== undefined) {
        send(
          m.method === "session/request_permission"
            ? {
                jsonrpc: "2.0",
                id: m.id,
                result: { outcome: { outcome: "cancelled" } },
              }
            : {
                jsonrpc: "2.0",
                id: m.id,
                error: {
                  code: -32601,
                  message: "Unsupported review capability",
                },
              },
        );
      } else if (
        m.method === "session/update" &&
        m.params?.sessionId === sessionId
      ) {
        const u = m.params.update;
        if (
          u?.sessionUpdate === "agent_message_chunk" &&
          u.content?.type === "text"
        )
          answer += u.content.text;
        if (answer.length > 128000)
          fail(Error("Gemini 응답이 보관 한도를 초과했습니다."));
      } else if (!m.method && pending && m.id === pending.id) {
        const target = pending;
        pending = undefined;
        if (m.error)
          target.fail(
            Error(String(m.error.message || "ACP 오류").slice(0, 600)),
          );
        else target.ok(m.result);
      }
    } catch {
      fail(Error("Gemini ACP 응답 형식을 확인하세요."));
    }
  });
  try {
    const init = await call("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "harbor-lab", version: "2" },
    });
    if (init.protocolVersion !== 1)
      throw Error("지원하지 않는 ACP 버전입니다.");
    const opened = await call("session/new", { cwd, mcpServers: [] });
    sessionId = opened.sessionId;
    if (typeof sessionId !== "string" || !sessionId)
      throw Error("Gemini 대화 ID가 없습니다.");
    const opt = opened.configOptions?.find(
      (o: any) => o.id === "model" || o.category === "model",
    );
    const available: unknown[] = (opt?.options || []).flatMap((o: any) =>
      Array.isArray(o.options) ? o.options.map((p: any) => p.value) : [o.value],
    );
    const current = opt?.currentValue || opened.models?.currentModelId;
    const model =
      requested ||
      (/^gemini[-_]/i.test(current || "")
        ? current
        : available.find(
            (v) => typeof v === "string" && /^gemini[-_]/i.test(v),
          ));
    if (typeof model !== "string" || !/^gemini[-_]/i.test(model))
      throw Error("이 서버의 Gemini 모델 ID를 지정하세요.");
    if (current !== model) {
      if (!opt) throw Error("Gemini 모델 설정을 확인할 수 없습니다.");
      const set = await call("session/set_config_option", {
        sessionId,
        configId: opt.id,
        value: model,
      });
      const applied = set.configOptions?.find(
        (o: any) => o.id === opt.id,
      )?.currentValue;
      const effort = set.configOptions?.find(
        (o: any) => o.id === "thought_level" || o.category === "thought_level",
      )?.currentValue;
      // agy models advertises combined IDs. ACP may acknowledge a successful
      // selection as separate model and thought_level values.
      if (
        applied !== model &&
        !(
          typeof applied === "string" &&
          typeof effort === "string" &&
          applied + "-" + effort === model
        )
      )
        throw Error("요청한 Gemini 모델이 적용되지 않았습니다.");
    }
    confirmed?.(sessionId, model);
    const result = await call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: prompt }],
    });
    if (result.stopReason !== "end_turn")
      throw Error("Gemini 응답이 중단됐습니다: " + String(result.stopReason));
    return answer;
  } finally {
    signal.removeEventListener("abort", aborted);
    reader.off("close", end);
    reader.close();
  }
}
