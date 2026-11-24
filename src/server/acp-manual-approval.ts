import { randomUUID } from "node:crypto";
import type { Approval } from "../shared/types.js";

/** Only a human answer to this exact native prompt resolves it. No automatic policy reads this map. */
export class AcpManualApprovals {
  private rows = new Map<
    string,
    { session: string; card: Approval; finish: (approved?: boolean) => void }
  >();
  pending(terminal: string, session: string) {
    const row = this.rows.get(terminal);
    return row?.session === session ? [row.card] : [];
  }
  offer(
    terminal: string,
    session: string,
    title: string,
    detail: string,
    signal: AbortSignal,
  ) {
    this.rows.get(terminal)?.finish();
    return new Promise<boolean | undefined>((resolve) => {
      if (signal.aborted) {
        resolve(undefined);
        return;
      }
      const id = "acp-" + randomUUID();
      const cancel = () => finish();
      const finish = (choice?: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        if (this.rows.get(terminal)?.card.id === id) this.rows.delete(terminal);
        resolve(choice);
      };
      const timer = setTimeout(cancel, 300000);
      timer.unref();
      this.rows.set(terminal, {
        session,
        card: {
          id,
          requestId: id,
          method: "session/request_permission",
          kind: "permissions",
          title,
          detail,
        },
        finish,
      });
      signal.addEventListener("abort", cancel, { once: true });
    });
  }
  answer(terminal: string, session: string, id: string, choice: boolean) {
    const row = this.rows.get(terminal);
    if (!row || row.session !== session || row.card.id !== id) return false;
    row.finish(choice);
    return true;
  }
  revoke(terminal: string) {
    this.rows.get(terminal)?.finish();
  }
}
