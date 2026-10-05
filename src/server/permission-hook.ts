import { shellQuote } from "./ssh.js";

// Stable definitions allow Codex to review the exact hook once. Session secrets
// and the changing loopback port live only in the inherited process environment.
export const powershellPermissionHook =
  "$ProgressPreference='SilentlyContinue';$u=[Text.UTF8Encoding]::new($false);[Console]::InputEncoding=$u;[Console]::OutputEncoding=$u;try {$b=[Console]::In.ReadToEnd();$r=Invoke-WebRequest -UseBasicParsing -Method POST -Uri $env:HARBOR_HOOK_URL -Headers @{Authorization=('Bearer '+$env:HARBOR_HOOK_TOKEN)} -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($b)) -TimeoutSec 605;[Console]::Out.Write($r.Content)} catch {[Console]::Out.Write('{}')}";

export const pythonPermissionHook = [
  "import os,sys,urllib.request",
  "try:",
  " r=urllib.request.Request(os.environ['HARBOR_HOOK_URL'],data=sys.stdin.buffer.read(),headers={'Authorization':'Bearer '+os.environ['HARBOR_HOOK_TOKEN'],'Content-Type':'application/json'})",
  " with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(r,timeout=605) as s: sys.stdout.buffer.write(s.read())",
  "except Exception: sys.stdout.write('{}')",
].join("\n");

/** Additive session config; native Codex still requires review/trust of this hook. */
export function permissionHookConfig(platform: "windows" | "posix") {
  const command =
    platform === "windows"
      ? `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(powershellPermissionHook, "utf16le").toString("base64")}`
      : `python3 -c ${shellQuote(`exec(${JSON.stringify(pythonPermissionHook)})`)}`;
  // Literal TOML strings avoid PowerShell 5's native argv parser interpreting
  // embedded double quotes as argument boundaries when the command has spaces.
  const toml = (value: string) =>
    platform === "windows" ? `'${value}'` : JSON.stringify(value);
  return `hooks.PermissionRequest=[{matcher=${toml("*")},hooks=[{type=${toml("command")},command=${toml(command)},timeout=610,statusMessage=${toml("Harbor: approval requested")}}]}]`;
}
