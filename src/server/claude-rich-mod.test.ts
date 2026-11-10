import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import {
  claudeRichBootstrap,
  claudeRichModFiles,
  claudeRichModModule,
} from "./claude-rich-mod.js";

const ENGINE = { type: "Text", props: {}, children: ["native reply"] };
const descriptor = {
  enabled: true,
  id: "00112233445566778899aabbccddeeff",
  marker: "~HBR:00112233445566778899~",
  rows: 13,
  columns: 78,
};

async function fixture() {
  const native = await import(
    `data:text/javascript;base64,${Buffer.from(claudeRichModModule()).toString("base64")}#${randomUUID()}`
  );
  const hooks = new Map<string, (...args: any[]) => any>();
  native.register(
    (event: string, matcher: unknown, callback?: (...args: any[]) => any) => {
      hooks.set(event, (callback || matcher) as (...args: any[]) => any);
      return { catch() {} };
    },
  );
  const deferred: (() => Promise<void>)[] = [];
  const pulses = new Set<() => void>();
  const requests: { url: string; init: any }[] = [];
  const snapshots: { path: string; text: string }[] = [];
  let now = 100;
  let invalidations = 0;
  let reply: unknown = descriptor;
  let fail = false;
  let token: string | undefined = "synthetic-hook-token";
  let url = "http://127.0.0.1:43219/bridge/claude";
  let pending: Promise<void> | undefined;
  const $ = {
    agent: { list: async (): Promise<any[]> => [] },
    env: {
      get: async (name: string) =>
        name === "HOME"
          ? "/synthetic/home"
          : name === "HARBOR_HOOK_TOKEN"
            ? token
            : url,
    },
    fs: {
      write: async (path: string, text: string) => {
        snapshots.push({ path, text });
      },
    },
    session: {
      id: async () => "synthetic-native-session",
      cwd: async () => "/synthetic/project",
      model: async () => "claude-opus-5-5",
      usage: async (_args?: unknown) => ({
        context: { tokens: 51000, window: 1000000 },
        cost: { usd: 47.8 },
      }),
    },
    clock: {
      every: (ms: number, callback: () => void) => {
        assert.equal(ms, 2500);
        pulses.add(callback);
        return { cancel: () => pulses.delete(callback) };
      },
      now: async () => now,
      after: (_ms: number, callback: () => Promise<void>) => {
        deferred.push(callback);
        return { cancel() {} };
      },
    },
    http: {
      fetch: async (requestUrl: string, init: any) => {
        requests.push({ url: requestUrl, init });
        await pending;
        if (fail) throw new Error("Synthetic renderer unavailable");
        return { ok: true, text: JSON.stringify(reply) };
      },
    },
    ui: {
      invalidate: (event: string) => {
        assert.equal(event, "ui.render");
        invalidations++;
      },
      resolve: () => ({
        Box: (props: any) => ({ type: "Box", props }),
        Text: (props: any) => {
          assert.equal(
            "height" in props || "flexShrink" in props,
            false,
            "layout props belong on Box, not native Text",
          );
          return { type: "Text", props };
        },
      }),
    },
  };
  const message = (changes: Record<string, any> = {}) => ({
    surface: "terminal",
    component: "AssistantMessage",
    requestId: "native-block-7",
    props: { text: "## 설명\n\n$$\\frac{a}{b}$$", isFirstOfReply: true },
    viewport: { columns: 80, rows: 30 },
    ...changes,
  });
  const render = (event = message()) =>
    hooks.get("ui.render")!($, event, async () => ENGINE);
  return {
    $,
    hooks,
    message,
    render,
    deferred,
    requests,
    snapshots,
    pulses,
    get invalidations() {
      return invalidations;
    },
    set time(value: number) {
      now = value;
    },
    set response(value: unknown) {
      reply = value;
    },
    set failed(value: boolean) {
      fail = value;
    },
    set token(value: string | undefined) {
      token = value;
    },
    set url(value: string) {
      url = value;
    },
    set pending(value: Promise<void> | undefined) {
      pending = value;
    },
    flush: async () => {
      while (deferred.length) await deferred.shift()!();
    },
  };
}

