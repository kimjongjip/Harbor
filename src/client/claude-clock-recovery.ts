import type { Terminal } from "@xterm/xterm";
import { claudeWorkTimer, claudeElapsedFooter } from "./terminal-native-chrome";
import { restoreTerminalReplay } from "./terminalReplay";
import type { ServerEvent } from "../shared/types";

export function visibleClaudeClock(term: Terminal) {
  const b = term.buffer.active;
  for (
    let i = Math.min(b.length, b.baseY + term.rows) - 1;
    i >= Math.max(b.baseY, b.baseY + term.rows - 32);
    i--
  ) {
    const text = b.getLine(i)?.translateToString(true).trim();
    if (text && claudeElapsedFooter(text))
      return { working: claudeWorkTimer(text), text: text.slice(1).trim() };
  }
}

// A heartbeat proves only that the socket is alive. Compare a fresh read-only
// replay before reconnecting a view whose actual terminal clock stopped moving.
export function watchClaudeClock(
  term: Terminal,
  id: string,
  enabled: () => boolean,
  url: () => string,
  createReplica: () => Terminal,
  recover: () => void,
) {
  let previous = "",
    since = 0,
    checkedAt = 0,
    recovered = "",
    stopped = false;
  let probe: WebSocket | undefined,
    lastInput = -Infinity;
  const input = term.onData(() => {
    lastInput = performance.now();
  });
  const tick = () => {
    if (
      stopped ||
      document.hidden ||
      performance.now() - lastInput < 2500 ||
      !enabled()
    ) {
      previous = "";
      return;
    }
    const clock = visibleClaudeClock(term);
    if (!clock?.working) {
      previous = "";
      recovered = "";
      return;
    }
    const stamp = clock.text,
      now = performance.now();
    if (previous !== stamp) {
      previous = stamp;
      since = now;
      checkedAt = 0;
      recovered = "";
      return;
    }
    if (
      probe ||
      recovered === stamp ||
      now - since < 12000 ||
      (checkedAt && now - checkedAt < 30000)
    )
      return;
    checkedAt = now;
    const socket = new WebSocket(url());
    probe = socket;
    const abort = new AbortController();
    const close = () => {
      clearTimeout(deadline);
      abort.abort();
      if (probe === socket) probe = undefined;
      socket.close();
    };
    const deadline = setTimeout(close, 8000);
    socket.onclose = () => {
      clearTimeout(deadline);
      abort.abort();
      if (probe === socket) probe = undefined;
    };
    socket.onerror = close;
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          type: "subscribe",
          sessions: [],
          terminals: [id],
          state: false,
        }),
      );
    socket.onmessage = async (e) => {
      let frame: ServerEvent;
      try {
        frame = JSON.parse(e.data);
      } catch {
        close();
        return;
      }
      if (frame.type !== "terminal-data" || frame.id !== id) return;
      socket.onmessage = null;
      if (!frame.replay) {
        close();
        return;
      }
      const replica = createReplica();
      try {
        const current = () =>
          !stopped &&
          !abort.signal.aborted &&
          enabled() &&
          !document.hidden &&
          performance.now() - lastInput >= 2500;
        if (
          !(await restoreTerminalReplay(
            replica,
            frame.data,
            frame.replay,
            current,
            undefined,
            abort.signal,
          ))
        )
          return;
        const fresh = visibleClaudeClock(replica);
        if (
          current() &&
          fresh &&
          fresh.text !== stamp &&
          visibleClaudeClock(term)?.text === stamp
        ) {
          recovered = stamp;
          recover();
        }
      } catch {
        /* Retry an inconclusive read later; it is not a reason to interrupt the view. */
      } finally {
        replica.dispose();
        close();
      }
    };
  };
  const timer = setInterval(tick, 2000);
  return () => {
    stopped = true;
    input.dispose();
    clearInterval(timer);
    probe?.close();
  };
}
