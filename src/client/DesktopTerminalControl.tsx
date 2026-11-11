import { useEffect, useRef, useState } from "react";
import { api, apiHeaders } from "./api";
import {
  desktopClientId,
  desktopLease,
  setDesktopLease,
} from "./desktop-session";
import type { TerminalControlView } from "../shared/mobile";

type Reply = { control: TerminalControlView | null; token?: string };
export function DesktopTerminalControl({
  id,
  active,
  refresh,
  blockedReason,
  onReadOnlyChange,
  onClaim,
}: {
  id: string;
  active: boolean;
  refresh?: number;
  blockedReason?: string;
  onReadOnlyChange?(value: boolean): void;
  onClaim?(): void;
}) {
  const [control, setControl] = useState<TerminalControlView | null>(null);
  const [mine, setMine] = useState(false);
  const [error, setError] = useState("");
  const callbacks = useRef({ onReadOnlyChange, onClaim });
  callbacks.current = { onReadOnlyChange, onClaim };
  const generation = useRef(0);
  const apply = (value: Reply) => {
    if (value.token) setDesktopLease(id, value.token);
    const owns =
      value.control?.clientId === desktopClientId &&
      value.control.expiresAt > Date.now() &&
      !!desktopLease(id);
    if (!owns) setDesktopLease(id);
    setControl(value.control);
    setMine(owns);
    setError("");
    callbacks.current.onReadOnlyChange?.(!owns);
  };
  const claim = async (takeover: boolean) => {
    const epoch = ++generation.current;
    try {
      const value = await api<Reply>(`/terminals/${id}/control`, {
        action: "claim",
        clientId: desktopClientId,
        takeover,
      });
      if (epoch !== generation.current) return;
      apply(value);
      if (takeover) callbacks.current.onClaim?.();
    } catch (e) {
      if (epoch === generation.current) {
        setError((e as Error).message);
        callbacks.current.onReadOnlyChange?.(true);
      }
    }
  };
  useEffect(() => {
    if (!active) return;
    let stopped = false,
      busy = false;
    const read = async () => {
      if (stopped || busy || document.visibilityState === "hidden") return;
      busy = true;
      const epoch = generation.current;
      try {
        let value = await api<Reply>(
          `/terminals/${id}/control`,
          undefined,
          "GET",
        );
        if (stopped || epoch !== generation.current) return;
        if (!value.control) {
          // An unused terminal can be taken immediately; never steal another device's lease.
          await claim(false);
          return;
        }
        if (
          value.control.clientId === desktopClientId &&
          desktopLease(id) &&
          value.control.expiresAt < Date.now() + 20000
        )
          value = await api<Reply>(`/terminals/${id}/control`, {
            action: "renew",
            clientId: desktopClientId,
            token: desktopLease(id),
          });
        if (!stopped && epoch === generation.current) apply(value);
      } catch (e) {
        if (!stopped && epoch === generation.current) {
          setDesktopLease(id);
          setMine(false);
          setError((e as Error).message);
          callbacks.current.onReadOnlyChange?.(true);
        }
      } finally {
        busy = false;
      }
    };
    void read();
    const timer = setInterval(read, 3000);
    document.addEventListener("visibilitychange", read);
    return () => {
      stopped = true;
      generation.current++;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
      const token = desktopLease(id);
      setDesktopLease(id);
      callbacks.current.onReadOnlyChange?.(true);
      if (token)
        void fetch(`/api/terminals/${id}/control`, {
          method: "POST",
          keepalive: true,
          headers: { "Content-Type": "application/json", ...apiHeaders() },
          body: JSON.stringify({
            action: "release",
            clientId: desktopClientId,
            token,
          }),
        }).catch(() => {});
    };
  }, [id, active, refresh]);
  if (!active || (mine && !blockedReason && !error)) return null;
  return (
    <div className="terminal-attention" role="status">
      <span>
        {error ||
          (control && control.clientId !== desktopClientId
            ? `${control.deviceName}에서 제어 중 · 이 창은 보기 전용`
            : blockedReason || "터미널 제어권 확인 중…")}
      </span>
      <button onClick={() => void claim(true)}>여기서 제어</button>
    </div>
  );
}
