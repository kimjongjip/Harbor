import type { MobileState } from "../shared/mobile.js";
import type { ClaudeHookEvent } from "./claude-hooks.js";

/** Native completion signals only: idle, errors and repainting are not answers. */
export class MobileCompletions {
  private seen = new Set<string>();
  private epoch = 0;
  private claude = new Map<
    string,
    {
      sessionId: string;
      epoch: number;
      stopped: boolean;
      cycle: number;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private state: () => MobileState,
    private notify: (id: string, key: string) => void,
    private settleMs = 600,
  ) {}
  completed(id: string, sessionId: string, eventId: string) {
    const t = this.state().terminals.find((t) => t.id === id && !t.exited);
    if (
      !t ||
      t.agentSessionId !== sessionId ||
      t.connectionState !== "connected"
    )
      return;
    const key = JSON.stringify([id, sessionId, eventId]);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    while (this.seen.size > 512)
      this.seen.delete(this.seen.values().next().value!);
    this.notify(id, key);
  }
  claudeEvent(id: string, event: ClaudeHookEvent) {
    let slot = this.claude.get(id);
    if (!slot || slot.sessionId !== event.session_id) {
      clearTimeout(slot?.timer);
      slot = {
        sessionId: event.session_id,
        epoch: ++this.epoch,
        stopped: false,
        cycle: 0,
      };
      this.claude.set(id, slot);
    }
    if (
      ["UserPromptSubmit", "PostToolUse", "PostToolUseFailure"].includes(
        event.hook_event_name,
      )
    ) {
      clearTimeout(slot.timer);
      if (slot.stopped) slot.cycle++;
      slot.stopped = false;
    } else if (event.hook_event_name === "Stop" && !slot.stopped) {
      slot.stopped = true;
      const current = slot,
        cycle = slot.cycle;
      slot.timer = setTimeout(() => {
        if (
          this.claude.get(id) !== current ||
          !current.stopped ||
          current.cycle !== cycle
        )
          return;
        const terminal = this.state().terminals.find((t) => t.id === id);
        if (terminal?.agentState !== "idle") return;
        this.completed(
          id,
          event.session_id,
          `claude-stop:${current.epoch}:${cycle}`,
        );
      }, this.settleMs);
      slot.timer.unref();
    } else if (
      ["SessionEnd", "SessionStart", "StopFailure"].includes(
        event.hook_event_name,
      )
    ) {
      clearTimeout(slot.timer);
      slot.stopped = true;
    }
    while (this.claude.size > 128) {
      const key = this.claude.keys().next().value!;
      clearTimeout(this.claude.get(key)?.timer);
      this.claude.delete(key);
    }
  }
  continued(id: string) {
    clearTimeout(this.claude.get(id)?.timer);
  }
  dispose() {
    for (const slot of this.claude.values()) clearTimeout(slot.timer);
    this.claude.clear();
  }
}
