import { memo, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
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
  const [collapsed, setCollapsed] = useState(false);
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
  const providerName = provider === "claude" ? "Claude" : "Codex";
  const partial = usage?.source === "history" && usage.contextWindow === null;
  return <aside className={`terminal-usage${collapsed ? " collapsed" : ""}`} aria-label={`${providerName} 컨텍스트 사용량`}>
    <header className="terminal-usage-header">
      {!collapsed && <span>Harbor</span>}
      <button type="button" aria-label={collapsed ? "상태 패널 펼치기" : "상태 패널 접기"}
        title={collapsed ? "상태 패널 펼치기" : "상태 패널 접기"} aria-expanded={!collapsed}
        onClick={() => setCollapsed(value => !value)}>
        {collapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
      </button>
    </header>
    {collapsed ? <span className="terminal-usage-compact" title={title}>{percent === null ? "상태" : `${Math.round(percent)}%`}</span> : <>
    <div className="terminal-usage-session"><strong>{providerName}</strong><span className={working ? "working" : ""}>{working ? "작업 중" : "대기"}</span></div>
    <section className="terminal-usage-context" title={title}>
    <div className="terminal-usage-heading"><span className="terminal-usage-label">컨텍스트</span>
    <strong className="terminal-usage-percent">{percent === null ? "—" : `약 ${Math.round(percent)}%`}</strong></div>
    <span className={`terminal-usage-meter ${percent === null ? "unknown" : percent >= 90 ? "critical" : percent >= 75 ? "warning" : ""}`}
      role="progressbar" aria-label="컨텍스트 사용률" aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={percent === null ? undefined : Math.min(100, percent)}
      aria-valuetext={percent === null ? "사용률 확인 중" : `약 ${Math.round(percent)}%`}>
      <span style={{ width: `${percent === null ? 0 : Math.min(100, percent)}%` }} />
    </span>
    <span className="terminal-usage-tokens">{compactTokens(usage?.usedTokens ?? null)}<span className="terminal-usage-divider">/</span>{compactTokens(usage?.contextWindow ?? null)}</span>
    <span className="terminal-usage-caption">사용 토큰 / 컨텍스트 한도</span>
    </section>
    <div className="terminal-usage-cost" title="CLI가 보고한 세션 누적 예상 비용(USD)입니다. 실제 청구액과 다를 수 있습니다.">
      <span>예상 비용</span><strong>{usage?.costUsd == null ? "미제공" : `$${usage.costUsd.toFixed(2)}`}</strong>
    </div>
    <p className="terminal-usage-note">{current?.unavailable ? "사용량 연결을 확인 중입니다. 마지막 수치를 유지합니다."
      : !sessionId ? "대화가 연결되면 사용량을 표시합니다."
      : !usage ? "사용량을 확인하고 있습니다. 첫 응답 전에는 수치가 없을 수 있습니다."
      : partial ? provider === "claude"
        ? "현재 세션의 사용 토큰입니다. 다음에 Harbor의 새 터미널에서 Claude를 실행·재개하면 한도·비용도 연결됩니다."
        : "현재 세션의 사용 토큰입니다. Codex가 컨텍스트 한도를 제공하면 사용률을 함께 표시합니다."
      : "마지막 API 응답 기준입니다."}</p>
    </>}
  </aside>;
});
