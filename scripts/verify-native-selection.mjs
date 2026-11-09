// Real native CLI renderer, synthetic saved conversation, loopback-only provider.
// No user sessions, SSH servers, credentials or external model requests.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { chromium } from "playwright";
import pty from "node-pty";
import http from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const executable =
  process.env.HARBOR_NATIVE_CODEX ||
  execFileSync("where.exe", ["codex.exe"], {
    encoding: "utf8",
    windowsHide: true,
  })
    .trim()
    .split(/\r?\n/)[0];
const dir = mkdtempSync(resolve(".cache/native-selection-"));
const home = join(dir, "home"),
  cwd = join(dir, "project"),
  sessions = join(home, "sessions", "2026", "10", "27");
mkdirSync(cwd, { recursive: true });
mkdirSync(sessions, { recursive: true });
execFileSync("git", ["init", "--quiet", cwd], { windowsHide: true });
const id = randomUUID(),
  turn = randomUUID(),
  timestamp = "2026-10-27T01:00:00.000Z";
const answer = Array.from(
  { length: 100 },
  (_, i) =>
    `ROW ${String(i).padStart(3, "0")} This is a synthetic Korean 한글 selection test, with unique content ${i}.`,
).join("\n\n");
const records = [
  {
    type: "session_meta",
    payload: {
      id,
      timestamp,
      cwd,
      originator: "codex_cli_rs",
      cli_version: "0.162.1",
      source: "cli",
      model_provider: "fixture",
      base_instructions: { text: "Synthetic fixture only" },
    },
  },
  {
    type: "event_msg",
    payload: {
      type: "task_started",
      turn_id: turn,
      model_context_window: 200000,
    },
  },
  {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Show the synthetic numbered fixture." },
      ],
    },
  },
  {
    type: "event_msg",
    payload: {
      type: "user_message",
      message: "Show the synthetic numbered fixture.",
      images: [],
      local_images: [],
    },
  },
  {
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: answer }],
      phase: "final_answer",
    },
  },
  {
    type: "event_msg",
    payload: { type: "agent_message", message: answer, phase: "final_answer" },
  },
  {
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: turn,
      last_agent_message: answer,
    },
  },
].map((record) => ({ timestamp, ...record }));
writeFileSync(
  join(sessions, `rollout-2026-10-27T01-00-00-${id}.jsonl`),
  records.map((r) => JSON.stringify(r)).join("\n") + "\n",
);
let inference = 0;
const server = http
  .createServer((req, res) => {
    if (req.method === "POST") inference++;
    res.writeHead(req.method === "POST" ? 503 : 200, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify({ data: [{ id: "gpt-5.4", object: "model" }] }));
  })
  .listen(0, "127.0.0.1");
