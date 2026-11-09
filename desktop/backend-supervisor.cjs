const alive = (child) =>
  child && child.exitCode === null && child.signalCode === null;

// Recover only an owned child whose exit is confirmed. Never kill a live process.
class BackendSupervisor {
  constructor({
    start,
    onStatus,
    onEvent,
    now = Date.now,
    delays = [1000, 2000, 5000],
    windowMs = 120000,
  }) {
    Object.assign(this, { start, onStatus, onEvent, now, delays, windowMs });
    this.status = { phase: "ready", attempt: 0, revision: 0 };
    this.attempts = [];
    this.active = false;
    this.stopped = false;
    this.busy = false;
  }
  update(phase, attempt = this.attempts.length) {
    this.status = { phase, attempt, revision: this.status.revision + 1 };
    this.onStatus(this.status);
  }
  watch(child) {
    this.child = child;
    const born = this.now();
    this.onEvent("backend-start", { pid: child.pid });
    child.once("exit", (code, signal) => {
      this.onEvent("backend-exit", {
        pid: child.pid,
        code,
        signal,
        uptimeMs: this.now() - born,
        expected: this.stopped,
      });
      if (this.child !== child || !this.active || this.stopped || this.busy)
        return;
      this.recover();
    });
  }
  activate() {
    this.active = true;
    if (this.child && !alive(this.child)) this.recover();
  }
  recover() {
    if (
      this.stopped ||
      !this.active ||
      this.busy ||
      this.timer ||
      alive(this.child)
    )
      return;
    this.attempts = this.attempts.filter(
      (at) => this.now() - at < this.windowMs,
    );
    if (this.attempts.length >= this.delays.length) {
      this.update("failed");
      return;
    }
    const delay = this.delays[this.attempts.length];
    this.update("recovering", this.attempts.length + 1);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, delay);
  }
  async run() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    this.attempts.push(this.now());
    try {
      const started = await this.start();
      // Another independently started service may already own the port.
      // Treat it as healthy without assuming ownership or reviving the old child.
      if (started === null) this.child = undefined;
      if (this.child && !alive(this.child))
        throw new Error("Backend exited during startup");
      if (!this.stopped) {
        this.onEvent("backend-recovered", { attempt: this.attempts.length });
        this.update("ready");
      }
    } catch {
      if (!this.stopped) {
        this.onEvent("backend-recovery-failed", {
          attempt: this.attempts.length,
          live: Boolean(alive(this.child)),
        });
        this.update("failed");
      }
    } finally {
      this.busy = false;
    }
    if (!this.stopped && this.status.phase === "failed" && !alive(this.child))
      this.recover();
  }
  retry() {
    if (this.stopped || this.busy || this.timer) return this.status;
    this.attempts = [];
    this.update("recovering", 1);
    // start() checks health and refuses to spawn when a previous child is still alive.
    void this.run();
    return this.status;
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
module.exports = { BackendSupervisor };
