const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  validatePrepared,
  managedRoot,
  preparedNode,
} = require("./updater.cjs");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function atomicJson(file, value) {
  const temporary = file + "." + process.pid + ".tmp";
  await fs.writeFile(temporary, JSON.stringify(value));
  await fs.rename(temporary, file);
}
async function handoffUpdate(spec, options = {}) {
  const root = await managedRoot(spec.installRoot);
  if (
    !Number.isSafeInteger(spec.parentPid) ||
    spec.parentPid < 1 ||
    !/^[a-f0-9]{40}$/.test(spec.sha)
  )
    throw new Error("Invalid restart request");
  const candidate = path.join(root, spec.sha);
  await validatePrepared(candidate, spec.version);
  const alive =
    options.alive ||
    ((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        if (e.code === "ESRCH") return false;
        throw e;
      }
    });
  options.ready?.();
  const end = Date.now() + (options.timeout ?? 120000);
  while (alive(spec.parentPid)) {
    if (Date.now() >= end)
      throw new Error(
        "기존 Harbor가 종료되지 않아 업데이트 전환을 취소했습니다.",
      );
    await (options.pause || pause)(250);
  }
  const pointer = path.join(
    spec.installRoot,
    ".runtime",
    "desktop-update.json",
  );
  const old = await fs.readFile(pointer).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  const node = await preparedNode(candidate);
  const next = {
    directory: spec.sha,
    version: spec.version,
    dataDirectory: spec.dataDirectory,
    profileDirectory: spec.profileDirectory,
    runtimeDirectory: path.basename(path.dirname(node)),
  };
  const launch =
    options.launch ||
    ((exe, args, env) => {
      const child = spawn(exe, args, {
        env,
        cwd: spec.installRoot,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      });
      return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve(child);
        });
      });
    });
  try {
    await atomicJson(pointer, next);
    const env = {
      ...process.env,
      HARBOR_INSTALL_ROOT: spec.installRoot,
      HARBOR_DATA_DIR: spec.dataDirectory,
      HARBOR_DESKTOP_PROFILE: spec.profileDirectory,
      HARBOR_NODE: node,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = await launch(
      path.join(candidate, "node_modules", "electron", "dist", "electron.exe"),
      [candidate],
      env,
    );
    if (!options.launch) {
      const until = Date.now() + 45000;
      while (Date.now() < until) {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error("새 Harbor 실행에 실패해 이전 버전으로 돌아갑니다.");
        try {
          const health = await (
            await fetch(`http://127.0.0.1:${spec.port || 4317}/api/health`, {
              signal: AbortSignal.timeout(1000),
            })
          ).json();
          if (health.name === "codex-harbor" && health.version === spec.version)
            break;
        } catch {}
        await pause(500);
      }
    }
  } catch (error) {
    if (old) {
      const temporary = pointer + ".rollback.tmp";
      await fs.writeFile(temporary, old);
      await fs.rename(temporary, pointer);
    } else
      await fs.unlink(pointer).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    if (spec.previousExecutable) {
      const env = {
        ...process.env,
        HARBOR_DATA_DIR: spec.dataDirectory,
        HARBOR_DESKTOP_PROFILE: spec.profileDirectory,
      };
      delete env.ELECTRON_RUN_AS_NODE;
      await launch(spec.previousExecutable, spec.previousArgs || [], env).catch(
        () => {},
      );
    }
    throw error;
  }
}
if (require.main === module) {
  (async () => {
    const file = process.argv[2];
    const spec = JSON.parse(await fs.readFile(file, "utf8"));
    await handoffUpdate(spec, {
      ready: () => process.send?.({ type: "ready" }),
    });
    await fs.unlink(file);
  })().catch(async (error) => {
    if (process.connected)
      process.send?.({ type: "error", error: error.message });
    if (process.argv[2])
      await fs
        .writeFile(process.argv[2] + ".error.txt", error.message)
        .catch(() => {});
    process.exitCode = 1;
  });
}
module.exports = { handoffUpdate, atomicJson };
