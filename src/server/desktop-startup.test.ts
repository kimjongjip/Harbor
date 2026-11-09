import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const { backendVersionError } = require("../../desktop/backend-version.cjs");
const runFile = promisify(execFile);
const powershell = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const psLiteral = (value: string) => "'" + value.replaceAll("'", "''") + "'";

test("desktop reuses only a backend matching its installed version", () => {
  assert.equal(backendVersionError(null, "1.3.1"), null);
  assert.equal(
    backendVersionError(
      { ok: true, name: "another-service", version: "1.2.1" },
      "1.3.1",
    ),
    null,
  );
  assert.equal(
    backendVersionError(
      { ok: true, name: "codex-harbor", version: "1.3.1" },
      "1.3.1",
    ),
    null,
  );
  const error = backendVersionError(
    { ok: true, name: "codex-harbor", version: "1.2.1" },
    "1.3.1",
  );
  assert.ok(error instanceof Error);
  assert.match(error.message, /1\.2\.1/);
  assert.match(error.message, /1\.3\.1/);
  assert.match(error.message, /Ctrl\+Q/);
});

test("a legacy backend without a version cannot silently absorb an update", () => {
  const error = backendVersionError(
    { ok: true, name: "codex-harbor" },
    "1.3.1",
  );
  assert.ok(error instanceof Error);
  assert.match(error.message, /알 수 없음/);
});

test(
  "Windows launcher compares the selected actual package and source installations without launching",
  { skip: process.platform !== "win32" },
  async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), "harbor-startup-"));
    const install = path.join(fixture, "release", "Harbor-test");
    let version: string | undefined = "1.2.1";
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, name: "codex-harbor", version }));
    });
    try {
      await mkdir(path.join(install, "resources", "app"), { recursive: true });
      await copyFile(
        "Start-Harbor-Desktop.ps1",
        path.join(fixture, "Start-Harbor-Desktop.ps1"),
      );
      await writeFile(
        path.join(fixture, "package.json"),
        JSON.stringify({ version: "1.3.1" }),
      );
      await writeFile(
        path.join(install, "resources", "app", "package.json"),
        JSON.stringify({ version: "1.3.0" }),
      );
      await writeFile(path.join(install, "Harbor.exe"), "fixture only");
      await writeFile(
        path.join(fixture, "release", "current.json"),
        JSON.stringify({ directory: "Harbor-test", version: "9.9.9" }),
      );
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const check = async () => {
        const { stdout } = await runFile(
          powershell,
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            path.join(fixture, "Start-Harbor-Desktop.ps1"),
            "-CheckOnly",
          ],
          {
            windowsHide: true,
            env: { ...process.env, HARBOR_PORT: String(address.port) },
            timeout: 15000,
          },
        );
        return JSON.parse(stdout.trim());
      };
      assert.deepEqual(await check(), {
        installedVersion: "1.3.0",
        runningVersion: "1.2.1",
        compatible: false,
        packaged: true,
      });
      version = "1.3.0";
      assert.equal((await check()).compatible, true);
      version = undefined;
      assert.equal((await check()).compatible, false);
      await mkdir(path.join(fixture, ".runtime"));
      await writeFile(
        path.join(fixture, ".runtime", "source-install"),
        "source",
      );
      version = "1.3.1";
      assert.deepEqual(await check(), {
        installedVersion: "1.3.1",
        runningVersion: "1.3.1",
        compatible: true,
        packaged: false,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  "Windows shortcut migration follows the launcher and preserves another installation's pin",
  { skip: process.platform !== "win32" },
  async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), "harbor-shortcut-"));
    const root = path.join(fixture, "installation");
    const desktop = path.join(fixture, "Desktop");
    const pinned = path.join(fixture, "TaskBar");
    const oldExe = path.join(root, "release", "Harbor-old", "Harbor.exe");
    const otherExe = path.join(
      fixture,
      "another-installation",
      "release",
      "Harbor-old",
      "Harbor.exe",
    );
    try {
      for (const directory of [
        desktop,
        pinned,
        path.join(root, "desktop"),
        path.dirname(oldExe),
        path.dirname(otherExe),
      ])
        await mkdir(directory, { recursive: true });
      for (const file of [
        oldExe,
        otherExe,
        path.join(root, "desktop", "icon.ico"),
        path.join(root, "Start-Harbor-Desktop.ps1"),
      ])
        await writeFile(file, "fixture only");
      const pin = path.join(pinned, "Harbor — 작업 공간.lnk");
      const asciiPin = path.join(pinned, "Harbor-temporary.lnk");
      const foreignPin = path.join(pinned, "Other Harbor.lnk");
      const createPin = (file: string, target: string) =>
        `$link = $shell.CreateShortcut(${psLiteral(file)}); $link.TargetPath = ${psLiteral(target)}; $link.Save()`;
      await runFile(
        powershell,
        [
          "-NoProfile",
          "-Command",
          `$shell = New-Object -ComObject WScript.Shell; ${createPin(asciiPin, oldExe)}; ${createPin(foreignPin, otherExe)}`,
        ],
        { windowsHide: true },
      );
      await rename(asciiPin, pin);
      const originalOther = await readFile(foreignPin);
      await runFile(
        powershell,
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.resolve("scripts/create-desktop-shortcut.ps1"),
          "-HarborRoot",
          root,
          "-DesktopDirectory",
          desktop,
          "-PinnedDirectory",
          pinned,
        ],
        { windowsHide: true },
      );
      await copyFile(pin, asciiPin);
      const { stdout } = await runFile(
        powershell,
        [
          "-NoProfile",
          "-Command",
          `$shell = New-Object -ComObject WScript.Shell; $link = $shell.CreateShortcut(${psLiteral(asciiPin)}); $shellApp = New-Object -ComObject Shell.Application; $item = $shellApp.Namespace(${psLiteral(pinned)}).ParseName(${psLiteral(path.basename(asciiPin))}); @{ Target = $link.TargetPath; Arguments = $link.Arguments; WorkingDirectory = $link.WorkingDirectory; AppId = $item.ExtendedProperty('System.AppUserModel.ID') } | ConvertTo-Json -Compress`,
        ],
        { windowsHide: true },
      );
      const actual = JSON.parse(stdout);
      assert.equal(actual.Target.toLowerCase(), powershell.toLowerCase());
      assert.equal(actual.WorkingDirectory, root);
      assert.equal(actual.AppId, "org.harbor.workspace");
      assert.ok(
        actual.Arguments.endsWith(
          `-File "${path.join(root, "Start-Harbor-Desktop.ps1")}"`,
        ),
      );
      assert.deepEqual(await readFile(foreignPin), originalOther);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
