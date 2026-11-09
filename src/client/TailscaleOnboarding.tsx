import { useEffect, useRef, useState } from "react";
import { api } from "./api";
type Setup = {
  supported: boolean;
  canInstall: boolean;
  installed: boolean;
  loggedIn: boolean;
  connected: boolean;
  state: string;
  origin?: string;
  authUrl?: string;
  downloadUrl: string;
  job?: {
    id: string;
    action: string;
    status: string;
    message?: string;
    authUrl?: string;
  };
};
export function TailscaleOnboarding({
  onAddress,
}: {
  onAddress: (origin: string) => void;
}) {
  const [status, setStatus] = useState<Setup>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [checking, setChecking] = useState(false);
  const opened = useRef("");
  const startedLogin = useRef(false),
    refreshing = useRef(false),
    alive = useRef(true),
    lastAddress = useRef("");
  const address = useRef(onAddress);
  address.current = onAddress;
  async function refresh() {
    if (refreshing.current) return;
    refreshing.current = true;
    setChecking(true);
    try {
      const s = await api<Setup>("/mobile/setup", undefined, "GET");
      if (!alive.current) return;
      setStatus(s);
      setError("");
      if (s.origin && s.origin !== lastAddress.current) {
        lastAddress.current = s.origin;
        address.current(s.origin);
      }
      const link = s.authUrl || s.job?.authUrl;
      if (startedLogin.current && link && link !== opened.current) {
        opened.current = link;
        window.open(link, "_blank", "noopener,noreferrer");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      refreshing.current = false;
      if (alive.current) setChecking(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, []);
  async function start(action: "install" | "login") {
    if (action === "login") startedLogin.current = true;
    setBusy(true);
    setError("");
    try {
      await api("/mobile/setup", { action });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const running =
    busy ||
    ["running", "pending", "starting", "waiting"].includes(
      status?.job?.status || "",
    );
  const link = status?.authUrl || status?.job?.authUrl;
  return (
    <section
      className="tailscale-onboarding"
      aria-label="Tailscale 설치와 로그인"
    >
      <h3>1. 이 PC 준비</h3>
      <ol>
        <li>
          <b>Tailscale 설치</b>
          <span>
            {status?.installed ? "설치됨" : status ? "설치 필요" : "확인 중…"}
          </span>
          {!status?.installed &&
            (status?.canInstall ? (
              <button disabled={running} onClick={() => void start("install")}>
                Tailscale 설치
              </button>
            ) : (
              <a
                href="https://tailscale.com/download"
                target="_blank"
                rel="noreferrer"
              >
                공식 설치 페이지
              </a>
            ))}
        </li>
        <li>
          <b>내 계정으로 로그인</b>
          <span>
            {status?.connected
              ? "연결됨"
              : status?.loggedIn
                ? "로그인됨 · 연결 꺼짐"
                : "로그인 필요"}
          </span>
          {status?.installed && !status.connected && (
            <button disabled={running} onClick={() => void start("login")}>
              {status.loggedIn ? "Tailscale 연결" : "로그인하기"}
            </button>
          )}
        </li>
      </ol>
      {status?.job?.message && <p role="status">{status.job.message}</p>}
      {link && !status?.connected && (
        <a
          className="button primary"
          href={link}
          target="_blank"
          rel="noreferrer"
        >
          Tailscale 로그인 계속
        </a>
      )}
      <p>
        설치는 Windows 확인 창에서 승인하고, 로그인은 공식 Tailscale 화면에서
        완료하세요. Harbor에 계정 비밀번호를 입력할 필요가 없습니다.
      </p>
      <button disabled={checking} onClick={() => void refresh()}>
        {checking ? "상태 확인 중…" : "설치·로그인 상태 다시 확인"}
      </button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
