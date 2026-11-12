import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { remoteDesktop } from "./desktop-session";
import { DesktopTerminalControl } from "./DesktopTerminalControl";
import type { TerminalControlView } from "../shared/mobile";
import { TerminalControlBanner } from "./TerminalControlBanner";
import { watchTerminalControl } from "./terminal-control-events";
export function TerminalControlStatus(
  props: Parameters<typeof LocalTerminalControlStatus>[0],
) {
  return remoteDesktop ? (
    <DesktopTerminalControl {...props} />
  ) : (
    <LocalTerminalControlStatus {...props} />
  );
}
function LocalTerminalControlStatus({
  id,
  active,
  refresh = 0,
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
  const [control, setControl] = useState<TerminalControlView | null>(null),
    [error, setError] = useState("");
  const callbacks = useRef({ onReadOnlyChange, onClaim });
  const readGeneration = useRef(0);
  const readNow = useRef<() => void>(() => {});
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const observed = useRef<TerminalControlView | null>(null);
  callbacks.current = { onReadOnlyChange, onClaim };
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const apply = (value: TerminalControlView | null) => {
      observed.current = value;
      setControl(value);
      setChecked(true);
      setError("");
      callbacks.current.onReadOnlyChange?.(
        !!value && value.clientId !== "local" && value.expiresAt > Date.now(),
      );
    };
    const unwatch = watchTerminalControl(id, (value) => {
      readGeneration.current++;
      apply(value);
    });
    const read = () => {
      const generation = ++readGeneration.current;
      void api<{ control: TerminalControlView | null }>(
        `/terminals/${id}/control`,
        undefined,
        "GET",
      )
        .then((v) => {
          if (alive && generation === readGeneration.current) {
            apply(v.control);
          }
        })
        .catch((e) => {
          if (alive && generation === readGeneration.current)
            setError(e.message);
        });
    };
    readNow.current = read;
    read();
    const timer = setInterval(read, 3000);
    return () => {
      alive = false;
      readGeneration.current++;
      unwatch();
      readNow.current = () => {};
      clearInterval(timer);
    };
  }, [id, active]);
  useEffect(() => {
    readNow.current();
  }, [refresh]);
  const otherControl =
    control && control.clientId !== "local" && control.expiresAt > Date.now()
      ? control
      : undefined;
  if (!active) return null;
  return (
    <TerminalControlBanner
      id={id}
      readOnly={!!otherControl || !!blockedReason || !checked}
      checking={!checked}
      busy={busy}
      owner={otherControl?.deviceName}
      error={error || blockedReason}
      onClaim={() => {
        if (busy) return;
        setBusy(true);
        const generation = ++readGeneration.current;
        void api(`/terminals/${id}/control`, { action: "claim" })
          .then(() => {
            // A live control event may have arrived during the request.
            if (readGeneration.current !== generation) {
              readNow.current();
              if (observed.current?.clientId === "local")
                callbacks.current.onClaim?.();
              return;
            }
            setControl(null);
            setChecked(true);
            setError("");
            callbacks.current.onReadOnlyChange?.(false);
            callbacks.current.onClaim?.();
          })
          .catch((e) => setError(e.message))
          .finally(() => setBusy(false));
      }}
    />
  );
}
