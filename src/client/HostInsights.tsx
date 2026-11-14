import { memo, useEffect, useState } from "react";
import { Activity, ChevronDown, Coffee, Cpu, RefreshCw } from "lucide-react";
import { api } from "./api";
import type {
  AccountQuota,
  CodexContextSettings as ContextSettings,
  TerminalWorkSnapshot,
} from "../shared/host-insights";
import "./host-insights.css";

/** Polling lives here, never in App/TerminalPane, so telemetry cannot invalidate input. */
function usePoll<T>(
  path: string | undefined,
  interval: number,
  forceRefresh = false,
) {
  const [value, setValue] = useState<{ path: string; data: T }>();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<string>).detail === path)
        setRefresh((n) => n + 1);
    };
    window.addEventListener("harbor:context-settings-changed", changed);
    return () =>
      window.removeEventListener("harbor:context-settings-changed", changed);
  }, [path]);
  useEffect(() => {
    if (!path) return;
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    const read = async (manual = false) => {
      if (disposed) return;
      if (document.visibilityState !== "hidden") {
        controller = new AbortController();
        const timeout = setTimeout(() => controller?.abort(), 30000);
        try {
          const url = manual && forceRefresh ? `${path}?refresh=1` : path;
          const data = await api<T>(url, undefined, "GET", controller.signal);
          if (!disposed) {
            setValue({ path, data });
            setError("");
          }
        } catch {
          if (!disposed)
            setError(
              "정보를 불러오지 못했습니다. 서버 연결과 Harbor 버전을 확인해주세요.",
            );
        } finally {
          clearTimeout(timeout);
        }
      }
      if (!disposed) timer = setTimeout(() => void read(), interval);
    };
    void read(refresh > 0);
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [path, interval, refresh, forceRefresh]);
  return {
    data: value && value.path === path ? value.data : undefined,
    error,
    refresh: () => setRefresh((n) => n + 1),
  };
}
const tokens = (n: number | null) =>
  n === null
    ? "확인 필요"
    : n >= 1000000
      ? `${(n / 1000000).toFixed(2)}M`
      : `${(n / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}k`;
function displayedWindows(account: AccountQuota) {
  if (account.provider !== "claude") return account.windows;
  return ["7일 한도", "7일 Fable 한도"].map(
    (label) =>
      account.windows.find((w) => w.label === label) || {
        label,
        remaining: null,
        resetsAt: undefined,
      },
  );
}
export const AccountUsagePanel = memo(function AccountUsagePanel({
  hostId,
  hostName,
}: {
  hostId?: string;
  hostName?: string;
}) {
  const [open, setOpen] = useState(true);
  const { data, error, refresh } = usePoll<{ accounts: AccountQuota[] }>(
    hostId && open
      ? `/hosts/${encodeURIComponent(hostId)}/account-usage`
      : undefined,
    120000,
    true,
  );
  if (!hostId) return null;
  return (
    <section className="account-usage-panel" aria-label="AI 구독 한도">
      <header>
        <button
          className="insights-heading"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          <ChevronDown size={14} /> AI 사용 한도
        </button>
        <button
          className="icon-button"
          title="사용 한도 새로고침 (최소 15초 간격, 요청 제한 시 대기)"
          onClick={refresh}
        >
          <RefreshCw size={13} />
        </button>
      </header>
      {open && (
        <>
          <small className="quota-host">
            {hostName || "선택한 서버"} · CLI 계정
          </small>
          {error && <p role="status">{error}</p>}
          {!data && !error && <p>구독 한도를 확인하고 있습니다…</p>}
          {data?.accounts.map((account) => (
            <article key={account.provider} className="account-quota">
              <header
                className="quota-account-heading"
                title={`${account.account || "CLI 로그인 계정"} · ${new Date(account.updatedAt).toLocaleString("ko-KR")} 확인`}
              >
                <strong>
                  {account.provider === "codex" ? "Codex" : "Claude"}{" "}
                  <small>{account.plan}</small>
                </strong>
                <small>
                  {new Date(account.updatedAt).toLocaleTimeString("ko-KR", {
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                  })}
                </small>
              </header>
              {displayedWindows(account).map((w, i) => (
                <div className="quota-window" key={i}>
                  <div>
                    <span>{w.label}</span>
                    <b
                      title={
                        w.remaining === null && !account.error
                          ? "현재 계정의 Claude 응답에 이 한도가 제공되지 않았습니다."
                          : undefined
                      }
                      className={
                        w.remaining === null ? "quota-unavailable" : undefined
                      }
                    >
                      {w.remaining === null
                        ? account.error
                          ? "확인 불가"
                          : "미제공"
                        : `${Math.round(w.remaining)}% 남음`}
                    </b>
                  </div>
                  {w.remaining !== null && (
                    <>
                      <progress
                        className={
                          w.remaining < 10
                            ? "critical"
                            : w.remaining < 30
                              ? "low"
                              : ""
                        }
                        max={100}
                        value={w.remaining}
                        aria-label={`${w.label} 남은 비율`}
                      />
                      {w.resetsAt && (
                        <small>
                          {new Date(w.resetsAt).toLocaleString("ko-KR", {
                            month: "numeric",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })}{" "}
                          초기화
                        </small>
                      )}
                    </>
                  )}
                </div>
              ))}
              {account.error && (
                <p className="insights-warning">
                  {account.stale && account.windows.length
                    ? "이전 수치 · "
                    : ""}
                  {account.error}
                </p>
              )}
            </article>
          ))}
        </>
      )}
    </section>
  );
});

