import { RpcClient } from "./rpc.js";
import { processCommand } from "./ssh.js";
import { sshCodexChannel } from "./ssh-connect.js";
import { normalizeItem } from "./session.js";
import type { HostConfig, MessageItem } from "../shared/types.js";
import type {
  HistoryThread,
  HistoryPage,
  HistoryDetail,
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
  private stopped = false;
  constructor(
    private readonly create: Connect = connect,
    private readonly idleMs = 15_000,
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
  ): Promise<HistoryDetail> {
    return this.using(host, password, async (client) => {
      const summary = await client.call(
        "thread/read",
        { threadId, includeTurns: false },
        20000,
      );
      const thread = historyThread(host.id, summary.thread);
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
              limit: 20,
              sortDirection: "desc",
              itemsView: "full",
            },
            25000,
          );
          turns = [...(page.data || [])].reverse();
          nextCursor = page.nextCursor || null;
        }
      } catch (error) {
        // Older CLI versions lack the paginated read method. Never resume as fallback.
        if (
          cursor ||
          !/unknown|unsupported|not found|method|not initialized|does not support|not loaded|persisted|pagination/i.test(
            String(error),
          )
        )
          throw error;
        turns = await readLegacy(0);
      }
      const items = turns
        .flatMap((turn) =>
          (turn.items || []).map((item: any) => normalizeItem(item, turn.id)),
        )
        .filter(
          (item): item is MessageItem =>
            !!item && ["user", "assistant", "notice"].includes(item.kind),
        );
      return { thread, items, nextCursor };
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
    for (const id of this.leases.keys()) this.close(id);
  }
}
