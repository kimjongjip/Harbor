import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

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
