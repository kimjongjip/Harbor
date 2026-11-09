import type { HostConfig } from "../shared/types.js";

/** Only explicit UI configuration enables this. Native managed policies still apply. */
export function cliApprovalArgs(
  host: Pick<HostConfig, "cliApprovalMode">,
  agent: "codex" | "claude",
) {
  if (host.cliApprovalMode !== "full-access") return [];
  return agent === "codex"
    ? [
        "-c",
        'approval_policy="never"',
        "-c",
        'sandbox_mode="danger-full-access"',
      ]
    : ["--permission-mode", "bypassPermissions"];
}
