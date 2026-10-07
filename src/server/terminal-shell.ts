import type { HostConfig, TerminalColors } from "../shared/types.js";
import { remoteCodexCommand, shellQuote, shellDirectory } from "./ssh.js";
import { permissionHookConfig } from "./permission-hook.js";
import {
  annotationHookConfig,
  annotationHookTrustConfig,
} from "./annotation-hook.js";
import { claudeArguments, claudeHookSettings } from "./claude-hooks.js";
import { claudePeerMcpConfig } from "./claude-peer-channel.js";
import {
  codexPeerPowerShellLauncher,
  codexPeerPosixLauncher,
} from "./codex-peer-runtime.js";

export type TerminalProgram =
  "shell" | "codex" | "resume" | "claude" | "claude-resume";
export interface TerminalOptions {
  program?: TerminalProgram;
  title?: string;
  resumeThreadId?: string;
  colors?: TerminalColors;
  resumeCwd?: string;
}
export interface ShellBridge {
  token: string;
  url: string;
  hook?: { token: string; url: string };
}

/** Keep Windows' process command line short even with several native hooks. */
export function powershellStartup(script: string) {
  const loader =
    "$harborInit=$env:HARBOR_POWERSHELL_INIT;Remove-Item Env:HARBOR_POWERSHELL_INIT -ErrorAction SilentlyContinue;if($env:HARBOR_POWERSHELL_INIT_PARTS){$harborInit='';$harborParts=[int]$env:HARBOR_POWERSHELL_INIT_PARTS;Remove-Item Env:HARBOR_POWERSHELL_INIT_PARTS;for($harborPart=0;$harborPart -lt $harborParts;$harborPart++){$harborName='HARBOR_POWERSHELL_INIT_'+$harborPart;$harborInit+=[Environment]::GetEnvironmentVariable($harborName);Remove-Item ('Env:'+$harborName)};Remove-Variable harborParts,harborPart,harborName};. ([ScriptBlock]::Create($harborInit));Remove-Variable harborInit -ErrorAction SilentlyContinue";
  const env: Record<string, string> = {};
  if (script.length <= 24000) env.HARBOR_POWERSHELL_INIT = script;
  else {
    const count = Math.ceil(script.length / 12000);
    env.HARBOR_POWERSHELL_INIT_PARTS = String(count);
    for (let index = 0; index < count; index++)
      env[`HARBOR_POWERSHELL_INIT_${index}`] = script.slice(
        index * 12000,
        (index + 1) * 12000,
      );
  }
  return {
    args: [
      "-NoLogo",
      "-NoExit",
      "-EncodedCommand",
      Buffer.from(loader, "utf16le").toString("base64"),
    ],
    env,
  };
}

export function codexArguments(
  program: TerminalProgram = "codex",
  url?: string,
  resumeThreadId?: string,
) {
  return [
    ...(program === "resume"
      ? ["resume", ...(resumeThreadId ? [resumeThreadId] : ["--all"])]
      : []),
    "-c",
    "tui.notifications=true",
    "-c",
    'tui.notification_method="osc9"',
    "-c",
    'tui.notification_condition="always"',
    ...(url
      ? [
          "-c",
          `mcp_servers.harbor.url=${JSON.stringify(url)}`,
          "-c",
          "mcp_servers.harbor.enabled=true",
          "-c",
          'mcp_servers.harbor.bearer_token_env_var="HARBOR_SESSION_TOKEN"',
        ]
      : []),
  ];
}

/** This is an SSH exec request, never text typed before SSH authentication. */
export function remoteTerminalCommand(
  host: HostConfig,
  cwd: string,
  program: TerminalProgram,
  resumeThreadId?: string,
) {
  const directory = cwd ? `cd ${shellDirectory(cwd)} && ` : "";
  if (program === "shell") return `${directory}exec "\${SHELL:-/bin/sh}" -l`;
  if (program.startsWith("claude"))
    return `${directory}exec claude ${claudeArguments(
      undefined,
      resumeThreadId,
      program === "claude-resume",
    )
      .map(shellQuote)
      .join(" ")}`;
  return remoteCodexCommand(
    host,
    codexArguments(program, undefined, resumeThreadId),
    cwd,
  );
}