test("agent status pulses are bounded, separate from drawing, and cancelled with the native session", async () => {
  const f = await fixture();
  f.$.agent.list = async () =>
    Array.from({ length: 80 }, (_, i) => ({
      id: `child-${i}`,
      type: "review",
      status: i === 70 ? "running" : "completed",
      description: "Review keyboard input",
      prompt: "PRIVATE PROMPT",
      result: "PRIVATE ANSWER",
    }));
  await f.hooks.get("session.start")!(f.$, {}, async () => ENGINE);
  assert.equal(f.pulses.size, 1);
  await f.flush();
  let payload = JSON.parse(f.snapshots.at(-1)!.text);
  assert.equal(payload.harbor_agents.length, 32);
  assert.equal(payload.harbor_agents[0].id, "child-70");
  assert.equal(payload.harbor_agents[0].task, "Review keyboard input");
  assert.doesNotMatch(JSON.stringify(payload), /PRIVATE/);
  assert.ok(f.snapshots.at(-1)!.text.length < 16384);
  f.$.agent.list = async () => [
    { id: "child-70", type: "review", status: "completed" },
  ];
  for (const pulse of f.pulses) pulse();
  await f.flush();
  payload = JSON.parse(f.snapshots.at(-1)!.text);
  assert.equal(
    payload.harbor_agents[0].status,
    "completed",
    "agent-only changes do not require a model usage event",
  );
  assert.equal(
    f.invalidations,
    0,
    "telemetry never invalidates the native terminal renderer",
  );
  await f.hooks.get("classic.SessionStart")!(f.$, {}, async () => ENGINE);
  assert.equal(f.pulses.size, 1, "clear/resume replaces the timer");
  await f.hooks.get("session.end")!(f.$, {}, async () => ENGINE);
  assert.equal(f.pulses.size, 0);
  const writes = f.snapshots.length;
  await f.flush();
  assert.equal(
    f.snapshots.length,
    writes,
    "ending a session discards a queued pulse",
  );
});

test("Claude child responses count measured tokens once, preserve stream results, and expose only task and tool labels", async () => {
  const f = await fixture();
  f.$.agent.list = async () => [
    {
      id: "child",
      type: "review",
      description: "Review keyboard input",
      status: "running",
    },
  ];
  const response = {
    turnId: "turn-1",
    index: 0,
    answer: "PRIVATE ANSWER",
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 10,
      model: "synthetic-model",
    },
  };
  const next = async function* () {
    yield { kind: "text", text: "native text" };
    return response;
  };
  const step = () => f.hooks.get("turn.step")!(f.$, { agentId: "child" }, next);
  for (let repeat = 0; repeat < 2; repeat++) {
    const stream = step();
    assert.deepEqual(await stream.next(), {
      done: false,
      value: { kind: "text", text: "native text" },
    });
    assert.equal((await stream.next()).value, response);
  }
  await f.flush();
  let payload = JSON.parse(f.snapshots.at(-1)!.text);
  assert.deepEqual(payload.harbor_agents[0].tokens, {
    total: 210,
    input: 190,
    output: 20,
    cached: 80,
    scope: "observed",
  });
  assert.equal(payload.harbor_agents[0].model, "synthetic-model");
  assert.equal(f.invalidations, 0);
  let release!: (value: any) => void;
  const result = { result: { text: "PRIVATE RESULT" } };
  const operation = f.hooks.get("tool.call")!(
    f.$,
    {
      agentId: "child",
      tool: "Bash",
      tool_use_id: "call",
      command: "PRIVATE COMMAND",
    },
    () => new Promise((resolve) => (release = resolve)),
  );
  await f.flush();
  payload = JSON.parse(f.snapshots.at(-1)!.text);
  assert.equal(payload.harbor_agents[0].activity, "Bash");
  assert.doesNotMatch(JSON.stringify(payload), /PRIVATE/);
  release(result);
  assert.equal(await operation, result);
  await f.flush();
  assert.equal(
    JSON.parse(f.snapshots.at(-1)!.text).harbor_agents[0].activity,
    undefined,
  );
  await f.hooks.get("classic.SessionStart")!(f.$, {}, async () => ({}));
  await f.flush();
  assert.equal(
    JSON.parse(f.snapshots.at(-1)!.text).harbor_agents[0].tokens,
    undefined,
    "clear/resume cannot reuse old usage",
  );
});

