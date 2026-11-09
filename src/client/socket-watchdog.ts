export type SocketStall =
  "open-timeout" | "replay-timeout" | "heartbeat-timeout";

/** Network close events are not guaranteed on a half-open connection. */
export class SocketWatchdog {
  private openedAt: number | undefined;
  private lastMessage: number;
  private complete = false;
  private stopped = false;
  private readonly started: number;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly options: {
      onStall(reason: SocketStall): void;
      expectsReplay?: boolean;
      heartbeat?: boolean;
      now?: () => number;
      openMs?: number;
      replayMs?: number;
      heartbeatMs?: number;
    },
  ) {
    this.started = this.lastMessage = this.now();
    this.timer = setInterval(() => this.check(), 1000);
  }
  private now() {
    return (this.options.now || Date.now)();
  }
  opened() {
    this.openedAt = this.lastMessage = this.now();
  }
  message() {
    this.lastMessage = this.now();
  }
  ready() {
    this.complete = true;
  }
  check() {
    if (this.stopped) return;
    const now = this.now();
    const reason: SocketStall | undefined =
      this.openedAt === undefined
        ? now - this.started >= (this.options.openMs ?? 12000)
          ? "open-timeout"
          : undefined
        : this.options.expectsReplay &&
            !this.complete &&
            now - this.openedAt >= (this.options.replayMs ?? 30000)
          ? "replay-timeout"
          : this.options.heartbeat &&
              now - this.lastMessage >= (this.options.heartbeatMs ?? 45000)
            ? "heartbeat-timeout"
            : undefined;
    if (reason) {
      this.dispose();
      this.options.onStall(reason);
    }
  }
  dispose() {
    this.stopped = true;
    clearInterval(this.timer);
  }
}
