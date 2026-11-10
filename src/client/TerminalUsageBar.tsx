import { memo, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import { compactTokens, type TerminalUsage, type TerminalUsageResponse } from "../shared/terminal-usage";

interface Props {
  terminalId: string;
  provider: "codex" | "claude";
  sessionId?: string;
  active: boolean;
  working: boolean;
}

/** Own state only: a usage tick never invalidates TerminalPane or its transcript. */
export const TerminalUsageBar = memo(function TerminalUsageBar({ terminalId, provider, sessionId, active, working }: Props) {
  const scope = `${terminalId}:${provider}:${sessionId || ""}`;
  const [snapshot, setSnapshot] = useState<{ scope: string; usage: TerminalUsage | null; unavailable?: boolean }>();
  const current = snapshot?.scope === scope ? snapshot : undefined;
  useEffect(() => {
    if (!active || !sessionId) return;
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let unsupported = false;
    const read = async () => {
      if (disposed || unsupported || document.visibilityState === "hidden") return;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 15000);
      let delay = working ? 2000 : 5000;
      try {
        const result = await api<TerminalUsageResponse>(`/terminals/${encodeURIComponent(terminalId)}/usage?sessionId=${encodeURIComponent(sessionId)}`, undefined, "GET", controller.signal);
        if (!result || !("usage" in result)) {
          unsupported = true;
          if (!disposed) setSnapshot({ scope, usage: null, unavailable: true });
          return;
        }
        if (disposed) return;
        const usage = result.usage?.sessionId === sessionId && result.usage.provider === provider ? result.usage : null;
        setSnapshot(previous => previous?.scope === scope && !previous.unavailable && JSON.stringify(previous.usage) === JSON.stringify(usage)
          ? previous : { scope, usage });
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        unsupported = (error instanceof ApiError && [404, 405].includes(error.status)) || error instanceof SyntaxError;
        delay = 15000;
        setSnapshot(previous => ({ scope, usage: previous?.scope === scope ? previous.usage : null, unavailable: true }));
      } finally {
        clearTimeout(timeout);
        controller = undefined;
        if (!disposed && !unsupported) timer = setTimeout(read, delay);
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (document.visibilityState === "hidden") controller?.abort();
      else if (!controller) void read();
    };
    document.addEventListener("visibilitychange", visibility);
    void read();
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); document.removeEventListener("visibilitychange", visibility); };
  }, [scope, terminalId, provider, sessionId, active, working]);
  const usage = current?.usage;
  const percent = usage?.usedPercent ?? null;
  const title = [
    "마지막 API 응답 기준 컨텍스트 사용량입니다. 입력 중인 글자는 아직 포함되지 않을 수 있습니다.",
    usage?.source === "history" ? "저장 기록에서 확인한 값입니다. 한도·비용은 제공된 경우에만 표시합니다." : "CLI가 제공한 한도와 사용량입니다.",
    usage ? `갱신 ${new Date(usage.updatedAt).toLocaleTimeString()}` : "사용량 수신 대기 중입니다.",
    current?.unavailable ? "연결을 확인 중입니다. 마지막 수치를 유지합니다." : "",
  ].filter(Boolean).join("\n");
  return <div className="terminal-usage" aria-label={`${provider === "claude" ? "Claude" : "Codex"} 컨텍스트 사용량`} title={title}>
    <span className="terminal-usage-label">컨텍스트</span>
    <span className={`terminal-usage-meter ${percent === null ? "unknown" : percent >= 90 ? "critical" : percent >= 75 ? "warning" : ""}`}
      role="progressbar" aria-label="컨텍스트 사용률" aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={percent === null ? undefined : Math.min(100, percent)}
      aria-valuetext={percent === null ? "사용률 확인 중" : `약 ${Math.round(percent)}%`}>
      <span style={{ width: `${percent === null ? 0 : Math.min(100, percent)}%` }} />
    </span>
    <strong className="terminal-usage-percent">{percent === null ? "—" : `약 ${Math.round(percent)}%`}</strong>
    <span className="terminal-usage-tokens">{compactTokens(usage?.usedTokens ?? null)}<span className="terminal-usage-divider">/</span>{compactTokens(usage?.contextWindow ?? null)}</span>
    <span className="terminal-usage-cost" title="CLI가 보고한 세션 누적 예상 비용(USD)입니다. 실제 청구액과 다를 수 있으며 미제공 시 —로 표시합니다.">
      비용 {usage?.costUsd == null ? "—" : `$${usage.costUsd.toFixed(2)}`}
    </span>
    {current?.unavailable && <span className="terminal-usage-note">연결 확인 중</span>}
  </div>;
});
