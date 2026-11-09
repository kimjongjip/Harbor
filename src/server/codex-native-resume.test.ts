import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  codexPeerPowerShellLauncher,
  codexPeerPosixLauncher,
} from "./codex-peer-runtime.js";
import { powershellStartup } from "./terminal-shell.js";
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
function run(script: string, env: NodeJS.ProcessEnv) {
  const startup = powershellStartup(script);
  return new Promise<{ code: number | null; error: string }>(
    (resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          ...startup.args.filter(
            (arg) => arg !== "-NoLogo" && arg !== "-NoExit",
          ),
        ],
        {
          env: { ...process.env, ...env, ...startup.env },
          windowsHide: true,
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let error = "";
      child.stderr.on("data", (chunk) => (error += chunk.toString()));
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, error }));
    },
  );
}
test(
  "shared-daemon Codex resume preserves native routing instead of starting a second writer",
  { skip: process.platform !== "win32", timeout: 30000 },
  async () => {
    const root = resolve(".cache/native-resume-tests");
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "run-")),
      executable = join(directory, "codex.exe"),
      capture = join(directory, "argv.jsonl");
    const reports: any[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        reports.push(JSON.parse(body));
        res.end("{}");
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const source = `using System; using System.IO; using System.Web.Script.Serialization; public class Capture { public static void Main(string[] args) { File.AppendAllText(Environment.GetEnvironmentVariable("HARBOR_CAPTURE"),new JavaScriptSerializer().Serialize(args)+"\\n"); if(args.Length==1 && args[0]=="--help") Console.WriteLine("--no-daemon --remote-auth-token-env"); if(args.Length==1 && args[0]=="--version") Console.WriteLine("codex-cli 0.163.0"); } }`;
    try {
      const compiled = await run(
        `Add-Type -TypeDefinition ${quote(source)} -ReferencedAssemblies System.Web.Extensions -OutputAssembly ${quote(executable)} -OutputType ConsoleApplication`,
        {},
      );
      assert.equal(compiled.code, 0, compiled.error);
      const result = await run(
        `${codexPeerPowerShellLauncher()}\n__HarborRunCodexPeers -Executable ${quote(executable)} -BridgeUrl 'http://127.0.0.1:${(server.address() as any).port}/bridge/mcp' -ConfigArgs @('-c','notice=true') -UserArgs @('resume','synthetic-shared-thread','--all')`,
        {
          HARBOR_CAPTURE: capture,
          HARBOR_SESSION_TOKEN: "synthetic-test-token",
        },
      );
      assert.equal(result.code, 0, result.error);
      const calls = readFileSync(capture, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(calls.at(-1), [
        "-c",
        "notice=true",
        "resume",
        "synthetic-shared-thread",
        "--all",
      ]);
      assert.equal(
        calls.some(
          (args) => args.includes("app-server") || args.includes("--remote"),
        ),
        false,
      );
      assert.equal(reports.at(-1).delivery, "poll");
      assert.match(
        codexPeerPosixLauncher(),
        /if resume and '--no-daemon' in help_text/,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      assert.ok(resolve(directory).startsWith(root + sep));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
