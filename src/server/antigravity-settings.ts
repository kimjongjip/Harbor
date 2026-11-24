import { randomUUID } from "node:crypto";
import { z } from "zod";
import { chatEfforts, type ChatEffort } from "../shared/ide-chat.js";

type Config = { model?: string; effort?: ChatEffort };
type Actual = { model: string; effort?: ChatEffort };
type Guard = () => Promise<void>;
type Pending = {
  id: string;
  nativeId: string;
  config: Config;
  claimed: boolean;
  guard: Guard;
  timer: ReturnType<typeof setTimeout>;
  ok: (actual: Actual) => void;
  fail: (e: Error) => void;
};
const effort = z.enum(chatEfforts);
export const nativeControlEvent = z.discriminatedUnion("op", [
  z.object({ op: z.literal("register"), nativeId: z.string().uuid(),model:z.string().min(1).max(180).optional(),effort:effort.optional() }),
  z.object({ op: z.literal("claim"), nativeId: z.string().uuid() }),
  z.object({
    op: z.literal("ack"),
    nativeId: z.string().uuid(),
    id: z.string().uuid(),
    model: z.string().min(1).max(180).optional(),
    effort: effort.optional(),
    error: z.string().max(512).optional(),
  }),
]);

/** An authenticated ACP adapter can claim an explicit UI request exactly once.
 * The nonprivileged peer poll only carries a wake-up flag. */
export class AntigravitySettings {
  private adapters = new Map<string, string>();
  private current=new Map<string,Actual>();
  private jobs = new Map<string, Pending>();
  constructor(
    private state: (
      terminalId: string,
      nativeId: string,
    ) => "idle" | "busy" | undefined,
    private wake: () => void,
  ) {}
  registered(id: string, nativeId: string) {
    return this.adapters.get(id) === nativeId && !!this.state(id, nativeId);
  }
  pending(id: string, nativeId?: string) {
    const p = this.jobs.get(id);
    return !!p && !p.claimed && p.nativeId === nativeId;
  }
  revoke(id: string) {
    this.current.delete(id);
    this.adapters.delete(id);
    this.reject(id, new Error("Antigravity 연결이 종료되었습니다."));
  }
  observed(id:string,nativeId:string){return this.registered(id,nativeId)?this.current.get(id):undefined;}
  private reject(id: string, error: Error) {
    const p = this.jobs.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.jobs.delete(id);
    p.fail(error);
  }
  async configure(
    id: string,
    nativeId: string,
    config: Config,
    guard: Guard,
  ): Promise<Actual> {
    await guard();
    if (!this.registered(id, nativeId) || this.state(id, nativeId) !== "idle")
      throw Error("연결된 유휴 Antigravity 대화에서 설정하세요.");
    if (this.jobs.has(id)) throw Error("이 대화의 설정 변경이 진행 중입니다.");
    return new Promise<Actual>((ok, fail) => {
      const timer = setTimeout(
        () =>
          this.reject(
            id,
            new Error(
              "설정 적용 확인 시간이 초과되었습니다. 실제 대화 설정을 확인하세요.",
            ),
          ),
        35000,
      );
      timer.unref();
      this.jobs.set(id, {
        id: randomUUID(),
        nativeId,
        config: { ...config },
        claimed: false,
        guard,
        timer,
        ok,
        fail,
      });
      this.wake();
    });
  }
  async receive(id: string, event: z.infer<typeof nativeControlEvent>) {
    const { nativeId } = event;
    if (!this.state(id, nativeId))
      throw Error("Antigravity 대화가 변경되었습니다.");
    if (event.op === "register") {
      if (this.adapters.get(id) !== nativeId) this.revoke(id);
      this.adapters.set(id, nativeId);
      if(event.model)this.current.set(id,{model:event.model,effort:event.effort});
      return {};
    }
    const p = this.jobs.get(id);
    if (!p || p.nativeId !== nativeId || !this.registered(id, nativeId))
      return {};
    if (event.op === "claim") {
      if (p.claimed) return {};
      try {
        await p.guard();
        if (this.state(id, nativeId) !== "idle")
          throw Error("Antigravity가 작업 중입니다.");
      } catch (e) {
        if (this.jobs.get(id) === p)
          this.reject(
            id,
            e instanceof Error ? e : new Error("설정 권한이 변경되었습니다."),
          );
        return {};
      }
      if (this.jobs.get(id) !== p || p.claimed) return {};
      p.claimed = true;
      return { id: p.id, config: p.config };
    }
    if (event.id !== p.id || !p.claimed) return {};
    try {
      await p.guard();
    } catch {
      if (this.jobs.get(id) === p)
        this.reject(id, new Error("설정 권한이 변경되었습니다."));
      return {};
    }
    if (this.jobs.get(id) !== p) return {};
    if (event.error || !event.model) {
      this.reject(id, new Error(event.error || "모델을 확인하지 못했습니다."));
      return {};
    }
    const variant = event.effort
      ? event.model + "-" + event.effort
      : event.model;
    if (
      (p.config.model &&
        p.config.model !== event.model &&
        p.config.model !== variant) ||
      (p.config.effort && p.config.effort !== event.effort)
    ) {
      this.reject(id, new Error("요청한 모델·effort와 실제 응답이 다릅니다."));
      return {};
    }
    this.jobs.delete(id);
    clearTimeout(p.timer);
    this.current.set(id,{model:event.model,effort:event.effort});
    p.ok({
      model: event.model,
      ...(event.effort ? { effort: event.effort } : {}),
    });
    return {};
  }
}
