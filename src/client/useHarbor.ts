import { useCallback, useEffect, useRef, useState } from "react";
import type { AppState, ServerEvent, SessionView } from "../shared/types";
import { setToken, setConnectionMonitoring, reportViewConnection } from "./api";
import { SocketWatchdog } from "./socket-watchdog";
import { remoteDesktop } from "./desktop-session";
import type { DesktopWorkspace } from "../shared/desktop-workspace";

const empty: AppState = {
  hosts: [],
  sessions: [],
  activities: [],
  transfers: [],
  discussions: [],
  terminals: [],
};
export function useHarbor(
  openIds: string[],
  onError: (message: string) => void,
) {
  const [state, setState] = useState<AppState>(empty);
  const [views, setViews] = useState<Record<string, SessionView>>({});
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);
  const [workspace, setWorkspace] = useState<DesktopWorkspace>();
  const [aliases, setAliases] = useState<string[]>([]);
  const [localCwd, setLocalCwd] = useState("");
  const [credentialStorageAvailable, setCredentialStorageAvailable] =
    useState(false);
  const [terminalColorsSupported, setTerminalColorsSupported] = useState(false);
  const [terminalInputOptimized, setTerminalInputOptimized] = useState(false);
  const [terminalReplayState, setTerminalReplayState] = useState(false);
  const [claudeIntegration, setClaudeIntegration] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const idsRef = useRef(openIds);
  idsRef.current = openIds;
  const errorRef = useRef(onError);
  errorRef.current = onError;
  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout>;
    let failures = 0;
    let generation = 0;
    let watchdog: SocketWatchdog | undefined;
    let bootstrap: AbortController | undefined;
    const connect = async () => {
      const attempt = ++generation;
      const current = () => !stopped && generation === attempt;
      const recover = (reason: string, code?: number) => {
        if (!current()) return;
        generation++;
        watchdog?.dispose();
        bootstrap?.abort();
        const old = socketRef.current;
        socketRef.current = null;
        setConnected(false);
        reportViewConnection(undefined, reason, code);
        old?.close();
        retry = setTimeout(
          connect,
          Math.min(1000 * 2 ** Math.min(failures++, 4), 10000),
        );
      };
      bootstrap = new AbortController();
      const deadline = setTimeout(() => bootstrap?.abort(), 12000);
      try {
        const response = await fetch("/api/bootstrap", {
          signal: bootstrap.signal,
        });
        if (!response.ok) {
          if (remoteDesktop && response.status === 401)
            window.dispatchEvent(new Event("harbor:device-expired"));
          throw new Error("Harbor 서버에 연결할 수 없습니다.");
        }
        const data = await response.json();
        clearTimeout(deadline);
        if (!current()) return;
        setToken(data.token);
        setConnectionMonitoring(
          data.capabilities?.connectionMonitoring === true,
        );
        setState(data.state);
        setWorkspace(data.workspace);
        setAliases(data.sshAliases);
        setLocalCwd(data.localCwd);
        setCredentialStorageAvailable(!!data.credentialStorageAvailable);
        setTerminalColorsSupported(data.capabilities?.terminalColors === true);
        setTerminalInputOptimized(
          data.capabilities?.terminalInputOptimized === true,
        );
        setTerminalReplayState(data.capabilities?.terminalReplayState === true);
        setClaudeIntegration(data.capabilities?.claudeIntegration === true);
        setReady(true);
        const socket = new WebSocket(
          `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?token=${data.token}`,
        );
        socketRef.current = socket;
        watchdog = new SocketWatchdog({
          heartbeat: data.capabilities?.connectionMonitoring === true,
          onStall: recover,
        });
        socket.onopen = () => {
          if (!current()) return;
          watchdog?.opened();
          watchdog?.ready();
          failures = 0;
          setConnected(true);
          socket.send(
            JSON.stringify({
              type: "subscribe",
              sessions: idsRef.current,
              terminals: [],
            }),
          );
        };
        socket.onmessage = (event) => {
          if (!current()) return;
          watchdog?.message();
          const message: ServerEvent = JSON.parse(event.data);
          if (message.type === "state") setState(message.state);
          else if (message.type === "session")
            setViews((prev) => ({
              ...prev,
              [message.session.id]: message.session,
            }));
          else if (message.type === "error") errorRef.current(message.message);
        };
        socket.onclose = (event) => recover("socket-close", event.code);
        socket.onerror = () => recover("socket-error");
      } catch (error) {
        if (current()) {
          if (failures === 0) errorRef.current((error as Error).message);
          recover("bootstrap-failed");
        }
      } finally {
        clearTimeout(deadline);
      }
    };
    void connect();
    return () => {
      stopped = true;
      generation++;
      bootstrap?.abort();
      watchdog?.dispose();
      clearTimeout(retry);
      socketRef.current?.close();
    };
  }, []);
  useEffect(() => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({ type: "subscribe", sessions: openIds, terminals: [] }),
      );
  }, [openIds]);
  const updateView = useCallback(
    (s: SessionView) => setViews((prev) => ({ ...prev, [s.id]: s })),
    [],
  );
  return {
    state,
    views,
    connected,
    ready,
    workspace,
    aliases,
    localCwd,
    updateView,
    credentialStorageAvailable,
    terminalColorsSupported,
    terminalInputOptimized,
    terminalReplayState,
    claudeIntegration,
  };
}
