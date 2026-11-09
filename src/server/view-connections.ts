import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const viewConnectionEvent = z.object({
  terminalId: z.string().uuid().optional(),
  reason: z.enum([
    "open-timeout",
    "replay-timeout",
    "heartbeat-timeout",
    "socket-close",
    "socket-error",
    "restore-failed",
    "manual",
    "ready",
    "bootstrap-failed",
    "slow-client",
    "slow-replay",
    "snapshot-failed",
    "snapshot-timeout",
    "pong-timeout",
  ]),
  code: z.number().int().min(0).max(4999).optional(),
});
/** Diagnostic codes only: never paths, addresses, token, exception text or output. */
export class ViewConnections {
  private file: string;
  private windowAt = 0;
  private count = 0;
  constructor(directory: string) {
    this.file = join(directory, "view-connections.jsonl");
  }
  trace(input: z.infer<typeof viewConnectionEvent>) {
    const parsed = viewConnectionEvent.safeParse(input);
    if (!parsed.success) return;
    const event = parsed.data;
    const now = Date.now();
    if (now - this.windowAt > 60000) {
      this.windowAt = now;
      this.count = 0;
    }
    if (++this.count > 300) return;
    try {
      try {
        if (statSync(this.file).size > 256 * 1024)
          writeFileSync(this.file, "", { mode: 0o600 });
      } catch {}
      appendFileSync(this.file, JSON.stringify({ at: now, ...event }) + "\n", {
        mode: 0o600,
      });
    } catch {
      /* Diagnostics must not interrupt sessions. */
    }
  }
}
