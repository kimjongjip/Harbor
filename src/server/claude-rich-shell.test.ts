import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import type { HostConfig } from "../shared/types.js";
import {
  bashInitialization,
  powershellInitialization,
  powershellStartup,
} from "./terminal-shell.js";
import { shellQuote } from "./ssh.js";

const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;

function run(script: string, environment: NodeJS.ProcessEnv = {}) {
  const startup = powershellStartup(script);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (done, reject) => {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          ...startup.args.filter(
            (arg) => !["-NoLogo", "-NoExit"].includes(arg),
          ),
        ],
        {
          env: { ...process.env, ...environment, ...startup.env },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      child.on("error", reject);
      child.on("close", (code) => done({ code, stdout, stderr }));
    },
  );
}

test(
  "interactive Claude wrapper installs a supported native mod, preserves native arguments and cleans only its plugin",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = resolve(".cache/claude-rich-shell");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    t.after(async () => {
      assert.ok(resolve(directory).startsWith(root + sep));
      await rm(directory, { recursive: true, force: true });
    });
    const executable = join(directory, "claude.exe");
    const capture = join(directory, "capture.json");
    const source = `using System; using System.IO; using System.Web.Script.Serialization; public class Capture {
    public static void Main(string[] args) {
      if(args.Length==1 && args[0]=="--version") { Console.WriteLine(Environment.GetEnvironmentVariable("HARBOR_TEST_VERSION")); Environment.Exit(Environment.GetEnvironmentVariable("HARBOR_TEST_VERSION_FAIL")=="1" ? 1 : 0); }
      int p=Array.IndexOf(args,"--plugin-dir"), s=Array.IndexOf(args,"--settings"), m=Array.IndexOf(args,"--mcp-config");
      string root=p>=0 ? args[p+1] : null;
      File.WriteAllText(Environment.GetEnvironmentVariable("HARBOR_TEST_CAPTURE"), new JavaScriptSerializer().Serialize(new {
        args=args, plugin=root, source=root==null ? null : File.ReadAllText(Path.Combine(root,"hooks","register.js")),
        settings=s<0 ? null : File.ReadAllText(args[s+1]), mcp=m<0 ? null : File.ReadAllText(args[m+1]),
        hook=Environment.GetEnvironmentVariable("HARBOR_HOOK_TOKEN")
      }));
      Environment.Exit(7);
    }
  }`;
    const compiled = await run(
      `Add-Type -TypeDefinition ${quote(source)} -ReferencedAssemblies System.Web.Extensions -OutputAssembly ${quote(executable)} -OutputType ConsoleApplication`,
    );
    assert.equal(compiled.code, 0, compiled.stderr);
    const environment = {
      HARBOR_TEST_CAPTURE: capture,
      HARBOR_TEST_VERSION: "2.1.295 (Claude Code)",
      HARBOR_SESSION_TOKEN: "synthetic-mcp-token",
      HARBOR_HOOK_TOKEN: "synthetic-hook-token",
      HARBOR_HOOK_URL: "http://127.0.0.1:1/bridge/claude",
      PATH: `${directory};${process.env.PATH}`,
    };
    const initialization = (hooks = true) =>
      powershellInitialization(
        {} as HostConfig,
        "shell",
        "http://127.0.0.1:1/bridge/mcp",
        undefined,
        hooks,
      );
    const cases = [
      {
        args: "--harbor-peers --model 'opus[1m]' --effort low --resume native-id",
        rich: true,
        peers: true,
      },
      {
        args: "--harbor-peers '--' '-p' '--harbor-peers'",
        rich: true,
        peers: true,
      },
      {
        args: `--resume native-id 'quoted "value" with space'`,
        rich: true,
        peers: false,
      },
      {
        args: "--harbor-peers -p 'headless prompt'",
        rich: false,
        peers: false,
      },
      {
        args: "--harbor-peers --print='headless prompt'",
        rich: false,
        peers: false,
      },
      {
        args: "--resume native-id",
        rich: false,
        peers: false,
        version: "2.1.286 (Claude Code)",
      },
      {
        args: "--resume native-id",
        rich: true,
        peers: false,
        version: "2.1.287 (Claude Code)",
      },
      {
        args: "--resume native-id",
        rich: false,
        peers: false,
        version: "unrecognized version",
      },
      { args: "--resume native-id", rich: false, peers: false, fail: "1" },
      { args: "--resume native-id", rich: false, peers: false, hooks: false },
    ];
    for (const item of cases) {
      const result = await run(
        `${initialization(item.hooks !== false)}; claude ${item.args}; exit $LASTEXITCODE`,
        {
          ...environment,
          HARBOR_TEST_VERSION: item.version || environment.HARBOR_TEST_VERSION,
          HARBOR_TEST_VERSION_FAIL: item.fail || "0",
        },
      );
      assert.equal(result.code, 7, result.stderr);
      const actual = JSON.parse(await readFile(capture, "utf8"));
      assert.equal(
        !!actual.plugin,
        item.rich,
        item.args + " / " + item.version,
      );
      assert.equal(
        actual.args.includes("--dangerously-load-development-channels"),
        item.peers,
      );
      assert.equal(
        actual.args.some((arg: string) => arg.includes("synthetic-hook-token")),
        false,
      );
      assert.equal(
        actual.args.some((arg: string) => arg.includes("synthetic-mcp-token")),
        false,
      );
      if (item.rich) {
        assert.ok(actual.source.includes("export function register"));
        assert.equal(actual.source.includes("synthetic-hook-token"), false);
        assert.equal(actual.hook, "synthetic-hook-token");
        await assert.rejects(stat(actual.plugin), { code: "ENOENT" });
        assert.ok(
          actual.args.indexOf("--plugin-dir") <
            actual.args.indexOf("--settings"),
        );
      }
      if (item.args.includes("--model")) {
        assert.equal(
          actual.args[actual.args.indexOf("--model") + 1],
          "opus[1m]",
        );
        assert.equal(actual.args[actual.args.indexOf("--effort") + 1], "low");
        assert.deepEqual(actual.args.slice(-2), ["--resume", "native-id"]);
      }
      if (item.args.includes("'--' '-p'"))
        assert.deepEqual(actual.args.slice(-3), ["--", "-p", "--harbor-peers"]);
      if (item.args.includes("quoted"))
        assert.equal(actual.args.at(-1), 'quoted "value" with space');
    }
  },
);

