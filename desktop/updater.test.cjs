const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  DesktopUpdater,
  checkRelease,
  prepareRelease,
  managedRoot,
  removeManaged,
  installationRoot,
} = require("./updater.cjs");
const { handoffUpdate } = require("./update-restart.cjs");
const { spawn, fork, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { once } = require("node:events");
const { createServer } = require("node:net");
const sha = "a".repeat(40);
test("only managed update copies inherit the original install root", () => {
  const root = path.resolve(".cache/fixture-install");
  assert.equal(
    installationRoot(
      path.join(root, ".runtime", "updates", sha),
      "fallback",
      root,
    ),
    root,
  );
  assert.equal(
    installationRoot(path.resolve(".cache/unrelated"), "fallback", root),
    "fallback",
  );
});
async function fixture(t) {
  const parent = path.resolve(".cache/updater-tests");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "run-"));
  t.after(async () => {
    assert.equal(path.dirname(root), parent);
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
async function prepared(root, version = "2.0.0") {
  const directory = path.join(await managedRoot(root), sha);
  const files = {
    "package.json": JSON.stringify({ name: "codex-harbor", version }),
    "dist/server.mjs": "",
    "dist/client/index.html": "",
    "desktop/main.cjs": "",
    "node_modules/electron/dist/electron.exe": "",
    ".runtime/node-v24.15.0-win-x64/node.exe": "",
  };
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(directory, file)), {
      recursive: true,
    });
    await fs.writeFile(path.join(directory, file), content);
  }
  return directory;
}
test("check pins package and notes to a verified main commit and never downgrades", async () => {
  const urls = [];
  const fetcher = async (url) => {
    urls.push(url);
    return new Response(
      url.endsWith("/commits/main")
        ? JSON.stringify({ sha })
        : url.endsWith("/package.json")
          ? JSON.stringify({ name: "codex-harbor", version: "2.0.0" })
          : "# Changes\n## 2.0.0\n- New behavior\n## 1.0.0\n- Old behavior",
    );
  };
  const candidate = await checkRelease("1.0.0", fetcher);
  assert.equal(candidate.newer, true);
  assert.match(candidate.notes, /New behavior/);
  assert.doesNotMatch(candidate.notes, /Old behavior/);
  assert.ok(urls.slice(1).every((url) => url.includes("/" + sha + "/")));
  assert.equal((await checkRelease("3.0.0", fetcher)).newer, false);
  await assert.rejects(
    checkRelease(
      "1.0.0",
      async () => new Response(JSON.stringify({ sha: "../other" })),
    ),
    /커밋/,
  );
});
test("updates require a click; preparation failure never restarts; unsaved work defers restart", async () => {
  let checks = 0,
    builds = 0,
    restarts = 0,
    fail = true,
    dirty = true;
  const updater = new DesktopUpdater({
    version: "1.0.0",
    check: async () => {
      checks++;
      return { sha, version: "2.0.0", newer: true, notes: "- change" };
    },
    prepare: async () => {
      builds++;
      if (fail) throw Error("synthetic build failure");
      return "prepared";
    },
    restart: async () => {
      if (dirty) throw Error("save edits");
      restarts++;
    },
  });
  assert.equal(checks, 0);
  assert.equal(updater.state.phase, "idle");
  await updater.check();
  assert.equal(builds, 0);
  assert.equal(restarts, 0);
  await updater.install();
  assert.equal(updater.state.phase, "error");
  assert.equal(restarts, 0);
  fail = false;
  await updater.check();
  await updater.install();
  assert.equal(updater.state.phase, "ready");
  assert.equal(restarts, 0);
  dirty = false;
  await updater.restart();
  assert.equal(restarts, 1);
  assert.equal(builds, 2);
});
test("preparation installs in a managed copy and preserves original files", async (t) => {
  const root = await fixture(t),
    steps = [];
  await fs.writeFile(path.join(root, "personal.txt"), "keep");
  let installs = 0;
  const candidate = { sha, version: "2.0.0" };
  const result = await prepareRelease({
    installRoot: root,
    activeRoot: root,
    candidate,
    progress: (step) => steps.push(step),
    fetcher: async () => new Response("synthetic archive"),
    run: async (args) => {
      if (args[0] === "-EncodedCommand") {
        const updates = await managedRoot(root),
          stage = (await fs.readdir(updates)).find((name) =>
            name.startsWith("stage-"),
          );
        const source = path.join(updates, stage, "source", "Harbor-" + sha);
        await fs.mkdir(source, { recursive: true });
        await fs.writeFile(
          path.join(source, "package.json"),
          JSON.stringify({ name: "codex-harbor", version: "2.0.0" }),
        );
      } else {
        installs++;
        assert.ok(args.includes("-NoLaunch"));
        assert.ok(args.includes("-SkipShortcut"));
        await prepared(root);
      }
    },
  });
  assert.equal(result, path.join(root, ".runtime", "updates", sha));
  assert.equal(installs, 1);
  assert.deepEqual(steps, ["downloading", "extracting", "installing"]);
  assert.equal(
    await fs.readFile(path.join(root, "personal.txt"), "utf8"),
    "keep",
  );
  const again = await prepareRelease({
    installRoot: root,
    activeRoot: root,
    candidate,
    progress: () => {},
    fetcher: async () => {
      throw Error("no network on ready retry");
    },
  });
  assert.equal(again, result);
  await assert.rejects(
    removeManaged(await managedRoot(root), root, root),
    /cleanup path/,
  );
  await assert.rejects(
    removeManaged(await managedRoot(root), result, result),
    /running/,
  );
});
test("handoff waits for old app exit, preserves data/profile and atomically selects the new version", async (t) => {
  const root = await fixture(t),
    candidate = await prepared(root);
  let running = true,
    launched = 0,
    pauses = 0;
  const spec = {
    installRoot: root,
    parentPid: 123,
    sha,
    version: "2.0.0",
    dataDirectory: path.join(root, "private-data"),
    profileDirectory: path.join(root, "profile"),
  };
  await handoffUpdate(spec, {
    alive: () => running,
    pause: async () => {
      pauses++;
      assert.equal(launched, 0);
      running = false;
    },
    launch: async (exe, args, env) => {
      launched++;
      assert.equal(
        exe,
        path.join(candidate, "node_modules/electron/dist/electron.exe"),
      );
      assert.deepEqual(args, [candidate]);
      assert.equal(env.HARBOR_DATA_DIR, spec.dataDirectory);
      assert.equal(env.HARBOR_DESKTOP_PROFILE, spec.profileDirectory);
    },
  });
  assert.equal(pauses, 1);
  assert.equal(launched, 1);
  const pointer = JSON.parse(
    await fs.readFile(path.join(root, ".runtime/desktop-update.json"), "utf8"),
  );
  assert.equal(pointer.directory, sha);
});
test("failed launch restores the previous selection; cancelled shutdown never switches versions", async (t) => {
  const root = await fixture(t);
  await prepared(root);
  const pointer = path.join(root, ".runtime/desktop-update.json");
  const previous = '{"directory":"previous"}';
  await fs.writeFile(pointer, previous);
  const spec = {
    installRoot: root,
    parentPid: 123,
    sha,
    version: "2.0.0",
    dataDirectory: root,
    profileDirectory: root,
  };
  await assert.rejects(
    handoffUpdate(spec, {
      alive: () => true,
      timeout: 0,
      launch: async () => {
        throw Error("must not launch");
      },
    }),
    /종료되지/,
  );
  assert.equal(await fs.readFile(pointer, "utf8"), previous);
  await assert.rejects(
    handoffUpdate(spec, {
      alive: () => false,
      launch: async () => {
        throw Error("synthetic spawn failure");
      },
    }),
    /spawn/,
  );
  assert.equal(await fs.readFile(pointer, "utf8"), previous);
  await assert.rejects(
    handoffUpdate({ ...spec, sha: "../escape" }, { alive: () => false }),
    /Invalid/,
  );
});

