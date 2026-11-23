import test from "node:test";
import { startRuntimeDiagnostics } from "./runtime-diagnostics.js";
import { appendFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("on-demand memory report exports only numeric fields from current process samples", async () => {
  const root = resolve(".cache/runtime-tests");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "report-"));
  const runtime = startRuntimeDiagnostics(dir);
  try {
    await appendFile(
      join(dir, "runtime-events.jsonl"),
      JSON.stringify({
        event: "sample",
        at: Date.now(),
        pid: process.pid,
        rss: 12345,
        heapUsed: 123,
        private: "PRIVATE_SESSION_DATA",
      }) + "\n",
    );
    const snapshot = runtime.snapshot();
    assert.ok(snapshot.samples.some((s) => s.rss === 12345));
    assert.ok(snapshot.rss > 0);
    assert.equal(
      JSON.stringify(snapshot).includes("PRIVATE_SESSION_DATA"),
      false,
    );
  } finally {
    runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("fatal diagnostics retain numeric memory and exit evidence without swallowing failure or logging private error text", async () => {
  const root = resolve(".cache/runtime-tests");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "run-"));
  try {
    const source = `import {startRuntimeDiagnostics} from './src/server/runtime-diagnostics.ts'; startRuntimeDiagnostics(${JSON.stringify(dir)}); setTimeout(()=>{throw new Error('PRIVATE_TRANSCRIPT_AND_TOKEN');},10);`;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source],
      { windowsHide: true, stdio: "ignore" },
    );
    const [code] = await once(child, "exit");
    assert.equal(code, 1);
    const log = await readFile(join(dir, "runtime-events.jsonl"), "utf8");
    assert.doesNotMatch(
      log,
      /PRIVATE_TRANSCRIPT_AND_TOKEN|argv|password|environment|stack/,
    );
    const entries = log
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      entries.map((e) => e.event),
      ["start", "fatal", "exit"],
    );
    assert.ok(
      entries.every((e) => e.rss > 0 && e.heapUsed > 0 && e.pid === child.pid),
    );
    assert.equal(entries[1].name, "Error");
    assert.equal(entries[2].code, 1);
  } finally {
    assert.ok(dir.startsWith(root + sep));
    await rm(dir, { recursive: true, force: true });
  }
});