await once(server, "listening");
writeFileSync(
  join(home, "config.toml"),
  `model="gpt-5.4"\nmodel_provider="fixture"\ncheck_for_update_on_startup=false\napproval_policy="never"\nsandbox_mode="read-only"\n[model_providers.fixture]\nname="Local synthetic fixture"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[projects.${JSON.stringify(cwd.replaceAll("\\", "/"))}]\ntrust_level="trusted"\n`,
);
await build({
  stdin: {
    contents: `import {Terminal} from '@xterm/xterm';import {installTerminalSelection} from './src/client/terminalSelection.ts';const term=new Terminal({cols:110,rows:32,scrollback:500,fontSize:15,allowProposedApi:true});term.open(document.getElementById('mount'));window.term=term;window.notices=[];window.controller=installTerminalSelection(document.getElementById('mount'),term,()=>true,{onNotice:message=>notices.push(message)});window.selected=()=>controller.getSelection()??term.getSelection();term.onData(data=>window.nativeInput(data));window.write=data=>new Promise(r=>term.write(data,r));window.screen=()=>Array.from({length:term.rows},(_,i)=>term.buffer.active.getLine(term.buffer.active.viewportY+i)?.translateToString(true)||'');`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  outfile: join(dir, "fixture.js"),
});
writeFileSync(
  join(dir, "index.html"),
  `<link rel="stylesheet" href="../../node_modules/@xterm/xterm/css/xterm.css"><style>body{margin:10px}#mount{width:1100px;height:700px}</style><div id="mount"></div><script src="fixture.js"></script>`,
);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
let child,
  closed = false,
  queue = Promise.resolve(),
  raw = "";
await page.exposeFunction("nativeInput", (data) => {
  if (child && !closed) child.write(data);
});
try {
  await page.goto("file:///" + join(dir, "index.html").replaceAll("\\", "/"));
  await page.waitForFunction(() => window.term);
  const env = {
    ...process.env,
    CODEX_HOME: home,
    TERM: "xterm-256color",
    OPENAI_API_KEY: "synthetic-local-only",
  };
  delete env.CHATGPT_AUTH_TOKEN;
  delete env.HARBOR_SESSION_TOKEN;
  delete env.HARBOR_BRIDGE_URL;
  child = pty.spawn(executable, ["resume", "--no-daemon", id, "-C", cwd], {
    env,
    cwd,
    cols: 110,
    rows: 32,
    name: "xterm-256color",
  });
  child.onExit(() => (closed = true));
  child.onData((data) => {
    raw += data;
    queue = queue
      .then(() => page.evaluate((data) => write(data), data))
      .catch(() => {});
  });
  let trusted = false;
  for (let i = 0; i < 100; i++) {
    await page.waitForTimeout(200);
    const lines = await page.evaluate(() => screen());
    if (!trusted && lines.some((l) => l.includes("Trust this folder?"))) {
      trusted = true;
      child.write("\r");
    }
    if (lines.some((l) => l.includes("ROW 099"))) break;
    if (i === 99) {
      writeFileSync(join(dir, "startup.txt"), lines.join("\n"));
      throw Error("Native startup did not display fixture " + dir);
    }
  }
  await page.waitForTimeout(600);
  if (
    (await page.evaluate(() => screen())).some((l) =>
      l.includes("Set up the Codex agent sandbox"),
    )
  ) {
    child.write("\x1b");
    await page.waitForTimeout(600);
  }
  console.log(
    JSON.stringify({
      dir,
      mode: await page.evaluate(() => ({
        type: term.buffer.active.type,
        baseY: term.buffer.active.baseY,
        mouse: term.modes.mouseTrackingMode,
      })),
      inference,
    }),
  );
  const box = await page.locator(".xterm-screen").boundingBox(),
    height = box.height / 32,
    width = box.width / 110;
  const lines = await page.evaluate(() => screen());
  writeFileSync(join(dir, "screen-before.txt"), lines.join("\n"));
  const indices = lines
      .map((l, i) => (l.includes("ROW ") ? i : -1))
      .filter((i) => i >= 0),
    start = indices.at(-2),
    end = indices[1];
  await page.mouse.move(box.x + 1, box.y + height * (start + 0.5));
  await page.mouse.down();
  await page.mouse.move(box.x + 1, box.y + height * (end + 0.5), { steps: 10 });
  const before = await page.evaluate(() => ({
    native: term.getSelection(),
    selected: selected(),
  }));
  await page.mouse.wheel(0, -120);
  const immediate = await page.evaluate(() => ({
    native: term.getSelection(),
    selected: selected(),
    notices,
  }));
  await page.waitForTimeout(2000);
  const after = await page.evaluate(() => ({
    native: term.getSelection(),
    selected: selected(),
    notices,
    screen: screen(),
  }));
  const steps = [];
  for (const delta of [-120, -120, -120, -120, -120, -120, 120, 120]) {
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(180);
    steps.push(
      await page.evaluate(() => ({
        native: term.getSelection(),
        selected: selected(),
        notices: [...notices],
      })),
    );
  }
  await page.mouse.up();
  writeFileSync(
    join(dir, "result.json"),
    JSON.stringify({ before, immediate, after, steps }, null, 2),
  );
  writeFileSync(join(dir, "raw.txt"), raw);
  console.log(
    JSON.stringify({
      before: before.selected.length,
      immediateNative: immediate.native.length,
      immediateStored: immediate.selected.length,
      afterNative: after.native.length,
      afterStored: after.selected.length,
      notices: after.notices,
      inference,
      steps: steps.map((s) => ({
        native: s.native.length,
        selected: s.selected.length,
        notices: s.notices.length,
      })),
    }),
  );
  {
    assert.ok(
      immediate.native.length > 0,
      "wheel must not erase the highlight while waiting for the CLI",
    );
    const last = Number(
      [...before.selected.matchAll(/ROW (\d{3})/g)].at(-1)[1],
    );
    for (const state of [after, ...steps]) {
      assert.deepEqual(state.notices, []);
      assert.ok(state.native.length > 0);
      const ids = [...state.selected.matchAll(/ROW (\d{3})/g)].map((m) =>
        Number(m[1]),
      );
      assert.deepEqual(
        ids,
        Array.from({ length: last - ids[0] + 1 }, (_, i) => ids[0] + i),
      );
      assert.deepEqual(
        state.selected
          .replaceAll("\r\n", "\n")
          .split("\n")
          .filter((s) => s.trim()),
        ids.map(
          (i) =>
            "  " +
            `ROW ${String(i).padStart(3, "0")} This is a synthetic Korean 한글 selection test, with unique content ${i}.`,
        ),
      );
    }
    assert.ok(
      steps[5].selected.length > before.selected.length,
      "selection must extend across actual native pages",
    );
    assert.equal(inference, 0);
    console.log(JSON.stringify({ nativeAssertionsPassed: true }));
  }
  await page.screenshot({ path: join(dir, "selection.png") });
} finally {
  if (child && !closed) {
    child.write("\x04");
    for (let i = 0; i < 30 && !closed; i++)
      await new Promise((r) => setTimeout(r, 100));
    if (!closed) child.kill();
  }
  child?._agent?.inSocket?.destroy();
  child?._agent?.outSocket?.destroy();
  child?._agent?._conoutSocketWorker?.dispose();
  await browser.close();
  server.closeAllConnections();
  server.close();
}