export function powershellInitialization(
  host: HostConfig,
  program: TerminalProgram,
  url?: string,
  resumeThreadId?: string,
  enablePermissionHook = false,
  resumeCwd?: string,
) {
  const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
  // Windows PowerShell's legacy native argument parser needs escaped inner quotes.
  const quotedArgs = [
    ...codexArguments("codex", url),
    ...(enablePermissionHook
      ? [
          "-c",
          "features.hooks=true",
          "-c",
          permissionHookConfig("windows"),
          "-c",
          annotationHookConfig("windows", "SessionStart"),
          "-c",
          annotationHookConfig("windows", "UserPromptSubmit"),
          "-c",
          annotationHookTrustConfig("windows"),
        ]
      : []),
  ].map((value) => quote(value.replaceAll('"', '\\"')));
  const args = quotedArgs.join(" ");
  const codexLauncher =
    enablePermissionHook && url ? codexPeerPowerShellLauncher() : "";
  const codexInvoke = codexLauncher
    ? `__HarborRunCodexPeers -Executable $harborExecutable -BridgeUrl ${quote(url!)} -ConfigArgs (@(${quotedArgs.join(",")}) + @($harborConfig)) -UserArgs $harborArgs`
    : `& $harborExecutable ${args} @harborConfig @harborArgs`;
  const notify = url
    ? `try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Method POST -Uri ${quote(url)} -Headers @{Authorization=('Bearer '+$env:HARBOR_SESSION_TOKEN)} -ContentType 'application/json' -Body '{"jsonrpc":"2.0","method":"notifications/harbor/terminal-state","params":{"state":"shell"}}' | Out-Null } catch {}`
    : "";
  // Some CLI versions replace root config overrides with subcommand overrides.
  // Hoist user -c options, preserving their order and the literal -- boundary.
  const normalize = `$harborConfig=@(); $harborArgs=@(); for($i=0;$i -lt $args.Count;$i++) { $value=[string]$args[$i]; if($value -eq '--') { $harborArgs += $args[$i..($args.Count-1)]; break }; if(($value -ceq '-c' -or $value -ceq '--config') -and ($i+1 -lt $args.Count)) { $i++; $harborConfig += '-c'; $harborConfig += ([string]$args[$i]).Replace('"','\\"') } elseif($value.StartsWith('--config=')) { $harborConfig += '-c'; $harborConfig += $value.Substring(9).Replace('"','\\"') } elseif($value.StartsWith('-c') -and $value.Length -gt 2) { $harborConfig += '-c'; $harborConfig += $value.Substring(2).Replace('"','\\"') } else { $harborArgs += $args[$i] } };`;
  const report = `function global:__HarborCwd { param([string]$Directory=(Get-Location).Path) if($Directory -notmatch '[\\x00-\\x1f]') { [Console]::Write(([char]27).ToString()+']1337;CurrentDir='+$Directory+[char]7) } }; $global:HarborOriginalPrompt=(Get-Item Function:prompt).ScriptBlock; function global:prompt { & $global:HarborOriginalPrompt; __HarborCwd };`;
  const reportCodex = `$harborDirectory=(Get-Location).Path; for($j=0;$j -lt $harborArgs.Count;$j++) { $v=[string]$harborArgs[$j]; if($v -eq '--') { break }; if(($v -ceq '-C' -or $v -ceq '--cd') -and $j+1 -lt $harborArgs.Count) { $j++; $harborDirectory=[string]$harborArgs[$j] } elseif($v.StartsWith('--cd=')) { $harborDirectory=$v.Substring(5) } elseif($v.StartsWith('-C') -and $v.Length -gt 2) { $harborDirectory=$v.Substring(2) } }; try { $harborDirectory=(Resolve-Path -LiteralPath $harborDirectory -ErrorAction Stop).ProviderPath; __HarborCwd $harborDirectory } catch {};`;
  const claudeUrl =
    enablePermissionHook && url
      ? new URL("/bridge/claude", url).href
      : undefined;
  const claudeSettings = claudeUrl ? claudeHookSettings(claudeUrl) : undefined;
  const claudeMcp =
    claudeUrl && url ? claudePeerMcpConfig("windows", url) : undefined;
  const claudeSetup = claudeSettings
    ? `$harborSettings=[IO.Path]::GetTempFileName(); [IO.File]::WriteAllText($harborSettings,${quote(claudeSettings)},[Text.UTF8Encoding]::new($false));`
    : "";
  const claudePeerSetup = claudeMcp
    ? `$harborPeerConfig=ConvertFrom-Json ${quote(claudeMcp)}; $harborPeerConfig.mcpServers.harbor.env.HARBOR_CLAUDE_CHANNEL_ENABLED= $(if($harborPeers){'1'}else{'0'}); $harborMcp=[IO.Path]::GetTempFileName(); [IO.File]::WriteAllText($harborMcp,($harborPeerConfig | ConvertTo-Json -Depth 12 -Compress),[Text.UTF8Encoding]::new($false)); $harborPeerArgs=@('--mcp-config',$harborMcp); if($harborPeers){$harborPeerArgs+=@('--dangerously-load-development-channels','server:harbor')};`
    : "if($harborPeers){Write-Host 'Harbor 자동 수신 연결을 사용할 수 없습니다.'};";
  const claudeArgs = claudeSettings ? "--settings $harborSettings" : "";
  const claudeWrapper = `function global:claude { __HarborCwd; $harborSettings=$null; $harborMcp=$null; $harborPeers=$false; $harborLiteral=$false; $harborClaudeArgs=@(); foreach($harborValue in $args){if(!$harborLiteral -and $harborValue -ceq '--harbor-peers'){$harborPeers=$true}else{$harborClaudeArgs+=$harborValue;if($harborValue -ceq '--'){$harborLiteral=$true}}}; if($harborClaudeArgs -contains '-p' -or $harborClaudeArgs -contains '--print' -or @($harborClaudeArgs | Where-Object { $_.StartsWith('--print=') }).Count -gt 0){$harborPeers=$false}; $harborPeerArgs=@(); try { ${claudeSetup} ${claudePeerSetup} $harborClaude=(Get-Command claude -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source); & $harborClaude @harborPeerArgs ${claudeArgs} @harborClaudeArgs } finally { $harborExit=$LASTEXITCODE; if($harborSettings) { Remove-Item -LiteralPath $harborSettings -ErrorAction SilentlyContinue }; if($harborMcp) { Remove-Item -LiteralPath $harborMcp -ErrorAction SilentlyContinue }; ${notify}; $global:LASTEXITCODE=$harborExit } };`;
  const launch = program.startsWith("claude")
    ? `${resumeCwd ? `Set-Location -LiteralPath ${quote(resumeCwd)} -ErrorAction Stop; ` : ""}claude${program === "claude-resume" ? ` --resume ${resumeThreadId ? quote(resumeThreadId) : ""}` : ""}`
    : program === "shell"
      ? ""
      : `codex${program === "resume" ? ` resume ${resumeThreadId ? quote(resumeThreadId) : "--all"}` : ""}`;
  return `${report} ${codexLauncher} function global:codex { try { ${normalize} ${reportCodex} $harborExecutable=(Get-Command ${quote(host.codexPath || "codex")} -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source); ${codexInvoke} } finally { $harborExit=$LASTEXITCODE; ${notify}; $global:LASTEXITCODE=$harborExit } }; ${claudeWrapper} ${launch}`;
}

