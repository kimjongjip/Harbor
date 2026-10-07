import { createHash } from "node:crypto";
import { shellQuote } from "./ssh.js";

// The native hook receives only the submitted prompt. It never reads transcripts
// or changes the prompt; its additionalContext is separate from the TUI composer.
export const powershellAnnotationHook = `$ProgressPreference='SilentlyContinue';$u=[Text.UTF8Encoding]::new($false);[Console]::InputEncoding=$u;[Console]::OutputEncoding=$u;$b=[Console]::In.ReadToEnd();try {$p=$b|ConvertFrom-Json;if($p.hook_event_name -eq 'UserPromptSubmit' -and $p.prompt -notmatch '\\[#([0-9]+) annotation\\]'){[Console]::Out.Write('{}');exit};$url=[Uri]::new([Uri]$env:HARBOR_HOOK_URL,'/bridge/annotation');$r=Invoke-WebRequest -UseBasicParsing -Method POST -Uri $url -Headers @{Authorization=('Bearer '+$env:HARBOR_HOOK_TOKEN)} -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($b)) -TimeoutSec 5;[Console]::Out.Write($r.Content)} catch {if($b -match '\\[#([0-9]+) annotation\\]'){[Console]::Out.Write('{"decision":"block","reason":"Harbor annotation connection is unavailable. Reconnect Harbor and try again."}')}else{[Console]::Out.Write('{}')}}`;

export const pythonAnnotationHook = [
  "import json,os,re,sys,urllib.request,urllib.parse",
  "b=sys.stdin.buffer.read()",
  "try:",
  " p=json.loads(b)",
  " if p.get('hook_event_name')=='UserPromptSubmit' and not re.search(r'\\[#([0-9]+) annotation\\]',p.get('prompt','')): sys.stdout.write('{}');sys.exit(0)",
  " url=urllib.parse.urljoin(os.environ['HARBOR_HOOK_URL'],'/bridge/annotation')",
  " r=urllib.request.Request(url,data=b,headers={'Authorization':'Bearer '+os.environ['HARBOR_HOOK_TOKEN'],'Content-Type':'application/json'})",
  " with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(r,timeout=5) as s: sys.stdout.buffer.write(s.read())",
  "except Exception:",
  " if re.search(rb'\\[#([0-9]+) annotation\\]',b): sys.stdout.write(json.dumps({'decision':'block','reason':'Harbor annotation connection is unavailable. Reconnect Harbor and try again.'}))",
  " else: sys.stdout.write('{}')",
].join("\n");

function annotationHookCommand(platform: "windows" | "posix") {
  return platform === "windows"
    ? `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(powershellAnnotationHook, "utf16le").toString("base64")}`
    : `python3 -c ${shellQuote(`exec(${JSON.stringify(pythonAnnotationHook)})`)}`;
}

/** Process-only hook settings. These do not modify the user's configuration. */
export function annotationHookConfig(
  platform: "windows" | "posix",
  event: "SessionStart" | "UserPromptSubmit",
) {
  const command = annotationHookCommand(platform);
  const toml = (value: string) =>
    platform === "windows" ? `'${value}'` : JSON.stringify(value);
  return `hooks.${event}=[{hooks=[{type=${toml("command")},command=${toml(command)},timeout=10,additionalContextLimit=131072}]}]`;
}

/**
 * Trust only these two application-owned, process-only definitions. Codex0.160
 * derives their identity from SHA256 of recursively sorted normalized JSON.
 * User hook state remains in its own config layer and is merged by exact key.
 * Source: openai/codex rust-v0.160.0 config/fingerprint.rs and hooks/config_rules.rs.
 */
export function annotationHookTrustConfig(platform: "windows" | "posix") {
  const source =
    platform === "windows"
      ? "C:\\<session-flags>\\config.toml"
      : "/<session-flags>/config.toml";
  const command = annotationHookCommand(platform);
  const states = ["session_start", "user_prompt_submit"].map((event) => {
    // Object insertion order below is lexicographic, matching canonical_json.
    const identity = JSON.stringify({
      event_name: event,
      hooks: [
        {
          additionalContextLimit: 131072,
          async: false,
          command,
          timeout: 10,
          type: "command",
        },
      ],
    });
    const hash = `sha256:${createHash("sha256").update(identity).digest("hex")}`;
    const key = `${source}:${event}:0:0`;
    return `${JSON.stringify(key)}={trusted_hash=${JSON.stringify(hash)}}`;
  });
  return `hooks.state={${states.join(",")}}`;
}
