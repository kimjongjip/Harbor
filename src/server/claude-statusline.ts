import { shellQuote } from "./ssh.js";

/** Official CLI statusLine data; no Mod, extra AI process, or global settings write. */
export function claudeStatuslineCommand(url: string, platform: "windows" | "posix") {
  const endpoint = new URL("/bridge/claude/usage", url).href;
  if (platform === "windows") {
    const quote = (v: string) => `'${v.replaceAll("'", "''")}'`;
    const script = `$ProgressPreference='SilentlyContinue';$u=[Text.UTF8Encoding]::new($false);[Console]::InputEncoding=$u;[Console]::OutputEncoding=$u;try {$b=[Console]::In.ReadToEnd();Invoke-WebRequest -UseBasicParsing -Method POST -Uri ${quote(endpoint)} -Headers @{Authorization=('Bearer '+$env:HARBOR_HOOK_TOKEN)} -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($b)) -TimeoutSec 2 | Out-Null} catch {}`;
    return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  }
  const script = [
    "import os,sys,urllib.request",
    "try:",
    ` r=urllib.request.Request(${JSON.stringify(endpoint)},data=sys.stdin.buffer.read(131072),headers={'Authorization':'Bearer '+os.environ['HARBOR_HOOK_TOKEN'],'Content-Type':'application/json'})`,
    " with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(r,timeout=2) as s: s.read(1024)",
    "except Exception: pass",
  ].join("\n");
  return `python3 -X utf8 -c ${shellQuote(`exec(${JSON.stringify(script)})`)}`;
}
