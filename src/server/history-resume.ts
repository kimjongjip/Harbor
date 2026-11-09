import type {
  HostConfig,
  TerminalColors,
  TerminalInfo,
} from "../shared/types.js";
import type { HistoryThread } from "../shared/history.js";
import type { Terminals } from "./terminals.js";

type Provider = "codex" | "claude";
interface ResumeOptions {
  provider: Provider;
  colors?: TerminalColors;
  sshSessionMode?: "direct" | "tmux";
}

/** One native conversation must never be resumed twice, even across mode choices. */
export class HistoryResumer {
  private opening = new Map<string, Promise<TerminalInfo>>();
  constructor(
    private readonly terminals: Pick<
      Terminals,
      "list" | "create" | "setColors"
    >,
    private readonly passwordFor: (
      hostId: string,
    ) => Promise<string | undefined>,
    private readonly summary: (
      provider: Provider,
      host: HostConfig,
      password: string | undefined,
      id: string,
    ) => Promise<HistoryThread>,
    private readonly validateCwd: (cwd: string) => string,
  ) {}

  async resume(
    host: HostConfig,
    threadId: string,
    options: ResumeOptions,
  ): Promise<TerminalInfo> {
    if (host.kind !== "ssh" && options.sshSessionMode === "tmux")
      throw new Error("tmux 세션 유지는 SSH 서버에서만 선택할 수 있습니다.");
    const { provider, colors } = options;
    const existing = this.terminals
      .list()
      .find(
        (terminal) =>
          terminal.hostId === host.id &&
          (terminal.agentKind ||
            (terminal.program?.startsWith("claude") ? "claude" : "codex")) ===
            provider &&
          (terminal.resumeThreadId === threadId ||
            terminal.agentSessionId === threadId) &&
          !terminal.exited,
      );
    if (existing) {
      if (colors) this.terminals.setColors(existing.id, colors);
      return existing;
    }
    const key = `${provider}:${host.id}:${threadId}`;
    let pending = this.opening.get(key);
    if (!pending) {
      pending = (async () => {
        const password = await this.passwordFor(host.id);
        const thread = await this.summary(provider, host, password, threadId);
        if (thread.active)
          throw new Error(
            "이 대화는 실행 중입니다. 기존 터미널에서 이어가세요.",
          );
        const cwd = this.validateCwd(thread.cwd);
        return this.terminals.create(host, cwd, password, {
          program: provider === "claude" ? "claude-resume" : "resume",
          title: thread.title.slice(0, 100),
          resumeThreadId: threadId,
          ...(provider === "claude" ? { resumeCwd: cwd } : {}),
          colors,
          sshSessionMode: options.sshSessionMode || "direct",
        });
      })();
      this.opening.set(key, pending);
      void pending.finally(() => this.opening.delete(key)).catch(() => {});
    }
    return pending;
  }
}
