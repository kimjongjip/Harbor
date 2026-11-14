const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const REPO = "kimjongjip/Harbor";
const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
function installationRoot(activeRoot, fallback, requested) {
  if (
    requested &&
    SHA.test(path.basename(activeRoot)) &&
    path.dirname(path.resolve(activeRoot)).toLowerCase() ===
      path.resolve(requested, ".runtime", "updates").toLowerCase()
  )
    return path.resolve(requested);
  return fallback;
}
function compareVersions(a, b) {
  if (!VERSION.test(a) || !VERSION.test(b))
    throw new Error("버전 정보를 확인하지 못했습니다.");
  const x = a.split(".").map(Number),
    y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
  return 0;
}
function releaseNotes(text, current, latest) {
  return text
    .split(/(?=^## )/m)
    .filter((section) => {
      const version = /^## (\d+\.\d+\.\d+)/.exec(section)?.[1];
      return (
        version &&
        compareVersions(version, current) > 0 &&
        compareVersions(version, latest) <= 0
      );
    })
    .join("\n")
    .slice(0, 12000);
}
async function textResponse(fetcher, url) {
  const response = await fetcher(url, {
    headers: {
      "User-Agent": "Harbor-Updater",
      Accept: "application/vnd.github+json",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw new Error(`GitHub 업데이트 조회 실패 (HTTP ${response.status})`);
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error("업데이트 응답이 너무 큽니다.");
  return text;
}
async function checkRelease(current, fetcher = fetch) {
  const commit = JSON.parse(
    await textResponse(
      fetcher,
      `https://api.github.com/repos/${REPO}/commits/main`,
    ),
  );
  if (!SHA.test(commit.sha))
    throw new Error("업데이트 커밋 정보가 올바르지 않습니다.");
  const raw = `https://raw.githubusercontent.com/${REPO}/${commit.sha}`;
  const [pkg, notes] = await Promise.all([
    textResponse(fetcher, raw + "/package.json"),
    textResponse(fetcher, raw + "/CHANGELOG.md"),
  ]);
  const metadata = JSON.parse(pkg);
  if (metadata.name !== "codex-harbor" || !VERSION.test(metadata.version))
    throw new Error("Harbor 업데이트 파일을 확인하지 못했습니다.");
  return {
    version: metadata.version,
    sha: commit.sha,
    notes: releaseNotes(notes, current, metadata.version),
    newer: compareVersions(metadata.version, current) > 0,
  };
}
async function managedRoot(installRoot) {
  const root = path.resolve(installRoot, ".runtime", "updates");
  await fs.mkdir(root, { recursive: true });
  if ((await fs.realpath(root)).toLowerCase() !== root.toLowerCase())
    throw new Error("업데이트 폴더가 다른 위치로 연결되어 있습니다.");
  return root;
}
async function removeManaged(root, target, activeRoot) {
  const resolved = path.resolve(target);
  if (
    path.dirname(resolved).toLowerCase() !== path.resolve(root).toLowerCase() ||
    !/^(?:[a-f0-9]{40}|stage-[a-f0-9-]+)$/.test(path.basename(resolved))
  )
    throw new Error("Invalid update cleanup path");
  if (
    activeRoot &&
    path.resolve(activeRoot).toLowerCase() === resolved.toLowerCase()
  )
    throw new Error("Cannot replace the running update");
  try {
    if (
      (await fs.realpath(resolved)).toLowerCase() !== resolved.toLowerCase() ||
      (await fs.lstat(resolved)).isSymbolicLink()
    )
      throw new Error("Redirected update directory");
    await fs.rm(resolved, { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function runPowerShell(args, log, progress) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        ...args,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const write = (data) => {
      const text = data.toString();
      log(text);
      if (text.includes("Building Harbor")) progress("building");
    };
    child.stdout.on("data", write);
    child.stderr.on("data", write);
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `업데이트 설치 실패 (${code}). 설치 로그를 확인해주세요.`,
            ),
          ),
    );
  });
}
const psQuote = (value) => "'" + value.replaceAll("'", "''") + "'";
async function prepareRelease({
  installRoot,
  activeRoot,
  candidate,
  progress,
  fetcher = fetch,
  run = runPowerShell,
}) {
  if (!SHA.test(candidate.sha) || !VERSION.test(candidate.version))
    throw new Error("Invalid update target");
  const root = await managedRoot(installRoot),
    destination = path.join(root, candidate.sha);
  if (path.resolve(activeRoot).toLowerCase() === destination.toLowerCase())
    throw new Error("이미 실행 중인 버전입니다.");
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !SHA.test(entry.name) ||
      entry.name === candidate.sha ||
      path.join(root, entry.name).toLowerCase() ===
        path.resolve(activeRoot).toLowerCase()
    )
      continue;
    try {
      const marker = JSON.parse(
        await fs.readFile(
          path.join(root, entry.name, ".harbor-update.json"),
          "utf8",
        ),
      );
      if (marker.sha === entry.name)
        await removeManaged(root, path.join(root, entry.name), activeRoot);
    } catch {
      /* A locked previous version can be cleaned on the next update. */
    }
  }
  // Reuse a completed download after the user saves an editor and retries.
  try {
    const marker = JSON.parse(
      await fs.readFile(path.join(destination, ".harbor-update.json"), "utf8"),
    );
    if (marker.sha === candidate.sha && marker.version === candidate.version) {
      await validatePrepared(destination, candidate.version);
      return destination;
    }
  } catch {}
  await removeManaged(root, destination, activeRoot);
  const stage = path.join(root, "stage-" + randomUUID());
  await fs.mkdir(stage);
  const archive = path.join(stage, "source.zip");
  try {
    progress("downloading");
    const response = await fetcher(
      `https://codeload.github.com/${REPO}/zip/${candidate.sha}`,
      { signal: AbortSignal.timeout(120000) },
    );
    if (!response.ok || !response.body)
      throw new Error("업데이트 다운로드에 실패했습니다.");
    const out = await fs.open(archive, "wx");
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 128 * 1024 * 1024)
          throw new Error("업데이트 파일이 너무 큽니다.");
        await out.writeFile(chunk);
      }
    } finally {
      await out.close();
    }
    progress("extracting");
    const extract = path.join(stage, "source");
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $harborZip=[IO.Compression.ZipFile]::OpenRead(${psQuote(archive)}); $harborExtract=[IO.Path]::GetFullPath(${psQuote(extract)}); try { foreach($harborEntry in $harborZip.Entries) { $harborTarget=[IO.Path]::GetFullPath((Join-Path $harborExtract $harborEntry.FullName)); if(-not $harborTarget.StartsWith($harborExtract+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid archive path' }; if(($harborEntry.ExternalAttributes -shr 16 -band 61440) -eq 40960) { throw 'Archive links are not supported' } } } finally { $harborZip.Dispose() }; Expand-Archive -LiteralPath ${psQuote(archive)} -DestinationPath ${psQuote(extract)}`;
    await run(
      ["-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      () => {},
      progress,
    );
    const source = path.join(extract, "Harbor-" + candidate.sha);
    const pkg = JSON.parse(
      await fs.readFile(path.join(source, "package.json"), "utf8"),
    );
    if (pkg.name !== "codex-harbor" || pkg.version !== candidate.version)
      throw new Error("다운로드 버전이 일치하지 않습니다.");
    if (
      (await fs.realpath(source)).toLowerCase() !== source.toLowerCase() ||
      !source.startsWith(root + path.sep) ||
      path.dirname(destination) !== root
    )
      throw new Error("Invalid extracted update path");
    await fs.rename(source, destination);
    const logFile = path.join(root, "install.log");
    await fs.writeFile(logFile, "");
    const log = (text) => require("node:fs").appendFileSync(logFile, text);
    progress("installing");
    await run(
      [
        "-File",
        path.join(destination, "Setup-Harbor.ps1"),
        "-NoLaunch",
        "-SkipShortcut",
      ],
      log,
      progress,
    );
    await validatePrepared(destination, candidate.version);
    await fs.writeFile(
      path.join(destination, ".harbor-update.json"),
      JSON.stringify({ sha: candidate.sha, version: candidate.version }),
    );
    return destination;
  } catch (error) {
    await removeManaged(root, destination, activeRoot).catch(() => {});
    throw error;
  } finally {
    await removeManaged(root, stage, activeRoot);
  }
}
async function validatePrepared(directory, version) {
  if (
    (await fs.realpath(directory)).toLowerCase() !==
    path.resolve(directory).toLowerCase()
  )
    throw new Error("Redirected update");
  const pkg = JSON.parse(
    await fs.readFile(path.join(directory, "package.json"), "utf8"),
  );
  if (pkg.name !== "codex-harbor" || pkg.version !== version)
    throw new Error("업데이트 버전 검증 실패");
  for (const file of [
    "dist/server.mjs",
    "dist/client/index.html",
    "desktop/main.cjs",
    "node_modules/electron/dist/electron.exe",
  ])
    await fs.access(path.join(directory, file));
  await preparedNode(directory);
}
async function preparedNode(directory) {
  const folders = (await fs.readdir(path.join(directory, ".runtime"))).filter(
    (name) => /^node-v\d+\.\d+\.\d+-win-x64$/.test(name),
  );
  if (folders.length !== 1)
    throw new Error("업데이트 실행 환경을 확인하지 못했습니다.");
  const file = path.join(directory, ".runtime", folders[0], "node.exe");
  if ((await fs.realpath(file)).toLowerCase() !== file.toLowerCase())
    throw new Error("Redirected runtime");
  return file;
}
class DesktopUpdater {
  constructor(options) {
    this.options = options;
    this.state = { phase: "idle", currentVersion: options.version };
  }
  publish(patch) {
    this.state = { ...this.state, error: undefined, ...patch };
    this.options.changed?.(this.state);
    return this.state;
  }
  async check() {
    if (["checking", "preparing", "restarting"].includes(this.state.phase))
      return this.state;
    this.publish({ phase: "checking" });
    try {
      this.candidate = await (this.options.check || checkRelease)(
        this.options.version,
      );
      return this.publish({
        phase: this.candidate.newer ? "available" : "current",
        version: this.candidate.version,
        notes: this.candidate.notes,
      });
    } catch (error) {
      return this.publish({ phase: "error", error: error.message });
    }
  }
  async install() {
    if (this.state.phase !== "available" || !this.candidate) return this.state;
    this.publish({ phase: "preparing", step: "downloading" });
    try {
      this.directory = await (this.options.prepare || prepareRelease)({
        ...this.options,
        candidate: this.candidate,
        progress: (step) => this.publish({ phase: "preparing", step }),
      });
      this.publish({ phase: "ready" });
      return await this.restart();
    } catch (error) {
      return this.publish({ phase: "error", error: error.message });
    }
  }
  async restart() {
    if (this.state.phase !== "ready" || !this.directory) return this.state;
    this.publish({ phase: "restarting" });
    try {
      await this.options.restart(this.directory, this.candidate);
      return this.state;
    } catch (error) {
      return this.publish({ phase: "ready", error: error.message });
    }
  }
}
module.exports = {
  DesktopUpdater,
  checkRelease,
  prepareRelease,
  compareVersions,
  releaseNotes,
  managedRoot,
  removeManaged,
  validatePrepared,
  preparedNode,
  installationRoot,
};