test("large Unicode agent metadata remains within the existing UTF-8 snapshot byte limit", async () => {
  const f = await fixture();
  f.$.agent.list = async () =>
    Array.from({ length: 32 }, (_, i) => ({
      id: `child-${i}-` + "x".repeat(110),
      name: "가".repeat(100),
      description: "한".repeat(160),
      status: "running",
    }));
  await f.hooks.get("session.start")!(f.$, {}, async () => ({}));
  await f.flush();
  const text = f.snapshots.at(-1)!.text;
  assert.ok(Buffer.byteLength(text, "utf8") <= 15800);
  assert.ok(JSON.parse(text).harbor_agents.length > 0);
});

test("completed native reply reserves exactly the acknowledged rows and leaves the transcript unchanged", async () => {
  const f = await fixture();
  const event = f.message();
  assert.equal(
    await f.render(event),
    ENGINE,
    "first draw stays native while rendering",
  );
  assert.equal(f.requests.length, 0, "network is outside the drawing hook");
  await f.flush();
  const tree = await f.render(event);
  assert.equal(tree.type, "Box");
  assert.equal(tree.props.height, 13);
  assert.equal(tree.props.width, 78);
  assert.equal(tree.props.children.length, descriptor.rows);
  assert.equal(
    tree.props.children[0].props.children[0].props.children[0],
    descriptor.marker.slice(0, -1) + ":0~",
  );
  assert.equal(
    tree.props.children.at(-1).props.children[0].props.children[0],
    descriptor.marker.slice(0, -1) + ":12~",
  );
  assert.equal(f.invalidations, 1);
  const { url, init } = f.requests[0];
  assert.equal(url, "http://127.0.0.1:43219/bridge/rich");
  assert.equal(init.headers.Authorization, "Bearer synthetic-hook-token");
  const body = JSON.parse(init.body);
  assert.equal(body.sessionId, "synthetic-native-session");
  assert.equal(body.cwd, "/synthetic/project");
  assert.equal(body.text, event.props.text);
  assert.equal(event.props.text, "## 설명\n\n$$\\frac{a}{b}$$");
  assert.equal(
    f.requests.length,
    1,
    "cached redraw does not duplicate the request",
  );
});

test("engine usage reaches Harbor without a Crew pane or a statusLine setting", async () => {
  const f = await fixture();
  const next = async (e: unknown) => e;
  await f.hooks.get("session.start")!(f.$, {}, next);
  assert.equal(f.requests.length, 0, "lifecycle hooks never wait on HTTP");
  await f.flush();
  assert.equal(f.requests.length, 1);
  assert.ok(f.requests[0].url.endsWith("/bridge/claude/usage"));
  const value = JSON.parse(f.requests[0].init.body);
  assert.equal(value.context_window.context_window_size, 1000000);
  assert.equal(value.context_window.current_usage.input_tokens, 51000);
  assert.equal(value.cost.total_cost_usd, 47.8);
  assert.equal(f.snapshots.length, 1);
  assert.equal(
    f.snapshots[0].path,
    "/synthetic/home/.cache/harbor/usage/claude-synthetic-native-session.json",
  );
  assert.deepEqual(JSON.parse(f.snapshots[0].text), value);
  assert.equal(f.snapshots[0].text.includes("synthetic-hook-token"), false);
  assert.equal(
    f.invalidations,
    0,
    "usage does not redraw the native transcript",
  );
  for (const tokens of [60000, 70000, 85000])
    await f.hooks.get("session.measure")!(
      f.$,
      { context: { tokens, window: 200000 }, cost: { usd: 48 } },
      next,
    );
  await f.flush();
  assert.equal(f.requests.length, 2, "a measurement burst is coalesced");
  assert.equal(
    JSON.parse(f.requests[1].init.body).context_window.current_usage
      .input_tokens,
    85000,
  );
});

