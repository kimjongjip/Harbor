import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { remoteDesktop } from "./desktop-session";
import { DesktopTerminalControl } from "./DesktopTerminalControl";
import type { TerminalControlView } from "../shared/mobile";
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
  callbacks.current = { onReadOnlyChange, onClaim };
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const read = () => {
      const generation = ++readGeneration.current;
      void api<{ control: TerminalControlView | null }>(
        `/terminals/${id}/control`,
        undefined,
        "GET",
      )
        .then((v) => {
          if (alive && generation === readGeneration.current) {
            setControl(v.control);
            callbacks.current.onReadOnlyChange?.(
              !!v.control &&
                v.control.clientId !== "local" &&
                v.control.expiresAt > Date.now(),
            );
          }
        })
        .catch(() => {});
    };
    read();
    const timer = setInterval(read, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id, active, refresh]);
  const otherControl =
    control && control.clientId !== "local" && control.expiresAt > Date.now()
      ? control
      : undefined;
  if (!active || (!otherControl && !blockedReason)) return null;
  return (
    <div className="terminal-attention" role="status">
      <span>
        {error ||
          (otherControl
            ? `${otherControl.deviceName}에서 제어 중 · 이 창은 보기 전용`
            : blockedReason)}
      </span>
      <button
        onClick={() =>
          void api(`/terminals/${id}/control`, { action: "claim" })
            .then(() => {
              readGeneration.current++;
              setControl(null);
              setError("");
              callbacks.current.onReadOnlyChange?.(false);
              callbacks.current.onClaim?.();
            })
            .catch((e) => setError(e.message))
        }
      >
        여기서 제어
      </button>
    </div>
  );
}
