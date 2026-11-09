import { randomUUID } from "node:crypto";
import type { TerminalControlView } from "../shared/mobile.js";

type Lease = TerminalControlView & {
  deviceId: string;
  token: string;
  binding: string;
};
export class TerminalControl {
  private leases = new Map<string, Lease>();
  constructor(
    private binding: (id: string) => string | undefined,
    private changed = () => {},
    private now = Date.now,
  ) {}
  private current(id: string) {
    const lease = this.leases.get(id);
    if (
      lease &&
      (lease.expiresAt <= this.now() || lease.binding !== this.binding(id))
    ) {
      this.leases.delete(id);
      return undefined;
    }
    return lease;
  }
  view(id: string): TerminalControlView | null {
    const lease = this.current(id);
    return lease
      ? {
          clientId: lease.clientId,
          deviceName: lease.deviceName,
          expiresAt: lease.expiresAt,
        }
      : null;
  }
  views() {
    const result: Record<string, TerminalControlView> = {};
    for (const id of this.leases.keys()) {
      const v = this.view(id);
      if (v) result[id] = v;
    }
    return result;
  }
  change(
    id: string,
    deviceId: string,
    deviceName: string,
    input: {
      clientId: string;
      action: "claim" | "renew" | "release";
      takeover?: boolean;
      token?: string;
      fresh?: boolean;
    },
  ) {
    const binding = this.binding(id);
    if (!binding)
      throw Object.assign(new Error("연결된 터미널을 선택하세요."), {
        status: 409,
      });
    let lease = this.current(id);
    const mine =
      lease?.deviceId === deviceId && lease.clientId === input.clientId;
    // A backgrounded browser can deliver its keepalive release after the same
    // tab has returned and claimed again. It may only release/renew that lease.
    const sameLease = mine && (!input.token || input.token === lease?.token);
    if (input.action === "release") {
      if (sameLease) {
        this.leases.delete(id);
        this.changed();
      }
      return { control: this.view(id) };
    }
    if (input.action === "renew" && !sameLease)
      throw Object.assign(new Error("제어권이 다른 기기로 이동했습니다."), {
        status: 409,
      });
    if (lease && !mine && !input.takeover)
      throw Object.assign(
        new Error(
          `${lease.deviceName}에서 입력 중입니다. ‘여기서 제어’를 눌러 이어가세요.`,
        ),
        { status: 409 },
      );
    // Returning mobile tabs explicitly start a generation. Ordinary claims
    // keep compatibility with desktop IDE + terminal clients sharing a lease.
    if (!mine || (input.action === "claim" && input.fresh))
      lease = {
        deviceId,
        deviceName,
        clientId: input.clientId,
        token: randomUUID(),
        binding,
        expiresAt: 0,
      };
    lease!.expiresAt = this.now() + 30_000;
    this.leases.set(id, lease!);
    this.changed();
    return { control: this.view(id), token: lease!.token };
  }
  assert(
    id: string,
    deviceId: string,
    clientId?: string,
    token?: string,
    allowLegacy = false,
  ) {
    const lease = this.current(id);
    // Explicit compatibility for older mobile builds only. A legacy sender still
    // becomes the owner, so another phone/PC cannot interleave its input.
    if (
      allowLegacy &&
      !clientId &&
      !token &&
      (!lease ||
        (lease.deviceId === deviceId && lease.clientId === "legacy")) &&
      this.binding(id)
    ) {
      this.change(id, deviceId, "휴대폰", {
        clientId: "legacy",
        action: "claim",
      });
      return;
    }
    if (
      !lease ||
      lease.deviceId !== deviceId ||
      lease.clientId !== clientId ||
      lease.token !== token
    )
      throw Object.assign(new Error("제어권을 가져온 뒤 다시 입력하세요."), {
        status: 409,
      });
    lease.expiresAt = this.now() + 30_000;
  }
  local(id: string) {
    const lease = this.current(id);
    if (lease && lease.deviceId !== "local")
      throw Object.assign(
        new Error(
          `${lease.deviceName}에서 제어 중입니다. ‘여기서 제어’를 눌러주세요.`,
        ),
        { status: 409 },
      );
    if (lease) {
      const publish = this.now() + 30_000 - lease.expiresAt >= 10_000;
      lease.expiresAt = this.now() + 30_000;
      if (publish) this.changed();
    } else {
      this.change(id, "local", "호스트 PC", {
        clientId: "local",
        action: "claim",
      });
    }
  }
  canResizeLocally(id: string) {
    const lease = this.current(id);
    // Layout/focus notifications are passive and cannot claim or renew control.
    // Initial SSH/local launch also needs its viewport size before it connects.
    return !lease || lease.deviceId === "local";
  }
  revoke(deviceId: string) {
    for (const [id, lease] of this.leases)
      if (lease.deviceId === deviceId) this.leases.delete(id);
    this.changed();
  }
  clear() {
    this.leases.clear();
    this.changed();
  }
}
