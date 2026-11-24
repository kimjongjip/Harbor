import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentProvider } from "../shared/agent-provider.js";
import type { HistoryPage, HistoryThread } from "../shared/history.js";
import type { HostConfig } from "../shared/types.js";
import { hostFingerprint } from "./durable-ssh.js";

// The private registry contains only IDs confirmed by the verification run that created them.
// Real projects and conversations may legitimately have "test" in their title or folder.
export function verificationHistoryKey(
  host: HostConfig,
  provider: AgentProvider,
  id: string,
) {
  const account = host.kind === "local" ? "local" : hostFingerprint(host);
  return createHash("sha256")
    .update(JSON.stringify([account, provider, id]))
    .digest("hex");
}

export class HistoryVisibility {
  private readonly file: string;
  private modified = "";
  private checkAfter = 0;
  private hidden = new Set<string>();
  constructor(directory: string) {
    this.file = join(directory, "hidden-verification-history.json");
  }
  visible(host: HostConfig, provider: AgentProvider, id: string) {
    const now = Date.now();
    if (now >= this.checkAfter) {
      this.checkAfter = now + 1000;
      try {
        const stat = statSync(this.file);
        const stamp = stat.mtimeMs + ":" + stat.size;
        if (stamp !== this.modified) {
          const value = JSON.parse(readFileSync(this.file, "utf8"));
          if (
            value?.version === 1 &&
            Array.isArray(value.records) &&
            value.records.every(
              (entry: unknown) =>
                typeof entry === "string" && /^[0-9a-f]{64}$/.test(entry),
            )
          ) {
            this.hidden = new Set(value.records);
            this.modified = stamp;
          } else {
            this.hidden.clear();
            this.modified = "";
          }
        }
      } catch {
        this.hidden.clear();
        this.modified = "";
      }
    }
    return (
      !this.hidden.size ||
      !this.hidden.has(verificationHistoryKey(host, provider, id))
    );
  }
}

export async function visibleHistoryPage(
  cursor: string | undefined,
  read: (cursor?: string) => Promise<HistoryPage>,
  visible: (thread: HistoryThread) => boolean,
): Promise<HistoryPage> {
  const seen = new Set([cursor]);
  for (;;) {
    const page = await read(cursor);
    const data = page.data.filter(visible);
    if (data.length || !page.data.length || !page.nextCursor)
      return { ...page, data };
    cursor = page.nextCursor;
    if (seen.has(cursor))
      throw Error("대화 기록의 다음 페이지를 확인할 수 없습니다.");
    seen.add(cursor);
  }
}
