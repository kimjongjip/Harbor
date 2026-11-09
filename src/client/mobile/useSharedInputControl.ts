import { useEffect, useRef, useState } from "react";
import type { MobileState } from "../../shared/mobile";

type Control = { clientId: string; deviceName: string; expiresAt: number };
type Credentials = { clientId?: string; controlToken?: string };
type Target = { terminalId: string; runtimeId: string; sessionId?: string };
type Lease = Target & { token: string };
const identity = (value: Target) => ({
  runtimeId: value.runtimeId,
  sessionId: value.sessionId,
});

/** Viewing and preloading never take input ownership from another device. */
export function useSharedInputControl({
  enabled,
  active,
  ready,
  state,
  terminal,
  api,
  update,
}: {
  enabled: boolean;
  active: boolean;
  ready: boolean;
  state?: MobileState;
  terminal?: MobileState["terminals"][number];
  api(path: string, body: unknown): Promise<any>;
  update(id: string, control: Control | null): void;
}) {
  const [clientId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const lease = useRef<Lease | undefined>(undefined);
  const target: Target | undefined =
    terminal && state
      ? {
          terminalId: terminal.id,
          runtimeId: state.runtimeId,
          sessionId: terminal.agentSessionId,
        }
      : undefined;
  const key = JSON.stringify(target);
  const latest = useRef({ enabled, active, ready, key, target, state, update });
  latest.current = { enabled, active, ready, key, target, state, update };
  const reported = target && state?.controls?.[target.terminalId];
  const owner = reported && reported.expiresAt > clock ? reported : undefined;
  const otherOwner = owner?.clientId !== clientId ? owner : undefined;

  function release(value: Lease | undefined, keepalive = false) {
    if (!value) return;
    if (lease.current === value) lease.current = undefined;
    // A hidden/closed tab must not continue holding the terminal's input lease.
    void fetch(
      `/mobile-api/terminals/${encodeURIComponent(value.terminalId)}/control`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "X-Harbor-Mobile": "1", "Content-Type": "application/json" },
        body: JSON.stringify({
          ...identity(value),
          action: "release",
          clientId,
        }),
        keepalive,
      },
    ).catch(() => {});
  }

  useEffect(() => {
    if (!enabled || !active || !target) return;
    let disposed = false;
    let renewing = false;
    const tick = async () => {
      setClock(Date.now());
      const value = lease.current;
      if (!value || renewing || document.visibilityState !== "visible") return;
      const current = latest.current;
      const holder = current.state?.controls?.[value.terminalId];
      if (holder && holder.clientId !== clientId) {
        lease.current = undefined;
        return;
      }
      renewing = true;
      try {
        const result = await api(
          `/terminals/${encodeURIComponent(value.terminalId)}/control`,
          {
            ...identity(value),
            action: "renew",
            clientId,
          },
        );
        if (!disposed && lease.current === value) {
          if (result.token) value.token = result.token;
          current.update(value.terminalId, result.control);
        }
      } catch {
        if (lease.current === value) lease.current = undefined;
      } finally {
        renewing = false;
      }
    };
    const timer = setInterval(() => void tick(), 10000);
    const hide = () => {
      if (document.visibilityState !== "visible") release(lease.current, true);
      else setClock(Date.now());
    };
    const pagehide = () => release(lease.current, true);
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", pagehide);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", pagehide);
      release(lease.current);
    };
  }, [enabled, active, key]);

  async function authorize(takeover = false): Promise<Credentials> {
    const current = latest.current;
    if (!current.active || !current.ready || !current.target)
      throw new Error("실시간 연결을 확인한 뒤 다시 시도하세요.");
    if (!current.enabled) return {};
    const holder = current.state?.controls?.[current.target.terminalId];
    if (
      holder &&
      holder.expiresAt > Date.now() &&
      holder.clientId !== clientId &&
      !takeover
    )
      throw new Error(
        `${holder.deviceName}에서 입력 중입니다. ‘여기서 제어’를 눌러 전환하세요.`,
      );
    const existing = lease.current;
    if (
      existing &&
      holder?.clientId === clientId &&
      holder.expiresAt > Date.now()
    )
      return { clientId, controlToken: existing.token };
    setBusy(true);
    try {
      const result = await api(
        `/terminals/${encodeURIComponent(current.target.terminalId)}/control`,
        {
          ...identity(current.target),
          action: "claim",
          clientId,
          ...(takeover ? { takeover: true } : {}),
        },
      );
      if (!result.token || result.control?.clientId !== clientId)
        throw new Error("입력 제어권을 확인하지 못했습니다.");
      const acquired = { ...current.target, token: result.token };
      if (
        latest.current.key !== current.key ||
        !latest.current.active ||
        !latest.current.ready
      ) {
        release(acquired);
        throw new Error(
          "세션이 변경되었습니다. 현재 화면에서 다시 시도하세요.",
        );
      }
      lease.current = acquired;
      current.update(current.target.terminalId, result.control);
      setClock(Date.now());
      return { clientId, controlToken: acquired.token };
    } finally {
      setBusy(false);
    }
  }

  return { busy, owner, otherOwner, authorize };
}