export function CodexContextSettings({ hostId }: { hostId: string }) {
  const path = `/hosts/${encodeURIComponent(hostId)}/codex-context`;
  const { data, error } = usePoll<ContextSettings>(path, 300000);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const configure = async (action: "expand" | "compact") => {
    setBusy(true);
    setMessage("");
    try {
      await api(path, { action });
      window.dispatchEvent(
        new CustomEvent("harbor:context-settings-changed", { detail: path }),
      );
      setMessage(
        "설정을 저장했습니다. 다음 Codex 실행·대화 재개부터 적용됩니다. 실행 중인 대화는 유지됩니다.",
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="codex-context-settings">
      <h3>Codex 컨텍스트 · 압축 기준</h3>
      <p>
        {data
          ? `${data.model}${data.profile ? ` · ${data.profile}` : ""} · 현재 ${tokens(data.current)} / 지원 최대 ${tokens(data.maximum)}`
          : error || "이 서버의 모델 설정을 확인하고 있습니다…"}
      </p>
      <div className="insights-actions">
        <button
          disabled={busy || !data?.maximum || data.customProvider}
          onClick={() => configure("expand")}
        >
          컨텍스트 최대 확장{data?.maximum ? ` · ${tokens(data.maximum)}` : ""}
        </button>
        <button
          disabled={busy || !data?.current || data.customProvider}
          onClick={() => configure("compact")}
        >
          사용량 기준 압축 설정
        </button>
      </div>
      <p>
        이 버튼은 사용량 기준 압축을 설정합니다. 컨텍스트 90%에서 압축하고, 답변
        완료 후 85% 이상이면 압축하도록 설정합니다. Claude의 캐시 만료 전 유휴
        압축과는 다릅니다. 현재 확인한 Codex 공식 설정에는 유휴 시간·캐시 만료
        기준 압축 옵션이 없습니다.
      </p>
      {data && (
        <small>
          {data.usable != null
            ? `CLI 사용 가능 한도: ${tokens(data.usable)} (${data.usablePercent}%). `
            : ""}
          현재 압축 기준:{" "}
          {data.compactAt ? tokens(data.compactAt) : "모델 기본값"} · 답변 후
          압축:{" "}
          {data.postTurnPercent ? `${data.postTurnPercent}%` : "CLI 기본값"}.
          최대치는 Codex가 자동 저장한 models_cache.json의 모델별 상한입니다.
          버튼을 누르면 해당 서버의 config.toml(선택한 프로필 포함)에 설정을
          저장합니다.
        </small>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}

/** Config is the next-launch default; never replace the running CLI's actual limit. */
export function CodexSessionContext({
  hostId,
  model,
  sessionWindow,
  active,
}: {
  hostId: string;
  model?: string;
  sessionWindow: number | null;
  active: boolean;
}) {
  const { data } = usePoll<ContextSettings>(
    active ? `/hosts/${encodeURIComponent(hostId)}/codex-context` : undefined,
    60000,
  );
  if (
    !data ||
    data.customProvider ||
    !data.current ||
    (model && data.model !== model)
  )
    return null;
  const pending =
    sessionWindow != null &&
    data.usable != null &&
    sessionWindow !== data.usable &&
    sessionWindow !== data.current;
  return (
    <div className="codex-session-context" role="status">
      <span>
        저장된 설정 <b>{tokens(data.current)}</b>
        {data.usable != null
          ? ` · 사용 가능 ${(data.usable / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}k`
          : ""}
      </span>
      {pending && (
        <p>
          현재 세션에 적용 대기 · Codex를 종료한 뒤 같은 대화를 다시 실행하면
          설정을 읽습니다.
        </p>
      )}
      {data.usable == null &&
        sessionWindow != null &&
        sessionWindow !== data.current && (
          <p>
            위 수치는 현재 세션이 보고한 한도입니다. 저장된 설정은 다음 Codex
            실행부터 읽습니다.
          </p>
        )}
    </div>
  );
}

export const TerminalWorkList = memo(function TerminalWorkList({
  terminalId,
  active,
}: {
  terminalId: string;
  active: boolean;
}) {
  const { data, error } = usePoll<TerminalWorkSnapshot>(
    active ? `/terminals/${encodeURIComponent(terminalId)}/work` : undefined,
    10000,
  );
  const labels = {
    gpu: "GPU 작업",
    simulator: "시뮬레이터",
    monitor: "모니터링",
    background: "백그라운드",
  };
  return (
    <section className="terminal-work-list" aria-label="백그라운드 작업">
      <h4>
        <Activity size={14} /> 백그라운드 작업
      </h4>
      {(error || data?.error) && (
        <p className="insights-warning">{error || data?.error}</p>
      )}
      {data?.jobs.map((job) => (
        <article key={job.id} className={job.state === "ended" ? "ended" : ""}>
          {job.state === "running" ? (
            <Cpu size={18} className="work-pulse" />
          ) : (
            <Coffee size={18} />
          )}
          <div>
            <b>
              {labels[job.kind]} ·{" "}
              {job.state === "running" ? "실행 중" : "종료"}
            </b>
            <p title={job.task}>{job.task}</p>
            <small>
              PID {job.pid}
              {job.memoryMiB !== undefined
                ? ` · GPU 메모리 ${job.memoryMiB.toLocaleString()} MiB`
                : ""}
            </small>
          </div>
        </article>
      ))}
      {data && !data.error && !data.jobs.length && (
        <p>이 터미널에서 실행한 작업이 없습니다.</p>
      )}
      {!data && !error && <p>작업 확인 중…</p>}
      <small>현재 터미널의 작업만 표시 · 10초 간격</small>
    </section>
  );
});
