import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  copyFile,
  readFile,
  writeFile,
  access,
  rm,
} from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

async function fixture() {
  const parent = resolve(".cache/setup-feedback-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "run-"));
  for (const name of ["Setup-Harbor.ps1", "Setup-Harbor.cmd"])
    await copyFile(resolve(name), join(directory, name));
  const runtime = join(directory, ".runtime/node-v24.15.0-win-x64");
  await mkdir(runtime, { recursive: true });
  return { parent, directory, runtime };
}
async function run(directory: string, args: string[]) {
  const script = join(directory, "Setup-Harbor.ps1");
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      ...args,
    ],
    {
      cwd: directory,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HARBOR_SETUP_NO_PAUSE: "1" },
    },
  );
  let text = "";
  child.stdout.on("data", (chunk) => (text += chunk));
  child.stderr.on("data", (chunk) => (text += chunk));
  const [code] = await once(child, "exit");
  return { code, text };
}
const result = async (directory: string) =>
  JSON.parse(
    (
      await readFile(join(directory, ".runtime/setup-result.json"), "utf8")
    ).replace(/^\uFEFF/, ""),
  );

test(
  "fresh setup installs the actual Electron binary before declaring success, without launching Harbor",
  { skip: process.platform !== "win32", timeout: 180000 },
  async () => {
    const f = await fixture();
    try {
      await copyFile(process.execPath, join(f.runtime, "node.exe"));
      await writeFile(
        join(f.runtime, "npm.cmd"),
        "@echo off\r\necho synthetic npm %*\r\nexit /b 0\r\n",
      );
      await mkdir(join(f.directory, "dist/client"), { recursive: true });
      await writeFile(
        join(f.directory, "dist/server.mjs"),
        "// synthetic build output",
      );
      await writeFile(
        join(f.directory, "dist/client/index.html"),
        "<!doctype html>",
      );
      const electron = join(f.directory, "node_modules/electron");
      await mkdir(electron, { recursive: true });
      for (const name of [
        "package.json",
        "install.js",
        "checksums.json",
        "index.js",
      ])
        await copyFile(
          resolve("node_modules/electron", name),
          join(electron, name),
        );
      await assert.rejects(access(join(electron, "dist/electron.exe")));
      const completed = await run(f.directory, ["-NoLaunch", "-SkipShortcut"]);
      assert.equal(completed.code, 0, completed.text.slice(-4000));
      await access(join(electron, "dist/electron.exe"));
      await access(join(electron, "path.txt"));
      const state = await result(f.directory);
      assert.equal(state.status, "installed");
      assert.equal(state.installed, true);
      assert.equal(state.launchRequested, false);
      const log = await readFile(
        join(f.directory, ".runtime/setup.log"),
        "utf8",
      );
      assert.match(log, /Preparing the Electron desktop runtime/);
      assert.match(log, /\[SUCCESS\]/);
      assert.match(completed.text, /ci --include=dev/);
    } finally {
      assert.equal(dirname(f.directory), f.parent);
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test(
  "dependency failure is logged with the failed step and does not claim installation",
  { skip: process.platform !== "win32", timeout: 15000 },
  async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.runtime, "node.exe"), "fixture");
      await writeFile(
        join(f.runtime, "npm.cmd"),
        "@echo off\r\necho synthetic dependency failure\r\nexit /b 7\r\n",
      );
      const completed = await run(f.directory, ["-NoLaunch", "-SkipShortcut"]);
      assert.notEqual(completed.code, 0);
      const state = await result(f.directory);
      assert.equal(state.status, "failed");
      assert.equal(state.installed, false);
      assert.equal(state.step, "dependencies");
      assert.match(
        await readFile(join(f.directory, ".runtime/setup.log"), "utf8"),
        /Dependency installation failed/,
      );
    } finally {
      assert.equal(dirname(f.directory), f.parent);
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test(
  "CMD wrapper reports both outcomes and preserves the failure exit code",
  { skip: process.platform !== "win32", timeout: 15000 },
  async () => {
    const f = await fixture();
    const command = async () => {
      const child = spawn("cmd.exe", ["/d", "/c", "Setup-Harbor.cmd"], {
        cwd: f.directory,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HARBOR_SETUP_NO_PAUSE: "1" },
      });
      let text = "";
      child.stdout.on("data", (data) => (text += data));
      child.stderr.on("data", (data) => (text += data));
      const [code] = await once(child, "exit");
      return { code, text };
    };
    try {
      await writeFile(
        join(f.directory, "Setup-Harbor.ps1"),
        "Write-Host 'fixture setup'; exit 9",
      );
      const failed = await command();
      assert.equal(failed.code, 9);
      assert.match(failed.text, /\[FAILED\]/);
      assert.match(failed.text, /setup\.log/);
      await writeFile(join(f.directory, "Setup-Harbor.ps1"), "exit 0");
      const success = await command();
      assert.equal(success.code, 0);
      assert.match(success.text, /\[SUCCESS\]/);
      await rm(join(f.directory, "Setup-Harbor.ps1"));
      const missing = await command();
      assert.equal(missing.code, 1);
      assert.match(missing.text, /Extract the entire Harbor ZIP/);
    } finally {
      assert.equal(dirname(f.directory), f.parent);
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
