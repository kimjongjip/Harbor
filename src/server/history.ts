import { RpcClient, RpcResponseSizeError } from "./rpc.js";
import { processCommand } from "./ssh.js";
import { sshCodexChannel } from "./ssh-connect.js";
import { historyItem } from "./history-items.js";
import { historyActivities } from "./history-activity.js";
import type { HostConfig, MessageItem } from "../shared/types.js";
import { researchEfforts } from "../shared/research.js";
import type { ResearchEffort, ResearchModel } from "../shared/research.js";
import type {
  HistoryThread,
  HistoryPage,
  HistoryDetail,
  HistoryReadOptions,
} from "../shared/history.js";

interface Reader {
  call(method: string, params: unknown, timeout?: number): Promise<any>;
  stop(): void;
  alive: boolean;
}
type Connect = (host: HostConfig, password?: string) => Promise<Reader>;
interface Lease {
  key: string;
  promise: Promise<Reader>;
  busy: number;
  timer?: NodeJS.Timeout;
}
const bounded = (value: unknown, max: number) =>
  typeof value === "string" ? value.slice(0, max) : "";
export function historyThread(hostId: string, raw: any): HistoryThread {
  return {
    id: String(raw.id),
    hostId,
    title: bounded(raw.name || raw.preview || "제목 없는 대화", 180),
    cwd: bounded(raw.cwd, 4096),
    preview: bounded(raw.preview, 300),
    updatedAt: Number(raw.updatedAt || raw.createdAt || 0) * 1000,
    source:
      typeof raw.source === "string"
        ? raw.source
        : bounded(raw.source?.type, 40),
    active: raw.status?.type === "active",
  };
}
async function connect(host: HostConfig, password?: string): Promise<Reader> {
  const client = new RpcClient();
  client.on("request", (message) =>
    client.rejectRequest(
      message.id,
      "History browsing does not execute agent requests.",
    ),
  );
  try {
    if (host.kind === "ssh" && password) {
      const { channel, connection } = await sshCodexChannel(
        host,
        password,
        false,
      );
      await client.startChannel(channel, connection);
    } else {
      const process = processCommand(host, false);
      await client.start(process.command, process.args);
    }
    return client;
  } catch (error) {
    client.stop();
    throw error;
  }
}

