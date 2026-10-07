import { z } from "zod";
import { shellQuote } from "./ssh.js";

export const claudeHookSchema = z.object({
  hook_event_name: z.enum([
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "Stop",
    "StopFailure",
    "Notification",
    "PermissionRequest",
    "CwdChanged",
    "PostToolUse",
    "PostToolUseFailure",
  ]),
  session_id: z.string().min(1).max(256),
  cwd: z.string().max(4096).optional(),
  notification_type: z.string().max(200).optional(),
  message: z.string().max(8000).optional(),
  tool_name: z.string().max(200).optional(),
  prompt: z.string().max(128000).optional(),
});
export type ClaudeHookEvent = z.infer<typeof claudeHookSchema>;

/** Claude does not run HTTP hooks for SessionStart, including resume and clear. */
export function claudeSessionStartCommand(
  url: string,
  platform: "windows" | "posix",
) {
  if (platform === "windows") {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const script = `$ProgressPreference='SilentlyContinue';$u=[Text.UTF8Encoding]::new($false);[Console]::InputEncoding=$u;[Console]::OutputEncoding=$u;$b=[Console]::In.ReadToEnd();try {Invoke-WebRequest -UseBasicParsing -Method POST -Uri ${quote(url)} -Headers @{Authorization=('Bearer '+$env:HARBOR_HOOK_TOKEN)} -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($b)) -TimeoutSec 3 | Out-Null} catch {[Console]::Error.WriteLine('Harbor session connection unavailable.')}[Console]::Out.Write('{}')`;
    return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  }
  const script = [
    "import os,sys,urllib.request",
    "b=sys.stdin.buffer.read()",
    "try:",
    ` r=urllib.request.Request(${JSON.stringify(url)},data=b,headers={'Authorization':'Bearer '+os.environ['HARBOR_HOOK_TOKEN'],'Content-Type':'application/json'})`,
    " with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(r,timeout=3) as s: s.read(131072)",
    "except Exception: sys.stderr.write('Harbor session connection unavailable.\\n')",
    "sys.stdout.write('{}')",
  ].join("\n");
  return `python3 -X utf8 -c ${shellQuote(`exec(${JSON.stringify(script)})`)}`;
}

/** Session-only settings; secrets stay in inherited environment, never argv. */
export function claudeHookSettings(
  url: string,
  platform: "windows" | "posix" = process.platform === "win32"
    ? "windows"
    : "posix",
) {
  const events = claudeHookSchema.shape.hook_event_name.options;
  return JSON.stringify({
    hooks: Object.fromEntries(
      events.map((event) => [
        event,
        [
          {
            hooks: [
              event === "SessionStart"
                ? {
                    type: "command",
                    command: claudeSessionStartCommand(url, platform),
                    timeout: 10,
                  }
                : {
                    type: "http",
                    url,
                    timeout: event === "PermissionRequest" ? 310 : 3,
                    headers: { Authorization: "Bearer $HARBOR_HOOK_TOKEN" },
                    allowedEnvVars: ["HARBOR_HOOK_TOKEN"],
                  },
            ],
          },
        ],
      ]),
    ),
  });
}

export function claudeArguments(
  url?: string,
  sessionId?: string,
  resume = false,
  platform?: "windows" | "posix",
) {
  return [
    ...(url ? ["--settings", claudeHookSettings(url, platform)] : []),
    ...(resume ? ["--resume", ...(sessionId ? [sessionId] : [])] : []),
  ];
}
