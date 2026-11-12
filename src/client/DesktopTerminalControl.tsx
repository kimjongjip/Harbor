import { useEffect, useRef, useState } from "react";
import { api, apiHeaders } from "./api";
import {
  desktopClientId,
  desktopLease,
  setDesktopLease,
} from "./desktop-session";
import { TerminalControlBanner } from "./TerminalControlBanner";
import { watchTerminalControl } from "./terminal-control-events";
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
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const callbacks = useRef({ onReadOnlyChange, onClaim });
  callbacks.current = { onReadOnlyChange, onClaim };
  const generation = useRef(0),
    revision = useRef(0);
  const observed = useRef<TerminalControlView | null>(null);
  const claiming = useRef(false);
  const visible = useRef(active);
  visible.current = active;
  const readNow = useRef<() => void>(() => {});
  const apply = (value: Reply) => {
    if (value.token) setDesktopLease(id, value.token);
    const owns =
      value.control?.clientId === desktopClientId &&
      value.control.expiresAt > Date.now() &&
      !!desktopLease(id);
    if (!owns) setDesktopLease(id);
    observed.current = value.control;
    setControl(value.control);
    setMine(owns);
    setChecked(true);
    setError("");
    callbacks.current.onReadOnlyChange?.(!owns);
  };
  const claim = async () => {
    if (claiming.current) return;
    claiming.current = true;
    setBusy(true);
    const epoch = ++generation.current,
      before = revision.current;
    try {
      const value = await api<Reply>(
        `/terminals/${id}/control`,
        {
          action: "claim",
          clientId: desktopClientId,
          takeover: true,
        },
        "POST",
        AbortSignal.timeout(10000),
      );
      if (epoch !== generation.current) return;
      // Our own push arrives before the claim response/token. A later takeover
      // by somebody else must win over this otherwise successful HTTP reply.
      if (
        revision.current !== before &&
        observed.current?.clientId !== desktopClientId
      )
        return;
      apply(value);
      callbacks.current.onClaim?.();
    } catch (e) {
      if (epoch === generation.current) {
        setDesktopLease(id);
        setMine(false);
        setError((e as Error).message);
        callbacks.current.onReadOnlyChange?.(true);
      }
    } finally {
      claiming.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    let stopped = false,
      reading = false;
    const unwatch = watchTerminalControl(id, (value) => {
      revision.current++;
      apply({ control: value });
    });
    const read = async () => {
      if (
        stopped ||
        !visible.current ||
        reading ||
        claiming.current ||
        document.visibilityState === "hidden"
      )
        return;
      reading = true;
      const epoch = generation.current,
        before = revision.current;
      try {
        let value = await api<Reply>(
          `/terminals/${id}/control`,
          undefined,
          "GET",
          AbortSignal.timeout(10000),
        );
        if (
          stopped ||
          epoch !== generation.current ||
          before !== revision.current
        )
          return;
        if (
          value.control?.clientId === desktopClientId &&
          desktopLease(id) &&
          value.control.expiresAt < Date.now() + 20000
        )
          value = await api<Reply>(
            `/terminals/${id}/control`,
            {
              action: "renew",
              clientId: desktopClientId,
              token: desktopLease(id),
            },
            "POST",
            AbortSignal.timeout(10000),
          );
        if (
          !stopped &&
          epoch === generation.current &&
          before === revision.current
        )
          apply(value);
        // A spectator stays a spectator when the previous owner's lease ends.
        // Only the explicit button takes control, including an unused session.
      } catch (e) {
        if (
          !stopped &&
          epoch === generation.current &&
          before === revision.current
        ) {
          setDesktopLease(id);
          setMine(false);
          setChecked(true);
          setError((e as Error).message);
          callbacks.current.onReadOnlyChange?.(true);
        }
      } finally {
        reading = false;
      }
    };
    readNow.current = () => {
      void read();
    };
    void read();
    // Also renew leases and support a running host without control push events.
    const timer = setInterval(read, 3000);
    document.addEventListener("visibilitychange", read);
    return () => {
      stopped = true;
      generation.current++;
      unwatch();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
      readNow.current = () => {};
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
  }, [id]);
  useEffect(() => {
    if (active) readNow.current();
  }, [active, refresh]);
  if (!active) return null;
  return (
    <TerminalControlBanner
      readOnly={!mine}
      checking={!checked}
      busy={busy}
      owner={
        control?.clientId !== desktopClientId ? control?.deviceName : undefined
      }
      error={error || blockedReason}
      onClaim={() => void claim()}
    />
  );
}