test("fresh or compacted Claude usage uses a local estimate and drops old-session pending work", async () => {
  const f = await fixture();
  const args: unknown[] = [];
  f.$.session.usage = async (input?: unknown) => {
    args.push(input);
    return {
      context: {
        tokens: undefined as any,
        window: 1000000,
        breakdown: { totalTokens: 12000, rawMaxTokens: 980000 },
      },
      cost: { usd: 3 },
    };
  };
  await f.hooks.get("session.measure")!(
    f.$,
    { context: { window: 1000000 } },
    async (e: unknown) => e,
  );
  await f.flush();
  const value = JSON.parse(f.requests[0].init.body);
  assert.deepEqual(
    args,
    [{ breakdown: "summary" }],
    "no full token-count API request",
  );
  assert.equal(value.context_window.current_usage.input_tokens, 12000);
  assert.equal(value.harbor_context_estimated, true);
  assert.equal(value.harbor_compact_limit, 980000);
  await f.hooks.get("session.measure")!(
    f.$,
    { context: { tokens: 90000, window: 1000000 } },
    async (e: unknown) => e,
  );
  await f.hooks.get("session.end")!(f.$, {}, async (e: unknown) => e);
  await f.flush();
  assert.equal(f.requests.length, 1);
});

test("clear and resume refresh the identity without sending old-session measurements", async () => {
  const f = await fixture();
  const next = async (e: unknown) => e;
  await f.hooks.get("session.start")!(f.$, {}, next);
  await f.flush();
  await f.hooks.get("session.measure")!(
    f.$,
    { context: { tokens: 99000, window: 1000000 } },
    next,
  );
  f.$.session.id = async () => "synthetic-resumed-session";
  await f.hooks.get("classic.SessionStart")!(f.$, { source: "resume" }, next);
  await f.flush();
  assert.equal(f.requests.length, 2);
  assert.equal(
    JSON.parse(f.requests[1].init.body).session_id,
    "synthetic-resumed-session",
  );
  assert.equal(
    JSON.parse(f.requests[1].init.body).context_window.current_usage
      .input_tokens,
    51000,
  );
  assert.ok(
    f.snapshots[1].path.endsWith("claude-synthetic-resumed-session.json"),
  );
});

test("actual model stream passes all chunks and results unchanged and stays native until completion", async () => {
  const f = await fixture();
  const chunks = [
    { kind: "text", index: 0, text: "unfinished" },
    { kind: "thinking", index: 1, text: "opaque thought" },
    { kind: "tool", index: 2, name: "Bash", id: "tool-1" },
  ];
  const result = {
    turnId: "turn-1",
    answer: "complete",
    stopReason: "end_turn",
  };
  const stream = f.hooks.get("turn.step")!(f.$, {}, async function* () {
    for (const item of chunks) yield item;
    return result;
  });
  for (const item of chunks) {
    assert.equal((await stream.next()).value, item);
    assert.equal(await f.render(), ENGINE);
    assert.equal(
      f.deferred.length,
      0,
      "streaming text is never guessed complete",
    );
  }
  assert.equal((await stream.next()).value, result);
  assert.equal(f.invalidations, 1);
  await f.render();
  await f.flush();
  assert.equal((await f.render()).type, "Box");
});