/** Reads the host's Codex index across projects, never starts/resumes a conversation. */
export class History {
  private leases = new Map<string, Lease>();
  private pageSizes = new Map<string, number>();
  private oversizedTurns = new Map<string, string>();
  private stopped = false;
  constructor(
    private readonly create: Connect = connect,
    private readonly idleMs = 60_000,
  ) {}
  private async using<T>(
    host: HostConfig,
    password: string | undefined,
    read: (client: Reader) => Promise<T>,
  ): Promise<T> {
    if (this.stopped) throw new Error("대화 기록 연결이 종료되었습니다.");
    const key = JSON.stringify([
      host.kind,
      host.address,
      host.username,
      host.port,
      host.identityFile,
      host.codexPath,
    ]);
    let lease = this.leases.get(host.id);
    if (lease && lease.key !== key) {
      this.close(host.id);
      lease = undefined;
    }
    if (!lease) {
      lease = { key, promise: this.create(host, password), busy: 0 };
      this.leases.set(host.id, lease);
    }
    clearTimeout(lease.timer);
    lease.busy++;
    try {
      const client = await lease.promise;
      if (this.stopped || this.leases.get(host.id) !== lease) {
        client.stop();
        throw new Error("서버 설정이 변경되었습니다. 다시 불러오세요.");
      }
      if (!client.alive)
        throw new Error("대화 기록 연결이 끊겼습니다. 새로고침하세요.");
      return await read(client);
    } catch (error) {
      if (this.leases.get(host.id) === lease) this.close(host.id);
      throw error;
    } finally {
      lease.busy--;
      if (!lease.busy && this.leases.get(host.id) === lease) {
        lease.timer = setTimeout(() => this.close(host.id), this.idleMs);
        lease.timer.unref();
      }
    }
  }
  /** Only thread/read: never start or resume an engine to obtain telemetry. */
  async usagePath(host: HostConfig, password: string | undefined, id: string) {
    return this.using(host, password, async (client) => {
      const result = await client.call(
        "thread/read",
        { threadId: id, includeTurns: false },
        12000,
      );
      if (result.thread?.id !== id) throw new Error("Usage session changed");
      return typeof result.thread.path === "string" ? result.thread.path : null;
    });
  }
  async agentTelemetryPath(
    host: HostConfig,
    password: string | undefined,
    id: string,
  ) {
    return this.using(host, password, async (client) => {
      const result = await client.call(
        "thread/read",
        { threadId: id, includeTurns: false },
        12000,
      );
      if (result.thread?.id !== id) throw new Error("Agent session changed");
      return {
        path:
          typeof result.thread.path === "string" ? result.thread.path : null,
        task:
          typeof result.thread.name === "string" && result.thread.name.trim()
            ? result.thread.name.slice(0, 160)
            : typeof result.thread.preview === "string"
              ? result.thread.preview.slice(0, 160)
              : undefined,
      };
    });
  }
  async models(host: HostConfig, password?: string): Promise<ResearchModel[]> {
    return this.using(host, password, async (client) => {
      const models = new Map<string, ResearchModel>();
      const cursors = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const result = await client.call(
          "model/list",
          {
            limit: 100,
            includeHidden: false,
            cursor,
          },
          12000,
        );
        if (!Array.isArray(result?.data))
          throw new Error("모델 목록 응답을 읽을 수 없습니다.");
        for (const raw of result.data) {
          const id = raw?.model || raw?.id;
          if (
            raw?.hidden ||
            typeof id !== "string" ||
            id.length > 150 ||
            !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+\-\[\]]*$/.test(id)
          )
            continue;
          const supported = Array.isArray(raw.supportedReasoningEfforts)
            ? [
                ...new Set<ResearchEffort>(
                  raw.supportedReasoningEfforts
                    .map((e: any) => e?.reasoningEffort)
                    .filter(
                      (e: any) =>
                        e !== "default" && researchEfforts.includes(e),
                    ),
                ),
              ]
            : undefined;
          models.set(id, {
            id,
            name: bounded(raw.displayName, 180) || id,
            isDefault: raw.isDefault === true,
            ...(supported ? { efforts: supported } : {}),
            ...(researchEfforts.includes(raw.defaultReasoningEffort) &&
            raw.defaultReasoningEffort !== "default"
              ? { defaultEffort: raw.defaultReasoningEffort }
              : {}),
          });
        }
        if (!result.nextCursor) return [...models.values()];
        if (
          typeof result.nextCursor !== "string" ||
          result.nextCursor.length > 4096 ||
          cursors.has(result.nextCursor)
        )
          throw new Error("모델 목록 페이지를 읽을 수 없습니다.");
        cursor = result.nextCursor;
        cursors.add(cursor!);
      }
      throw new Error("모델 목록이 너무 큽니다. CLI의 /model을 확인하세요.");
    });
  }
  async list(
    host: HostConfig,
    password?: string,
    options: {
      cursor?: string;
      search?: string;
      includeAutomation?: boolean;
      archived?: boolean;
    } = {},
  ): Promise<HistoryPage> {
    return this.using(host, password, async (client) => {
      const result = await client.call(
        "thread/list",
        {
          limit: 50,
          cursor: options.cursor || null,
          sortKey: "updated_at",
          sourceKinds: options.includeAutomation
            ? ["cli", "vscode", "appServer", "exec"]
            : ["cli", "vscode"],
          archived: !!options.archived,
          ...(options.search ? { searchTerm: options.search } : {}),
          // Deliberately omit cwd: listing covers all project directories.
        },
        25000,
      );
      return {
        data: (result.data || []).map((raw: any) =>
          historyThread(host.id, raw),
        ),
        nextCursor: result.nextCursor || null,
      };
    });
  }
  async read(
    host: HostConfig,
    password: string | undefined,
    threadId: string,
    cursor?: string,
    options: HistoryReadOptions = {},
  ): Promise<HistoryDetail> {
    const scope = JSON.stringify([
      host.id,
      host.kind,
      host.address,
      host.username,
      host.port,
      host.identityFile,
      host.codexPath,
      threadId,
    ]);
    const pageKey = `${scope}\0${cursor || ""}`;
    const oversized = this.oversizedTurns.get(pageKey);
    if (oversized) {
      const summary = await this.readPage(
        host,
        password,
        threadId,
        cursor,
        options,
        1,
        true,
      );
      // A growing thread eventually has a new latest turn. Do not permanently
      // suppress its work because the previous turn exceeded the RPC limit.
      if (summary.items.some((item) => item.turnId === oversized))
        return summary;
      this.oversizedTurns.delete(pageKey);
    }
    // Twenty full turns can be tens of megabytes even though their display
    // previews are small. Preserve native cursors while shrinking only the
    // number of turns in a page; never increase the transport memory limit.
    let limit = this.pageSizes.get(scope) || 4;
    for (;;) {
      try {
        return await this.readPage(
          host,
          password,
          threadId,
          cursor,
          options,
          limit,
        );
      } catch (error) {
        if (!(error instanceof RpcResponseSizeError)) throw error;
        if (limit > 1) {
          limit = Math.max(1, Math.floor(limit / 2));
          this.remember(this.pageSizes, scope, limit);
          continue;
        }
        // A single huge tool payload must not make its question/final answer
        // unreadable. Summary view is native saved text, not an AI summary.
        const summary = await this.readPage(
          host,
          password,
          threadId,
          cursor,
          options,
          1,
          true,
        );
        const turnId = summary.items.find((item) => item.turnId)?.turnId;
        if (turnId) this.remember(this.oversizedTurns, pageKey, turnId);
        return summary;
      }
    }
  }
  private remember<T>(map: Map<string, T>, key: string, value: T) {
    map.delete(key);
    map.set(key, value);
    while (map.size > 256) map.delete(map.keys().next().value!);
  }
  private async readPage(
    host: HostConfig,
    password: string | undefined,
    threadId: string,
    cursor: string | undefined,
    options: HistoryReadOptions,
    limit: number,
    summaryOnly = false,
  ): Promise<HistoryDetail> {
    return this.using(host, password, async (client) => {
      const summary = await client.call(
        "thread/read",
        { threadId, includeTurns: false },
        20000,
      );
      const thread = historyThread(host.id, summary.thread);
      if (thread.id !== threadId)
        throw new Error("조회 중 Codex 대화가 변경됐습니다. 다시 선택하세요.");
      let turns: any[],
        nextCursor: string | null = null;
      const legacyOffset = cursor?.match(/^harbor-read:(\d{1,9})$/);
      const readLegacy = async (offset: number) => {
        const full = await client.call(
          "thread/read",
          { threadId, includeTurns: true },
          25000,
        );
        const all = full.thread?.turns || [];
        const end = Math.max(0, all.length - offset);
        const start = Math.max(0, end - 20);
        nextCursor = start > 0 ? `harbor-read:${offset + 20}` : null;
        return all.slice(start, end);
      };
      try {
        if (legacyOffset) {
          turns = await readLegacy(Number(legacyOffset[1]));
        } else {
          const page = await client.call(
            "thread/turns/list",
            {
              threadId,
              cursor: cursor || null,
              limit,
              sortDirection: "desc",
              itemsView: summaryOnly ? "summary" : "full",
            },
            25000,
          );
          turns = [...(page.data || [])].reverse();
          nextCursor = page.nextCursor || null;
        }
      } catch (error) {
        // Older CLI versions lack the paginated read method. Never resume as fallback.
        if (
          summaryOnly ||
          cursor ||
          !/unknown|unsupported|not found|method|not initialized|does not support|not loaded|persisted|pagination/i.test(
            String(error),
          )
        )
          throw error;
        turns = await readLegacy(0);
      }
      const items: MessageItem[] = [],
        timeline: MessageItem[] = [];
      for (const turn of turns) {
        const turnStatus: MessageItem["turnStatus"] = [
          "completed",
          "inProgress",
          "failed",
          "interrupted",
        ].includes(turn.status)
          ? turn.status
          : "unknown";
        for (const raw of turn.items || []) {
          const item = historyItem(raw, turn.id);
          if (!item) continue;
          item.turnStatus = turnStatus;
          if (["user", "assistant", "notice"].includes(item.kind)) {
            items.push(item);
            if (options.includeActivity) timeline.push(item);
          } else if (options.includeActivity) {
            timeline.push(item);
          }
        }
      }
      // The newest work (often a running turn) gets the preview budget first.
      const previews = historyActivities.previewAll(
        host,
        "codex",
        threadId,
        timeline,
        (item) => !["user", "assistant", "notice"].includes(item.kind),
      );
      return {
        thread,
        items,
        nextCursor,
        ...(summaryOnly
          ? {
              notice:
                "작업 출력이 매우 큰 구간은 질문과 답변을 먼저 표시합니다. 전체 작업 원문은 Codex 기록에 보존되어 있습니다.",
            }
          : {}),
        ...(options.includeActivity ? { timeline: previews } : {}),
      };
    });
  }
  async summary(
    host: HostConfig,
    password: string | undefined,
    threadId: string,
  ): Promise<HistoryThread> {
    return this.using(host, password, async (client) =>
      historyThread(
        host.id,
        (
          await client.call(
            "thread/read",
            { threadId, includeTurns: false },
            20000,
          )
        ).thread,
      ),
    );
  }
  close(hostId: string) {
    const lease = this.leases.get(hostId);
    if (!lease) return;
    this.leases.delete(hostId);
    clearTimeout(lease.timer);
    void lease.promise.then((client) => client.stop()).catch(() => {});
  }
  shutdown() {
    this.stopped = true;
    this.pageSizes.clear();
    this.oversizedTurns.clear();
    for (const id of this.leases.keys()) this.close(id);
  }
}