test("managed SSH Bash wrapper preserves native layout arguments and removes only its temporary plugin", async (t) => {
  const bash = process.env.HARBOR_TEST_BASH;
  const python = process.env.HARBOR_TEST_PYTHON;
  if (!bash || !python) {
    t.skip(
      "Set HARBOR_TEST_BASH and HARBOR_TEST_PYTHON for the isolated native Bash fixture",
    );
    return;
  }
  const root = resolve(".cache/claude-rich-bash");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "run-"));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(root + sep));
    await rm(directory, { recursive: true, force: true });
  });
  const posix = (path: string) =>
    process.platform === "win32"
      ? "/" + path[0].toLowerCase() + path.slice(2).replaceAll("\\", "/")
      : path;
  const capture = join(directory, "capture.json");
  const interpreter = shellQuote(posix(python));
  const files = {
    python3: `#!/bin/sh\nexec ${interpreter} "$@"\n`,
    curl: "#!/bin/sh\nexit 0\n",
    claude: `#!/bin/sh\nif [ "$#" = 1 ] && [ "$1" = --version ]; then printf '%s\\n' "$HARBOR_TEST_VERSION"; exit "\${HARBOR_TEST_VERSION_FAIL:-0}"; fi\nexec ${interpreter} ${shellQuote(join(directory, "capture.py").replaceAll("\\", "/"))} "$@"\n`,
    "capture.py": [
      "import json,os,pathlib,sys",
      "args=sys.argv[1:]",
      "plugin=args[args.index('--plugin-dir')+1] if '--plugin-dir' in args else None",
      "record={'args':args,'plugin':plugin,'source':(pathlib.Path(plugin)/'hooks'/'register.js').read_text(encoding='utf-8') if plugin else None,'channel':os.environ.get('HARBOR_CLAUDE_CHANNEL_ENABLED')}",
      "pathlib.Path(os.environ['HARBOR_TEST_CAPTURE']).write_text(json.dumps(record),encoding='utf-8')",
      "sys.exit(7)",
    ].join("\n"),
  };
  for (const [name, source] of Object.entries(files)) {
    await writeFile(join(directory, name), source);
    await chmod(join(directory, name), 0o700);
  }
  const full = bashInitialization({} as HostConfig, "", "shell", {
    token: "synthetic-mcp-token",
    url: "http://127.0.0.1:1/bridge/mcp",
    hook: {
      token: "synthetic-hook-token",
      url: "http://127.0.0.1:1/bridge/hook",
    },
  });
  const initialization = full.slice(0, full.lastIndexOf("stty echo icanon;"));
  assert.ok(initialization.length > 1000);
  const cases = [
    {
      args: "--harbor-peers --model 'opus[1m]' --effort low --resume native-id",
      rich: true,
      peers: "1",
    },
    { args: "--harbor-peers -- -p --harbor-peers", rich: true, peers: "1" },
    {
      args: "--harbor-peers --print='headless prompt'",
      rich: false,
      peers: "0",
    },
    {
      args: "--resume native-id",
      rich: false,
      peers: "0",
      version: "2.1.286 (Claude Code)",
    },
  ];
  for (const item of cases) {
    const script = join(directory, "run.sh");
    await writeFile(
      script,
      `export PATH=${shellQuote(posix(directory))}:"$PATH"\n${initialization}\nclaude ${item.args}\nexit $?\n`,
    );
    const result = await new Promise<{ code: number | null; stderr: string }>(
      (done, reject) => {
        const child = spawn(bash, [posix(script)], {
          env: {
            ...process.env,
            HARBOR_CODEX_MANAGED_PARENT: "",
            HARBOR_TEST_CAPTURE: capture,
            HARBOR_TEST_VERSION: item.version || "2.1.295 (Claude Code)",
            MSYS2_ARG_CONV_EXCL: "*",
          },
          windowsHide: true,
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (data) => {
          stderr += data;
        });
        child.on("error", reject);
        child.on("close", (code) => done({ code, stderr }));
      },
    );
    assert.equal(result.code, 7, result.stderr);
    const actual = JSON.parse(await readFile(capture, "utf8"));
    assert.equal(!!actual.plugin, item.rich, item.args + " / " + result.stderr);
    assert.equal(actual.channel, item.peers);
    assert.ok(!JSON.stringify(actual.args).includes("synthetic-hook-token"));
    if (item.rich) {
      assert.ok(actual.source.includes("export function register"));
      await assert.rejects(stat(actual.plugin), { code: "ENOENT" });
    }
    if (item.args.includes(" -- -p"))
      assert.deepEqual(actual.args.slice(-3), ["--", "-p", "--harbor-peers"]);
    if (item.args.includes("--model"))
      assert.equal(actual.args[actual.args.indexOf("--model") + 1], "opus[1m]");
  }
});
