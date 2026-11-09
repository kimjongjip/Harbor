import type { MobileState } from "../../shared/mobile";
import type { TerminalReplayMetadata } from "../../shared/types";

export type MobilePreview = {
  runtimeId: string;
  terminalId: string;
  sessionId: string;
  data: string;
  replay: TerminalReplayMetadata;
};
export function mobileScreenKey(
  runtimeId: string | undefined,
  terminalId: string,
  sessionId?: string,
) {
  return JSON.stringify([runtimeId, terminalId, sessionId]);
}
export function previewIdentity(state: MobileState, id: string) {
  const terminal = state.terminals.find(
    (t) => t.id === id && !t.exited && t.connectionState === "connected",
  );
  if (!terminal) return;
  return {
    runtimeId: state.runtimeId,
    terminalId: id,
    sessionId: terminal.agentSessionId || terminal.resumeThreadId || "",
  };
}
/** One speculative read, memory only. A displayed session always gets its live WS snapshot. */
export class MobileSessionPreloader {
  private pending?: {
    key: string;
    at: number;
    expires: ReturnType<typeof setTimeout>;
    controller: AbortController;
    promise: Promise<MobilePreview | undefined>;
  };
  private recent = new Map<string, number>();
  constructor(
    private load: (
      identity: Omit<MobilePreview, "data" | "replay">,
      signal: AbortSignal,
    ) => Promise<MobilePreview>,
  ) {}
  prepare(identity: Omit<MobilePreview, "data" | "replay">) {
    const key = mobileScreenKey(
      identity.runtimeId,
      identity.terminalId,
      identity.sessionId || undefined,
    );
    if (this.pending?.key === key && Date.now() - this.pending.at < 15000)
      return this.pending.promise;
    this.cancel();
    // Limit repeated focus/touch and failed preparations, without background retry loops.
    if (Date.now() - (this.recent.get(key) || 0) < 10000) return;
    this.recent.set(key, Date.now());
    while (this.recent.size > 32)
      this.recent.delete(this.recent.keys().next().value!);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const promise = this.load(identity, controller.signal)
      .then((value) => {
        if (
          controller.signal.aborted ||
          value.runtimeId !== identity.runtimeId ||
          value.terminalId !== identity.terminalId ||
          value.sessionId !== identity.sessionId
        )
          return;
        return value;
      })
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
    const entry = {
      key,
      at: Date.now(),
      controller,
      promise,
      expires: setTimeout(() => {
        if (this.pending === entry) this.cancel();
      }, 15000),
    };
    this.pending = entry;
    return promise;
  }
  take(key: string, signal: AbortSignal) {
    if (this.pending?.key !== key || Date.now() - this.pending.at >= 15000) {
      this.cancel();
      return;
    }
    const { promise, controller, expires } = this.pending;
    clearTimeout(expires);
    this.pending = undefined;
    const abort = () => controller.abort();
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    return promise.finally(() => signal.removeEventListener("abort", abort));
  }
  cancel() {
    clearTimeout(this.pending?.expires);
    this.pending?.controller.abort();
    this.pending = undefined;
  }
  clear() {
    this.cancel();
    this.recent.clear();
  }
}
