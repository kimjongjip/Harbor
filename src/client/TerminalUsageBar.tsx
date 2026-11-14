import { memo, useEffect, useId, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api, ApiError } from "./api";
import { TerminalPanelResize } from "./TerminalPanelResize";
import { TerminalCrew } from "./TerminalCrew";
import { TerminalWorkList, CodexSessionContext } from "./HostInsights";
import {
  claudeUsageSnapshot,
  mergeClaudeUsage,
  compactTokens,
  type TerminalUsage,
  type TerminalUsageResponse,
} from "../shared/terminal-usage";

interface Props {
  terminalId: string;
  hostId?: string;
  provider: "codex" | "claude";
  sessionId?: string;
  active: boolean;
  visible?: boolean;
  working: boolean;
  waiting?: boolean;
}

/** Own state only: a usage tick never invalidates TerminalPane or its transcript. */
export const TerminalUsageBar = memo(function TerminalUsageBar({
  terminalId,
  hostId,
  provider,
  sessionId,
  active: terminalActive,
  visible = true,
  working,
  waiting = false,
}: Props) {
  const mobileQuery = "(max-width: 760px), (hover: none) and (pointer: coarse)";
  const [mobile, setMobile] = useState(() => matchMedia(mobileQuery).matches);
  useEffect(() => {
    const media = matchMedia(mobileQuery);
    const changed = () => setMobile(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  const shown = visible && !mobile;
  const active = terminalActive && shown;
  const [collapsed, setCollapsed] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const panelId = useId();
  const scope = `${terminalId}:${provider}:${sessionId || ""}`;
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    usage: TerminalUsage | null;
    unavailable?: boolean;
  }>();
  const current = snapshot?.scope === scope ? snapshot : undefined;
  useEffect(() => {
    if (!active || !sessionId) return;
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let unsupported = false;
    const read = async () => {
      if (disposed || unsupported || document.visibilityState === "hidden")
        return;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 15000);
      let delay = working ? 2000 : 5000;
      try {
        const result = await api<TerminalUsageResponse>(
          `/terminals/${encodeURIComponent(terminalId)}/usage?sessionId=${encodeURIComponent(sessionId)}`,
          undefined,
          "GET",
          controller.signal,
        );
        if (!result || !("usage" in result)) {
          unsupported = true;
          if (!disposed) setSnapshot({ scope, usage: null, unavailable: true });
          return;
        }
        if (disposed) return;
        let usage =
          result.usage?.sessionId === sessionId &&
          result.usage.provider === provider
            ? result.usage
            : null;
        // Older running servers cannot receive /claude/usage. Their existing,
        // authenticated file reader can read the tiny native snapshot instead.
        if (
          provider === "claude" &&
          hostId &&
          (!usage ||
            usage.contextWindow === null ||
            usage.costUsd === null ||
            !usage.crew?.detailVersion)
        ) {
          try {
            const path = `~/.cache/harbor/usage/claude-${sessionId}.json`;
            const file = await api<{ kind: string; text?: string }>(
              `/hosts/${encodeURIComponent(hostId)}/files/preview?path=${encodeURIComponent(path)}`,
              undefined,
              "GET",
              controller.signal,
            );
            const native =
              file.kind === "text" && typeof file.text === "string"
                ? claudeUsageSnapshot(file.text, sessionId)
                : null;
            usage = mergeClaudeUsage(usage, native);
            if (
              usage &&
              native?.crew?.detailVersion &&
              !usage.crew?.detailVersion &&
              Date.now() - native.crew.updatedAt < 30000
            )
              usage = { ...usage, crew: native.crew };
          } catch {
            /* Keep the last available reading during reconnect/write. */
          }
        }
        if (disposed) return;
        setSnapshot((previous) => {
          if (
            previous?.scope === scope &&
            previous.usage?.source === "native" &&
            previous.usage.contextWindow !== null &&
            (!usage || usage.contextWindow === null)
          )
            return { ...previous, unavailable: true };
          return previous?.scope === scope &&
            !previous.unavailable &&
            JSON.stringify(previous.usage) === JSON.stringify(usage)
            ? previous
            : { scope, usage };
        });
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        unsupported =
          (error instanceof ApiError && [404, 405].includes(error.status)) ||
          error instanceof SyntaxError;
        delay = 15000;
        setSnapshot((previous) => ({
          scope,
          usage: previous?.scope === scope ? previous.usage : null,
          unavailable: true,
        }));
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
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [scope, terminalId, hostId, provider, sessionId, active, working]);
  // Keep cached usage/collapse state while releasing the panel's space, resize
  // observer and Crew animations. The terminal DOM and socket stay mounted.
  if (!shown) return null;
  const usage = current?.usage;
  const percent = usage?.usedPercent ?? null;
  const title = [
    usage?.metadataUpdatedAt
      ? `사용 토큰은 최신 대화 기록입니다. 한도·비용은 ${new Date(usage.metadataUpdatedAt).toLocaleString()}에 측정한 이전 값입니다.`
      : usage?.contextEstimated
        ? "Claude 엔진이 로컬에서 추정한 현재 컨텍스트입니다."
        : "마지막 API 응답 기준 컨텍스트 사용량입니다. 입력 중인 글자는 아직 포함되지 않을 수 있습니다.",
    usage?.source === "history"
      ? "저장 기록에서 확인한 값입니다. 한도·비용은 제공된 경우에만 표시합니다."
      : "CLI가 제공한 한도와 사용량입니다.",
    usage
      ? `갱신 ${new Date(usage.updatedAt).toLocaleTimeString()}`
      : "사용량 수신 대기 중입니다.",
    current?.unavailable
      ? "연결을 확인 중입니다. 마지막 수치를 유지합니다."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const providerName = provider === "claude" ? "Claude" : "Codex";
  const tone =
    percent === null
      ? "unknown"
      : percent >= 85
        ? "critical"
        : percent >= 60
          ? "warning"
          : "healthy";
  const remaining =
    usage?.contextWindow != null && usage.usedTokens !== null
      ? Math.max(0, usage.contextWindow - usage.usedTokens)
      : null;
  return (
    <aside
      ref={panel}
      id={panelId}
      className={`terminal-usage${collapsed ? " collapsed" : ""}`}
      data-tone={tone}
      aria-label={`${providerName} 컨텍스트 사용량`}
    >
      <TerminalPanelResize
        panel={panel}
        collapsed={collapsed}
        controls={panelId}
      />
      <header className="terminal-usage-header">
        {!collapsed && <span>Harbor</span>}
        <button
          type="button"
          aria-label={collapsed ? "상태 패널 펼치기" : "상태 패널 접기"}
          title={collapsed ? "상태 패널 펼치기" : "상태 패널 접기"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
        </button>
      </header>
      {collapsed ? (
        <span className="terminal-usage-compact" title={title}>
          {percent === null ? "상태" : `${Math.round(percent)}%`}
        </span>
      ) : (
        <div className="terminal-usage-scroll">
          <div className="terminal-usage-session">
            <strong>{providerName}</strong>
            <span className={working ? "working" : ""}>
              {waiting ? "입력 대기" : working ? "작업 중" : "대기"}
            </span>
          </div>
          {usage?.model && (
            <div className="terminal-usage-model">{usage.model}</div>
          )}
          <section className="terminal-usage-context" title={title}>
            <div className="terminal-usage-heading">
              <span
                className="terminal-usage-label"
                title={
                  usage?.metadataUpdatedAt
                    ? `한도 측정: ${new Date(usage.metadataUpdatedAt).toLocaleString()}`
                    : undefined
                }
              >
                컨텍스트{usage?.metadataUpdatedAt ? " · 이전 한도" : ""}
              </span>
              <strong className="terminal-usage-percent">
                {percent === null
                  ? usage
                    ? "미수집"
                    : "대기"
                  : `약 ${Math.round(percent)}%`}
              </strong>
            </div>
            <span
              className={`terminal-usage-meter ${tone}`}
              role="progressbar"
              aria-label="컨텍스트 사용률"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={
                percent === null ? undefined : Math.min(100, percent)
              }
              aria-valuetext={
                percent === null
                  ? "사용률 확인 중"
                  : `약 ${Math.round(percent)}%`
              }
            >
              <span
                style={{
                  width: `${percent === null ? 0 : Math.min(100, percent)}%`,
                }}
              />
            </span>
            <span
              className="terminal-usage-tokens"
              title={
                usage?.usedTokens != null && usage.contextWindow != null
                  ? `${usage.usedTokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} 토큰`
                  : undefined
              }
            >
              {usage?.usedTokens == null ? (
                "첫 응답 대기"
              ) : (
                <>
                  {compactTokens(usage.usedTokens)}
                  {usage.contextWindow == null ? (
                    " 사용"
                  ) : (
                    <>
                      <span className="terminal-usage-divider">/</span>
                      {compactTokens(usage.contextWindow)}
                    </>
                  )}
                </>
              )}
            </span>
            <span className="terminal-usage-caption">
              {usage?.usedTokens == null
                ? ""
                : usage.contextWindow == null
                  ? "한도 미수집"
                  : `사용 / ${usage.metadataUpdatedAt ? "이전 측정 한도" : "현재 세션 한도"}${usage.contextEstimated ? " · 로컬 추정" : ""}`}
            </span>
            {remaining !== null && (
              <div className="terminal-usage-remaining">
                <span>{compactTokens(remaining)} 남음</span>
                <strong>
                  {tone === "critical"
                    ? "압축 권장"
                    : tone === "warning"
                      ? "주의"
                      : "여유"}
                </strong>
              </div>
            )}
            {provider === "codex" && hostId && (
              <CodexSessionContext
                hostId={hostId}
                model={usage?.model}
                sessionWindow={usage?.contextWindow ?? null}
                active={active && !collapsed}
              />
            )}
          </section>
          <div
            className="terminal-usage-cost"
            title={
              provider === "codex"
                ? "모델별 누적 토큰을 공식 API 표준 단가로 환산합니다. 캐시 쓰기는 기본 30분 단가를 적용합니다. 구독 청구액·잔여 사용량과 별개이며 빠른 처리·도구 요금·계약 할인은 포함하지 않습니다."
                : "Claude /cost와 같은 세션 누적 예상 비용(USD)입니다. 실제 청구액과 다를 수 있습니다."
            }
          >
            <span>
              {provider === "codex"
                ? "API 환산 비용"
                : `세션 누적 비용${usage?.metadataUpdatedAt ? " · 이전값" : ""}`}
              {usage?.costStatus === "loading" ||
              usage?.costStatus === "partial"
                ? " · 소계"
                : ""}
            </span>
            <strong>
              {usage?.costUsd == null
                ? usage?.costStatus === "unpriced"
                  ? "단가 미등록"
                  : usage?.costStatus === "loading"
                    ? "계산 중"
                    : "미수집"
                : `$${usage.costUsd.toFixed(2)}`}
            </strong>
          </div>
          <TerminalCrew
            key={scope}
            provider={provider}
            state={waiting ? "waiting" : working ? "working" : "idle"}
            active={active}
            crew={usage?.crew}
            unavailable={current?.unavailable}
          />
          <TerminalWorkList
            terminalId={terminalId}
            active={active && !collapsed}
          />
          {current?.unavailable && (
            <p className="terminal-usage-note" role="status">
              사용량 연결 확인 중
            </p>
          )}
        </div>
      )}
    </aside>
  );
});
