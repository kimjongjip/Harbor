import { useEffect, useState } from "react";
import type { TerminalInfo } from "../shared/types";
import type { HistoryDetail } from "../shared/history";
import { api } from "./api";
import { MermaidDiagram } from "./MermaidDiagram";
import { savedDiagrams } from "./terminal-diagrams";

/** Native Codex sessions may have no app-server answer subscription. Read their
 * saved answer only when the visible CLI reports an unsupported diagram. */
export function TerminalDiagramFallback({
  info,
  visible,
}: {
  info: TerminalInfo;
  visible: boolean;
}) {
  const sessionId = info.agentSessionId || info.resumeThreadId;
  const [diagrams, setDiagrams] = useState<ReturnType<typeof savedDiagrams>>(
    [],
  );
  const [selectedId, setSelectedId] = useState<string>();
  const [collapsed, setCollapsed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const ready =
    visible &&
    info.agentState !== "working" &&
    !info.exited &&
    !["disconnected", "reconnecting", "connecting"].includes(
      info.connectionState || "",
    );
  useEffect(() => {
    if (!ready || !sessionId) return;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 35000);
    let active = true;
    let delay: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setError("");
    void (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const detail: HistoryDetail = await api<HistoryDetail>(
          `/hosts/${encodeURIComponent(info.hostId)}/history/${encodeURIComponent(sessionId)}?provider=codex`,
          undefined,
          "GET",
          controller.signal,
        );
        if (!active) return;
        if (
          detail.thread.id !== sessionId ||
          detail.thread.hostId !== info.hostId
        )
          throw Error("대화가 바뀌었습니다. 현재 대화에서 다시 열어 주세요.");
        const found = savedDiagrams(detail.items);
        if (found.length) {
          setDiagrams(found);
          return;
        }
        if (attempt < 2)
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(delay);
              controller.signal.removeEventListener("abort", finish);
              resolve();
            };
            delay = setTimeout(finish, 1200);
            controller.signal.addEventListener("abort", finish, { once: true });
          });
        if (!active) return;
      }
      throw Error(
        "저장된 완료 답변에서 다이어그램을 아직 찾지 못했습니다. 답변 완료 후 다시 읽어 주세요.",
      );
    })()
      .catch((cause) => {
        if (active)
          setError(
            controller.signal.aborted
              ? "대화 기록을 읽는 시간이 초과되었습니다. 다시 읽어 주세요."
              : (cause as Error).message,
          );
      })
      .finally(() => {
        clearTimeout(deadline);
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
      clearTimeout(deadline);
      clearTimeout(delay);
    };
  }, [ready, sessionId, info.hostId, retry]);
  if (!visible || (!ready && !diagrams.length)) return null;
  const selected =
    diagrams.find((item) => item.id === selectedId) || diagrams.at(-1);
  return (
    <section
      className={`terminal-rich-card ${collapsed ? "collapsed" : ""}`}
      aria-label="저장된 답변의 Mermaid 그림"
      data-terminal-rich="true"
    >
      <header>
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? "▸" : "▾"} 답변의 다이어그램
        </button>
        {!collapsed && diagrams.length > 1 && (
          <select
            aria-label="저장된 다이어그램 선택"
            value={selected?.id}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {diagrams.map((item, index) => (
              <option key={item.id} value={item.id}>
                그림 {index + 1}
                {index === diagrams.length - 1 ? " · 최신" : ""}
              </option>
            ))}
          </select>
        )}
      </header>
      {!collapsed && (
        <div className="terminal-rich-card-body">
          <div className="terminal-rich-loading">
            {loading
              ? "저장된 답변에서 그림을 읽는 중…"
              : "Codex 원문에 있는 Mermaid를 Harbor에서 표시합니다."}
            {!loading && (
              <button
                type="button"
                className="button secondary small"
                disabled={!ready}
                onClick={() => setRetry((value) => value + 1)}
              >
                다시 읽기
              </button>
            )}
          </div>
          {error && (
            <p role="status" className="terminal-rich-loading">
              {error}
            </p>
          )}
          {selected && (
            <article
              data-rich-block={`diagram-${selected.id}`}
              className="terminal-rich-content markdown"
            >
              <MermaidDiagram key={selected.id} source={selected.source} />
            </article>
          )}
        </div>
      )}
    </section>
  );
}
