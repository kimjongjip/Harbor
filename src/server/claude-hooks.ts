import { z } from "zod";

export const claudeHookSchema = z.object({
  hook_event_name: z.enum(["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "StopFailure", "Notification", "PermissionRequest", "CwdChanged", "PostToolUse", "PostToolUseFailure"]),
  session_id: z.string().min(1).max(256),
  cwd: z.string().max(4096).optional(),
  notification_type: z.string().max(200).optional(),
  message: z.string().max(8000).optional(),
  tool_name: z.string().max(200).optional(),
});
export type ClaudeHookEvent = z.infer<typeof claudeHookSchema>;

/** Session-only settings; secrets stay in inherited environment, never argv. */
export function claudeHookSettings(url: string) {
  const events = claudeHookSchema.shape.hook_event_name.options;
  return JSON.stringify({ hooks: Object.fromEntries(events.map(event => [event, [{
    hooks: [{ type: "http", url, timeout: event === "PermissionRequest" ? 310 : 3,
      headers: { Authorization: "Bearer $HARBOR_HOOK_TOKEN" }, allowedEnvVars: ["HARBOR_HOOK_TOKEN"] }],
  }]])) });
}

export function claudeArguments(url?: string, sessionId?: string, resume = false) {
  return [...(url ? ["--settings", claudeHookSettings(url)] : []),
    ...(resume ? ["--resume", ...(sessionId ? [sessionId] : [])] : [])];
}
