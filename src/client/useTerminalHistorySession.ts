import { useLayoutEffect, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { TerminalInfo } from "../shared/types";
import { api } from "./api";
import {
  codexHistoryTitle,
  recoverTerminalHistorySession,
} from "./terminal-history-session";

/** Some shared-daemon resumes never emit SessionStart to this terminal's hook.
 * Recover only the display's history ID; input, peers and backend state keep
 * their original authenticated binding. There are no per-key React updates. */
export function useTerminalHistorySession(
  term: Terminal | null,
  info: TerminalInfo,
  active: boolean,
) {
  const known = info.agentSessionId || info.resumeThreadId;
  const eligible = !info.exited && info.agentKind === "codex" && !known;
  const scope = `${info.id}:${info.hostId}`;
  const [recovered, setRecovered] = useState<{
    scope: string;
    id: string;
    title: string;
    term: Terminal;
  } | null>(null);
  useLayoutEffect(() => {
    if (!term || !eligible) {
      setRecovered(null);
      return;
    }
    // Visibility suspends reads, not the verified identity or reader DOM.
    // Revalidate before painting on return in case the hidden CLI changed sessions.
    if (!active) return;
    const retained =
      recovered?.scope === scope &&
      recovered.term === term &&
      recovered.title === codexHistoryTitle(term);
    if (!retained) setRecovered(null);
    let stopped = false,
      title: string | undefined = retained ? recovered.title : undefined,
      found = !!retained,
      attemptedAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    const inspect = async () => {
      timer = undefined;
      if (stopped || document.visibilityState === "hidden") return;
      const next = codexHistoryTitle(term);
      if (next !== title) {
        title = next;
        request?.abort();
        request = undefined;
        attemptedAt = 0;
        if (found) setRecovered(null);
        found = false;
      }
      if (!title || found || request || Date.now() - attemptedAt < 30000)
        return;
      attemptedAt = Date.now();
      const expected = title,
        controller = new AbortController();
      request = controller;
      try {
        const id = await recoverTerminalHistorySession(
          term,
          info.hostId,
          expected,
          <T>(path: string) =>
            api<T>(
              path,
              undefined,
              "GET",
              AbortSignal.any([controller.signal, AbortSignal.timeout(65000)]),
            ),
        );
        if (
          id &&
          !stopped &&
          !controller.signal.aborted &&
          codexHistoryTitle(term) === expected
        ) {
          found = true;
          setRecovered({ scope, id, title: expected, term });
        }
      } catch {
        // Unavailable/ambiguous history leaves the original CLI visible.
      } finally {
        if (request === controller) request = undefined;
      }
    };
    const schedule = () => {
      if (!stopped && timer === undefined)
        timer = setTimeout(() => void inspect(), 250);
    };
    const parsed = term.onWriteParsed(schedule),
      resized = term.onResize(schedule);
    const retry = setInterval(schedule, 30000);
    document.addEventListener("visibilitychange", schedule);
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(retry);
      request?.abort();
      parsed.dispose();
      resized.dispose();
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [term, eligible, active, scope, info.hostId]);
  return (
    known ||
    (eligible && recovered?.scope === scope && recovered.term === term
      ? recovered.id
      : undefined)
  );
}