test("closing or failing a model stream closes the original generator and restores rendering", async () => {
  const f = await fixture();
  let closed = false;
  const stream = f.hooks.get("turn.step")!(f.$, {}, async function* () {
    try {
      yield { kind: "text", index: 0, text: "partial" };
    } finally {
      closed = true;
    }
  });
  await stream.next();
  await stream.return();
  assert.equal(closed, true);
  await f.render();
  await f.flush();
  assert.equal((await f.render()).type, "Box");
});

test("completed replies keep their typesetting while a new reply streams", async () => {
  const f = await fixture();
  await f.render();
  await f.flush();
  const stream = f.hooks.get("turn.step")!(f.$, {}, async function* () {
    yield { kind: "text", index: 0, text: "new reply" };
  });
  await stream.next();
  assert.equal((await f.render()).type, "Box");
  assert.equal(
    await f.render(f.message({ requestId: "next-native-block" })),
    ENGINE,
  );
  assert.equal(f.deferred.length, 0);
  await stream.return();
});

test("narrow surfaces, summaries, other surfaces and over-limit text retain native drawing", async () => {
  const f = await fixture();
  for (const event of [
    f.message({ surface: "vscode" }),
    f.message({ props: { text: "summary", isSummary: true } }),
    f.message({ props: { text: "x".repeat(128001) } }),
    f.message({ props: { text: " \n" } }),
    f.message({ viewport: { columns: 39, rows: 40 } }),
  ])
    assert.equal(await f.render(event), ENGINE);
  assert.equal(f.deferred.length, 0);
});

test("unavailable renderer, missing credentials, invalid reservation and wrong endpoint always retain text", async () => {
  for (const setup of [
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.failed = true;
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.token = undefined;
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.url = "https://external.invalid/bridge/claude";
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.response = { enabled: false };
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.response = { ...descriptor, marker: "\u001b[2J" };
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.response = { ...descriptor, rows: 99999 };
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.response = { ...descriptor, columns: 81 };
    },
  ]) {
    const f = await fixture();
    setup(f);
    await f.render();
    await f.flush();
    assert.equal(await f.render(), ENGINE);
  }
});

test("geometry changes get a new measured reservation; stale responses cannot cross native sessions", async () => {
  const f = await fixture();
  await f.render();
  await f.flush();
  assert.equal((await f.render()).props.height, 13);
  f.response = { ...descriptor, rows: 21, columns: 58 };
  const resized = f.message({ viewport: { columns: 60, rows: 31 } });
  assert.equal(await f.render(resized), ENGINE);
  await f.flush();
  assert.equal((await f.render(resized)).props.height, 21);
  f.time = 1200;
  await f.render(resized);
  let release!: () => void;
  f.pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const updating = f.flush();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await f.hooks.get("session.start")!(f.$, {}, async () => ({}));
  release();
  await updating;
  assert.equal(await f.render(resized), ENGINE);
});

test(
  "Windows bootstrap materializes an isolated credential-free native plugin",
  { skip: process.platform !== "win32" },
  () => {
    const script =
      claudeRichBootstrap("windows") + " [Console]::Write($harborRichPath)";
    const run = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$script=[Console]::In.ReadToEnd(); . ([ScriptBlock]::Create($script))",
      ],
      { input: script, encoding: "utf8", timeout: 10000, windowsHide: true },
    );
    assert.equal(run.status, 0, run.stderr);
    const directory = realpathSync(run.stdout.trim());
    const root = realpathSync(tmpdir());
    assert.ok(directory.startsWith(root + sep));
    assert.ok(directory.split(sep).at(-1)!.startsWith("harbor-rich-"));
    try {
      for (const [file, contents] of Object.entries(claudeRichModFiles())) {
        const path = resolve(directory, file);
        assert.ok(path.startsWith(directory + sep));
        assert.equal(readFileSync(path, "utf8"), contents);
      }
      const source = readFileSync(join(directory, "hooks/register.js"), "utf8");
      assert.ok(!source.includes("synthetic-hook-token"));
      assert.ok(!source.includes("model.complete"));
      assert.ok(!source.includes("prompt.submit"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
