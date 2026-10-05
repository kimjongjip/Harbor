import { useCallback, useEffect, useRef, useState } from "react";
import type { AppState, ServerEvent, SessionView } from "../shared/types";
import { setToken } from "./api";

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
    const connect = async () => {
      try {
        const response = await fetch("/api/bootstrap");
        if (!response.ok) throw new Error("Harbor 서버에 연결할 수 없습니다.");
        const data = await response.json();
        if (stopped) return;
        setToken(data.token);
        setState(data.state);
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
        socket.onopen = () => {
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
          const message: ServerEvent = JSON.parse(event.data);
          if (message.type === "state") setState(message.state);
          else if (message.type === "session")
            setViews((prev) => ({
              ...prev,
              [message.session.id]: message.session,
            }));
          else if (message.type === "error") errorRef.current(message.message);
        };
        socket.onclose = () => {
          setConnected(false);
          if (!stopped)
            retry = setTimeout(
              connect,
              Math.min(1000 * 2 ** failures++, 10000),
            );
        };
        socket.onerror = () => socket.close();
      } catch (error) {
        if (!stopped) {
          if (failures === 0) errorRef.current((error as Error).message);
          retry = setTimeout(connect, Math.min(1000 * 2 ** failures++, 10000));
        }
      }
    };
    void connect();
    return () => {
      stopped = true;
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
