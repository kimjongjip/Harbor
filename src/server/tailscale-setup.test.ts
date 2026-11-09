import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TailscaleSetup,
  tailscaleAuthUrl,
  type SetupCommandOptions,
  type SetupExecutor,
} from "./tailscale-setup.js";

function fixture() {
  let installed = false,
    winget = true,
    time = 10000;
  let state: any = { BackendState: "NeedsLogin" };
  const calls: {
    executable: string;
    args: string[];
    options: SetupCommandOptions;
  }[] = [];
  let action: SetupExecutor = async (_executable, args) => {
    if (args[0] === "install") installed = true;
    if (args[0] === "up")
      state = {
        BackendState: "Running",
        Self: { DNSName: "pc.fixture.ts.net." },
      };
    return { code: 0, stdout: "", stderr: "" };
  };
  const setup = new TailscaleSetup({
    platform: "win32",
    tailscalePath: "fixture-tailscale.exe",
    wingetPath: "fixture-winget.exe",
    now: () => time,
    exists: (filename) =>
      filename === "fixture-tailscale.exe"
        ? installed
        : filename === "fixture-winget.exe" && winget,
    execute: async (executable, args, options) => {
      calls.push({ executable, args: [...args], options });
      if (args[0] === "status")
        return { code: 0, stdout: JSON.stringify(state), stderr: "" };
      return action(executable, args, options);
    },
  });
  return {
    setup,
    calls,
    install: () => {
      installed = true;
    },
    noWinget: () => {
      winget = false;
    },
    state: (value: any) => {
      state = value;
      time += 2000;
    },
    action: (value: SetupExecutor) => {
      action = value;
    },
    tick: () => {
      time += 2000;
    },
  };
}

async function finish(setup: TailscaleSetup) {
  for (let i = 0; i < 50; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const job = setup.getJob();
    if (job?.status === "succeeded" || job?.status === "failed") return job;
  }
  throw new Error("Fixture did not finish");
}

test("status reports install/login/connect separately and never runs a mutation", async () => {
  const f = fixture();
  assert.deepEqual(await f.setup.status(), {
    supported: true,
    installed: false,
    canInstall: true,
    loggedIn: false,
    connected: false,
    state: "not-installed",
    message: "이 PC에 Tailscale을 설치하세요.",
    downloadUrl: "https://tailscale.com/download/windows",
    job: undefined,
  });
  f.install();
  f.tick();
  const loggedOut = await f.setup.status();
  assert.equal(loggedOut.installed, true);
  assert.equal(loggedOut.state, "needs-login");
  f.state({
    BackendState: "Stopped",
    Self: { DNSName: "pc.fixture.ts.net." },
    User: { secret: "must-not-return" },
    Peer: { private: "must-not-return" },
  });
  const stopped = await f.setup.status();
  assert.equal(stopped.loggedIn, true);
  assert.equal(stopped.connected, false);
  assert.equal(stopped.origin, "https://pc.fixture.ts.net");
  assert.equal(JSON.stringify(stopped).includes("must-not-return"), false);
  f.state({ BackendState: "Running" });
  assert.equal((await f.setup.status()).connected, true);
  assert.ok(
    f.calls.every(
      (call) => call.args.join(" ") === "status --json --peers=false",
    ),
  );
});

test("install is explicit, deduplicated, fixed to the official winget package and verified on disk", async () => {
  const f = fixture();
  const first = f.setup.start("install");
  assert.equal(first.status, "running");
  assert.equal(f.setup.start("install").id, first.id);
  const done = await finish(f.setup);
  assert.equal(done.status, "succeeded");
  const install = f.calls.find((call) => call.args[0] === "install")!;
  assert.equal(install.executable, "fixture-winget.exe");
  assert.deepEqual(install.args, [
    "install",
    "--id",
    "Tailscale.Tailscale",
    "--exact",
    "--source",
    "winget",
    "--interactive",
    "--accept-source-agreements",
    "--accept-package-agreements",
    "--disable-interactivity",
  ]);
  assert.equal((await f.setup.status()).installed, true);
  f.setup.start("install");
  assert.equal((await finish(f.setup)).status, "succeeded");
  assert.equal(f.calls.filter((call) => call.args[0] === "install").length, 1);
});

test("install absence/failure has official fallback and never reports an unverified success", async () => {
  const f = fixture();
  f.noWinget();
  f.setup.start("install");
  assert.equal((await finish(f.setup)).status, "failed");
  assert.equal(f.calls.length, 0);
  const g = fixture();
  g.action(async () => ({
    code: 0,
    stdout: "credentials=do-not-expose",
    stderr: "secret",
  }));
  g.setup.start("install");
  const job = await finish(g.setup);
  assert.equal(job.status, "failed");
  assert.equal(JSON.stringify(job).includes("secret"), false);
  assert.equal((await g.setup.status()).installed, false);
});