test(
  "restart helper actually waits, launches an isolated replacement and retains its data directory",
  { skip: process.platform !== "win32", timeout: 20000 },
  async (t) => {
    const root = await fixture(t),
      candidate = await prepared(root),
      marker = path.join(root, "launched.json");
    const reservation = createServer().listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const exe = path.join(candidate, "node_modules/electron/dist/electron.exe");
    await fs.unlink(exe);
    await fs.copyFile(process.execPath, exe);
    await fs.writeFile(
      path.join(candidate, "package.json"),
      JSON.stringify({
        name: "codex-harbor",
        version: "2.0.0",
        main: "desktop/main.cjs",
      }),
    );
    await fs.writeFile(
      path.join(candidate, "desktop/main.cjs"),
      `const fs=require('node:fs'),http=require('node:http');fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,data:process.env.HARBOR_DATA_DIR,profile:process.env.HARBOR_DESKTOP_PROFILE}));const s=http.createServer((q,r)=>r.end(JSON.stringify({name:'codex-harbor',version:'2.0.0'}))).listen(${port},'127.0.0.1');setTimeout(()=>s.close(),1800);`,
    );
    const old = spawn(process.execPath, ["-e", "setTimeout(()=>{},800)"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const spec = {
      installRoot: root,
      parentPid: old.pid,
      sha,
      version: "2.0.0",
      port,
      dataDirectory: path.join(root, "personal-data"),
      profileDirectory: path.join(root, "profile"),
    };
    await fs.mkdir(spec.dataDirectory);
    await fs.writeFile(
      path.join(spec.dataDirectory, "keep.txt"),
      "personal state",
    );
    const handoff = path.join(root, ".runtime", "handoff.json");
    await fs.writeFile(handoff, JSON.stringify(spec));
    const helper = fork(path.join(__dirname, "update-restart.cjs"), [handoff], {
      execPath: process.execPath,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let output = "";
    helper.stderr.on("data", (data) => (output += data));
    const exited = once(helper, "exit");
    const [message] = await once(helper, "message");
    assert.equal(message.type, "ready");
    helper.disconnect();
    const [code] = await exited;
    assert.equal(code, 0, output);
    const launched = JSON.parse(await fs.readFile(marker, "utf8"));
    assert.equal(launched.data, spec.dataDirectory);
    assert.equal(launched.profile, spec.profileDirectory);
    const launcher = path.join(root, "Start-Harbor-Desktop.ps1");
    await fs.copyFile(path.resolve("Start-Harbor-Desktop.ps1"), launcher);
    const checked = await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        launcher,
        "-CheckOnly",
      ],
      { windowsHide: true, env: { ...process.env, HARBOR_PORT: String(port) } },
    );
    assert.equal(
      JSON.parse(checked.stdout).installedVersion,
      "2.0.0",
      "the original shortcut must select the installed update on subsequent launches",
    );
    assert.equal(
      await fs.readFile(path.join(spec.dataDirectory, "keep.txt"), "utf8"),
      "personal state",
    );
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      try {
        process.kill(launched.pid, 0);
      } catch (e) {
        if (e.code === "ESRCH") break;
        throw e;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  },
);

test(
  "download extraction rejects an archive that escapes the staging folder",
  { skip: process.platform !== "win32", timeout: 15000 },
  async (t) => {
    const root = await fixture(t),
      zip = path.join(root, "bad.zip");
    const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
    const script = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.IO.Compression.FileSystem;$z=[IO.Compression.ZipFile]::Open(${quote(zip)},'Create');$e=$z.CreateEntry('../escaped.txt');$w=[IO.StreamWriter]::new($e.Open());$w.Write('unsafe');$w.Dispose();$z.Dispose()`;
    await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true },
    );
    const bytes = await fs.readFile(zip);
    await assert.rejects(
      prepareRelease({
        installRoot: root,
        activeRoot: root,
        candidate: { sha, version: "2.0.0" },
        progress: () => {},
        fetcher: async () => new Response(bytes),
      }),
      /실패/,
    );
    const entries = await fs.readdir(await managedRoot(root));
    assert.deepEqual(entries, []);
  },
);