/** Contains a per-session token; send only on authenticated SSH stdin after echo is disabled. */
export function bashInitialization(
  host: HostConfig,
  cwd: string,
  program: TerminalProgram,
  bridge: ShellBridge,
  resumeThreadId?: string,
  resumeCwd?: string,
) {
  const configArgs = [
    ...codexArguments("codex", bridge.url),
    ...(bridge.hook
      ? [
          "-c",
          "features.hooks=true",
          "-c",
          permissionHookConfig("posix"),
          "-c",
          annotationHookConfig("posix", "SessionStart"),
          "-c",
          annotationHookConfig("posix", "UserPromptSubmit"),
          "-c",
          annotationHookTrustConfig("posix"),
        ]
      : []),
  ];
  const args = configArgs.map(shellQuote).join(" ");
  const codexPeerCode = Buffer.from(codexPeerPosixLauncher()).toString(
    "base64",
  );
  const codexInvoke = bridge.hook
    ? `if command -v python3 >/dev/null 2>&1; then command python3 -X utf8 -c ${shellQuote(`import base64; exec(base64.b64decode('${codexPeerCode}'))`)} ${shellQuote(host.codexPath || "codex")} ${shellQuote(bridge.url)} $((${configArgs.length} + \${#harbor_config[@]})) ${args} "\${harbor_config[@]}" "\${harbor_args[@]}"; else command ${shellQuote(host.codexPath || "codex")} ${args} "\${harbor_config[@]}" "\${harbor_args[@]}"; fi`
    : `command ${shellQuote(host.codexPath || "codex")} ${args} "\${harbor_config[@]}" "\${harbor_args[@]}"`;
  const nestedCodex = `if [[ "\${HARBOR_CODEX_MANAGED_PARENT:-}" == 1 ]]; then command ${shellQuote(host.codexPath || "codex")} "$@"; return $?; fi;`;
  const nestedClaude =
    'if [[ "${HARBOR_CODEX_MANAGED_PARENT:-}" == 1 ]]; then command claude "$@"; return $?; fi;';
  const rc = `[[ ! -f ~/.bashrc ]] || source ~/.bashrc; PROMPT_COMMAND+=(__harbor_cwd)`;
  const interactive = `exec bash --rcfile <(printf '%s\\n' ${shellQuote(rc)}) -i`;
  const claudeUrl = bridge.hook
    ? new URL("/bridge/claude", bridge.hook.url).href
    : undefined;
  const claudeArgs = claudeArguments(claudeUrl, undefined, false, "posix")
    .map(shellQuote)
    .join(" ");
  const claudeMcp = claudeUrl
    ? (() => {
        const config = JSON.parse(claudePeerMcpConfig("posix", bridge.url));
        // Let this launch's explicit option flow through Claude to the stdio adapter.
        delete config.mcpServers.harbor.env.HARBOR_CLAUDE_CHANNEL_ENABLED;
        return JSON.stringify(config);
      })()
    : undefined;
  const claudePeerSetup = claudeMcp
    ? `local harbor_mcp harbor_peers=0 harbor_literal=0 harbor_v; local -a harbor_claude_args=() harbor_peer_args=(); for harbor_v in "$@"; do if [[ $harbor_literal == 0 && $harbor_v == --harbor-peers ]]; then harbor_peers=1; else harbor_claude_args+=("$harbor_v"); [[ $harbor_v != -- ]] || harbor_literal=1; fi; done; for harbor_v in "\${harbor_claude_args[@]}"; do case "$harbor_v" in -p|--print|--print=*) harbor_peers=0;; esac; done; if command -v python3 >/dev/null 2>&1; then harbor_mcp=$(mktemp); printf '%s' ${shellQuote(claudeMcp)} > "$harbor_mcp"; harbor_peer_args=(--mcp-config "$harbor_mcp"); if [[ $harbor_peers == 1 ]]; then harbor_peer_args+=(--dangerously-load-development-channels server:harbor); fi; HARBOR_CODEX_MANAGED_PARENT=1 HARBOR_CLAUDE_CHANNEL_ENABLED=$harbor_peers command claude "\${harbor_peer_args[@]}" ${claudeArgs} "\${harbor_claude_args[@]}"; local harbor_exit=$?; rm -f -- "$harbor_mcp"; else printf '%s\\n' 'Harbor 메시지 연결에는 python3가 필요합니다.' >&2; HARBOR_CODEX_MANAGED_PARENT=1 command claude ${claudeArgs} "\${harbor_claude_args[@]}"; local harbor_exit=$?; fi;`
    : `command claude ${claudeArgs} "$@"; local harbor_exit=$?;`;
  const claudeLaunch = `${resumeCwd ? `cd ${shellDirectory(resumeCwd)} && ` : ""}claude${program === "claude-resume" ? ` --resume ${resumeThreadId ? shellQuote(resumeThreadId) : ""}` : ""}`;
  const launch = program.startsWith("claude")
    ? `${interactive} -c ${shellQuote(`${claudeLaunch}; ${interactive}`)}`
    : program === "shell"
      ? interactive
      : `${interactive} -c ${shellQuote(`codex${program === "resume" ? ` resume ${resumeThreadId ? shellQuote(resumeThreadId) : "--all"}` : ""}; ${interactive}`)}`;
  // curl reads its Authorization header from stdin, keeping the token out of ps output.
  const notify = `if command -v curl >/dev/null 2>&1; then printf 'header = "Authorization: Bearer %s"\\n' "$HARBOR_SESSION_TOKEN" | command curl --silent --max-time 2 --config - -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","method":"notifications/harbor/terminal-state","params":{"state":"shell"}}' ${shellQuote(bridge.url)} >/dev/null 2>&1; fi`;
  const normalize =
    'local -a harbor_config=() harbor_args=(); while (( $# )); do case "$1" in --) harbor_args+=("$@"); break;; -c|--config) if (( $# >= 2 )); then harbor_config+=(-c "$2"); shift 2; else harbor_args+=("$1"); shift; fi;; --config=*) harbor_config+=(-c "${1#--config=}"); shift;; -c?*) harbor_config+=(-c "${1#-c}"); shift;; *) harbor_args+=("$1"); shift;; esac; done;';
  const hookEnvironment = bridge.hook
    ? `export HARBOR_HOOK_TOKEN=${shellQuote(bridge.hook.token)} HARBOR_HOOK_URL=${shellQuote(bridge.hook.url)}; `
    : "";
  const cwdHook = `function __harbor_cwd() { printf '\\033]1337;CurrentDir=%s\\007' "$PWD"; }; export -f __harbor_cwd;`;
  const reportCodex = `local harbor_dir="$PWD" harbor_i harbor_v; for ((harbor_i=0; harbor_i<\${#harbor_args[@]}; harbor_i++)); do harbor_v=\${harbor_args[harbor_i]}; case "$harbor_v" in --) break;; -C|--cd) ((harbor_i++)); harbor_dir=\${harbor_args[harbor_i]};; --cd=*) harbor_dir=\${harbor_v#--cd=};; -C?*) harbor_dir=\${harbor_v#-C};; esac; done; (cd -- "$harbor_dir" 2>/dev/null && __harbor_cwd);`;
  return `${cwdHook} export HARBOR_SESSION_TOKEN=${shellQuote(bridge.token)}; ${hookEnvironment}function codex() { ${nestedCodex} ${normalize} ${reportCodex} ${codexInvoke}; local harbor_exit=$?; local harbor_trace=; case $- in *x*) harbor_trace=1; set +x;; esac; ${notify}; if [[ -n "$harbor_trace" ]]; then set -x; fi; return "$harbor_exit"; }; export -f codex; function claude() { ${nestedClaude} __harbor_cwd; ${claudePeerSetup} ${notify}; return "$harbor_exit"; }; export -f claude; ${cwd ? `cd ${shellDirectory(cwd)} || exit; ` : ""}stty echo icanon; ${launch}\n`;
}