test("login leaves an already-running account unchanged and connects stopped accounts with bare up", async () => {
  const f = fixture();
  f.install();
  f.state({ BackendState: "Running", Self: { DNSName: "pc.fixture.ts.net." } });
  f.setup.start("login");
  assert.equal((await finish(f.setup)).status, "succeeded");
  assert.equal(
    f.calls.some((call) => call.args[0] !== "status"),
    false,
  );
  f.state({ BackendState: "Stopped" });
  f.setup.start("login");
  assert.equal((await finish(f.setup)).status, "succeeded");
  assert.deepEqual(
    f.calls
      .filter((call) => call.args[0] !== "status")
      .map((call) => call.args),
    [["up"]],
  );
});

test("login exposes only complete official URLs while a background job waits", async () => {
  const f = fixture();
  f.install();
  let output: ((value: string) => void) | undefined;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.action(async (_executable, _args, options) => {
    output = options.onOutput;
    await waiting;
    f.state({ BackendState: "Running" });
    return { code: 0, stdout: "", stderr: "" };
  });
  const job = f.setup.start("login");
  for (let i = 0; i < 20 && !output; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  output!(
    "https://evil.example/a/token\nhttps://login.tailscale.com/a/partial",
  );
  assert.equal(f.setup.getJob()?.authUrl, undefined);
  output!("Token\n");
  assert.equal(
    f.setup.getJob()?.authUrl,
    "https://login.tailscale.com/a/partialToken",
  );
  assert.equal(f.setup.getJob()?.status, "waiting");
  assert.equal(f.setup.start("install").id, job.id);
  release();
  const done = await finish(f.setup);
  assert.equal(done.status, "succeeded");
  assert.equal(done.authUrl, undefined);
});

test("authentication URL validation rejects spoofed origins, credentials, fragments and non-login paths", () => {
  assert.equal(
    tailscaleAuthUrl("https://login.tailscale.com/a/abcdef"),
    "https://login.tailscale.com/a/abcdef",
  );
  assert.equal(
    tailscaleAuthUrl("https://login.tailscale.com/admin/machines"),
    "https://login.tailscale.com/admin/machines",
  );
  for (const value of [
    "http://login.tailscale.com/a/abcdef",
    "https://login.tailscale.com.evil.test/a/abcdef",
    "https://evil.test@evil.test/a/abcdef",
    "https://user@login.tailscale.com/a/abcdef",
    "https://login.tailscale.com:8080/a/abcdef",
    "https://login.tailscale.com/a/abcdef#evil",
    "https://login.tailscale.com/other",
    "javascript:alert(1)",
  ])
    assert.equal(tailscaleAuthUrl(value), undefined);
});

test("shutdown aborts only the owned helper and does not invoke down/logout or modify status", async () => {
  const f = fixture();
  f.install();
  let signal: AbortSignal | undefined;
  f.action(async (_executable, _args, options) => {
    signal = options.signal;
    await new Promise<void>((_resolve, reject) =>
      options.signal.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        { once: true },
      ),
    );
    return { code: 0, stdout: "", stderr: "" };
  });
  f.setup.start("login");
  for (let i = 0; i < 20 && !signal; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  f.setup.close();
  assert.equal(signal?.aborted, true);
  assert.equal(f.setup.getJob()?.status, "failed");
  assert.ok(
    f.calls.every(
      (call) =>
        !call.args.includes("down") &&
        !call.args.includes("logout") &&
        !call.args.includes("--reset") &&
        !call.args.includes("login"),
    ),
  );
});

test("unsupported hosts and unavailable daemon fail safely without exposing command output", async () => {
  let count = 0;
  const unsupported = new TailscaleSetup({
    platform: "linux",
    exists: () => true,
    execute: async () => {
      count++;
      throw new Error("must not run");
    },
  });
  unsupported.start("install");
  assert.equal((await finish(unsupported)).status, "failed");
  assert.equal((await unsupported.status()).supported, false);
  assert.equal(count, 0);
  const unavailable = new TailscaleSetup({
    platform: "win32",
    exists: () => true,
    execute: async () => ({
      code: 1,
      stdout: "private details",
      stderr: "secret",
    }),
  });
  const status = await unavailable.status();
  assert.equal(status.state, "unavailable");
  assert.equal(JSON.stringify(status).includes("secret"), false);
  unavailable.start("login");
  assert.equal((await finish(unavailable)).status, "failed");
});
