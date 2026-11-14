import { useEffect, useState } from "react";
import { Modal } from "./Dialogs";
import { api } from "./api";
import "./mobile-settings.css";
import { TailscaleOnboarding } from "./TailscaleOnboarding";
import type {
  MobileSettings as Settings,
  MobileNetworkStatus,
} from "../shared/mobile";
export default function MobileSettings({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState<Settings>(),
    [origin, setOrigin] = useState(""),
    [port, setPort] = useState(4318),
    [mode, setMode] = useState<"private" | "funnel">("funnel"),
    [network, setNetwork] = useState<MobileNetworkStatus>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [invite, setInvite] = useState<{
      url: string;
      expiresAt: number;
      kind?: "mobile" | "desktop";
    }>();
  useEffect(() => {
    void api<Settings>("/mobile", undefined, "GET")
      .then((v) => {
        setValue(v);
        setOrigin(v.origin);
        setPort(v.port);
        setMode(v.enabled ? v.mode || "private" : "funnel");
      })
      .catch((e) => setError(e.message));
  }, []);
  const supportsNetwork = value?.mode !== undefined;
  const dirty =
    !!value &&
    (origin.trim().replace(/\/$/, "") !== value.origin ||
      port !== value.port ||
      (supportsNetwork && mode !== value.mode));
  async function detect() {
    setBusy(true);
    setError("");
    try {
      const result = await api<MobileNetworkStatus>(
        "/mobile/network",
        undefined,
        "GET",
      );
      setOrigin(result.origin);
      setNetwork(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(enabled: boolean, connect = false) {
    setBusy(true);
    setError("");
    setInvite(undefined);
    setNetwork(undefined);
    try {
      let address = origin.trim().replace(/\/$/, "");
      if (enabled && !address && supportsNetwork) {
        address = (
          await api<MobileNetworkStatus>("/mobile/network", undefined, "GET")
        ).origin;
        setOrigin(address);
      }
      const saved = await api<Settings>(
        "/mobile",
        {
          enabled,
          origin: enabled ? address : value!.origin,
          port: enabled ? port : value!.port,
          ...(supportsNetwork ? { mode: enabled ? mode : value!.mode } : {}),
        },
        "PUT",
      );
      setValue(saved);
      if (connect && saved.listening && supportsNetwork) {
        const result = await api<MobileNetworkStatus>("/mobile/network", {});
        setNetwork(result);
        if (result.error) setError(result.error);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function pair(kind: "mobile" | "desktop" = "mobile") {
    setBusy(true);
    setError("");
    try {
      setInvite(await api("/mobile/pair", { kind }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="휴대폰 · 다른 PC 연결" onClose={onClose}>
      <div className="mobile-settings">
        <TailscaleOnboarding
          onAddress={(address) => setOrigin((current) => current || address)}
        />
        <h3>2. 연결 경로 설정</h3>
        <label>
          연결 방식
          <select
            aria-label="모바일 연결 방식"
            value={mode}
            disabled={busy || !supportsNetwork}
            onChange={(e) => {
              setMode(e.target.value as "private" | "funnel");
              setNetwork(undefined);
              setInvite(undefined);
            }}
          >
            <option value="funnel">VPN 없이 연결 · Tailscale Funnel</option>
            <option value="private">VPN으로 연결 · Tailscale Serve</option>
          </select>
        </label>
        <p>
          {mode === "funnel"
            ? "iPhone은 VPN이나 Tailscale 앱 없이 Safari·홈 화면 앱으로 접속합니다. PC에는 Tailscale을 설치하고 로그인해 두세요."
            : "PC와 iPhone에 Tailscale을 설치하고 같은 계정으로 로그인한 뒤 양쪽 연결을 켜세요."}{" "}
          PC Harbor와 PC Tailscale은 켜둔 상태로 사용합니다.
        </p>
        {mode === "funnel" && (
          <p>
            주소는 인터넷에서 접속할 수 있습니다. 터미널·대화는 PC에서 일회용
            링크로 등록한 기기만 볼 수 있습니다.
          </p>
        )}
        {value && !supportsNetwork && (
          <p role="alert">
            현재 실행 중인 PC 백엔드는 VPN 없는 연결을 지원하지 않습니다. 작업을
            정리한 뒤 Harbor 1.12.6 이상으로 다시 실행하세요. 새로고침만으로는
            적용되지 않습니다.
          </p>
        )}
        <label>
          Tailscale HTTPS 주소
          <input
            aria-label="모바일 HTTPS 주소"
            placeholder="https://my-pc.example.ts.net"
            value={origin}
            disabled={busy}
            onChange={(e) => {
              setOrigin(e.target.value);
              setNetwork(undefined);
              setInvite(undefined);
            }}
          />
        </label>
        {supportsNetwork && (
          <button disabled={busy} onClick={() => void detect()}>
            PC 주소 확인
          </button>
        )}
        <label>
          기기 연결 전용 로컬 포트
          <input
            type="number"
            value={port}
            min={1024}
            max={65535}
            disabled={busy}
            onChange={(e) => {
              setPort(Number(e.target.value));
              setNetwork(undefined);
              setInvite(undefined);
            }}
          />
        </label>
        <div>
          <button
            className="button primary"
            disabled={busy || !value}
            onClick={() => void save(true, true)}
          >
            {busy
              ? "처리 중…"
              : supportsNetwork
                ? "저장하고 연결 설정"
                : "모바일 연결 켜기 · 저장"}
          </button>{" "}
          <button
            disabled={busy || !value?.enabled}
            onClick={() => void save(false)}
          >
            끄기
          </button>
        </div>
        <div>
          상태:{" "}
          {value?.listening
            ? "접속 창구 실행 중"
            : value?.enabled
              ? "실행 실패"
              : "꺼짐"}
          {value?.error && <p role="alert">{value.error}</p>}
        </div>
        {network?.connected &&
          value?.listening &&
          !dirty &&
          network.mode === value.mode && (
            <p role="status">
              {network.mode === "funnel"
                ? "VPN 없는 연결 경로 설정 완료. iPhone의 VPN을 꺼도 접속할 수 있습니다."
                : "개인망 연결 경로 설정 완료. iPhone의 Tailscale을 켜고 접속하세요."}
            </p>
          )}
        {network?.conflict && (
          <p role="alert">
            PC의 HTTPS 443에 다른 서비스가 설정되어 있어 자동으로 바꾸지
            않습니다.
          </p>
        )}
        {network?.approvalUrl && (
          <p>
            <a href={network.approvalUrl} target="_blank" rel="noreferrer">
              Tailscale에서 연결 허용
            </a>{" "}
            후 돌아와 ‘저장하고 연결 설정’을 다시 누르세요.
          </p>
        )}
        {dirty && <p>변경한 설정을 저장한 뒤 기기 연결 링크를 만드세요.</p>}
        <details>
          <summary>직접 설정 · PowerShell 명령</summary>
          <p>
            모바일 전용 포트만 연결합니다. PC용 4317 포트는 연결하지 마세요.
            다른 서비스가 HTTPS 443을 사용 중이라면 해당 설정을 먼저 확인하세요.
          </p>
          <pre style={{ whiteSpace: "pre-wrap", userSelect: "text" }}>
            {`& "$env:ProgramFiles\\Tailscale\\tailscale.exe" ${supportsNetwork && mode === "funnel" ? "funnel" : "serve"} --bg --https=443 http://127.0.0.1:${port}`}
          </pre>
          {supportsNetwork && (
            <button disabled={busy || !value} onClick={() => void save(true)}>
              Harbor 설정만 저장
            </button>
          )}
        </details>
        <h3>3. 사용할 기기 등록</h3>
        <button
          disabled={busy || !value?.listening || dirty}
          onClick={() => void pair()}
        >
          휴대폰 연결 링크 만들기
        </button>
        <button
          disabled={busy || !value?.listening || dirty}
          onClick={() => void pair("desktop")}
        >
          PC 연결 링크 만들기
        </button>
        {invite && (
          <div>
            <label>
              10분 동안 유효 · 한 기기만 등록
              <input
                readOnly
                value={invite.url}
                onFocus={(e) => e.currentTarget.select()}
              />
            </label>
            <button
              onClick={() =>
                void navigator.clipboard
                  .writeText(invite.url)
                  .catch(() => setError("위 링크를 선택해 복사하세요."))
              }
            >
              링크 복사
            </button>
            <p>
              {invite.kind === "desktop"
                ? "다른 PC의 Harbor 상단 ‘다른 Harbor 연결’에 붙여 넣거나 브라우저에서 여세요. 같은 터미널과 IDE를 사용할 수 있습니다."
                : "iPhone Safari에서 링크를 열고 연결하세요. 공유 → 홈 화면에 추가하면 앱 아이콘이 생깁니다."}{" "}
              연결 링크는 해당 기기를 사용할 사람에게만 전달하세요.
            </p>
          </div>
        )}
        <h3>연결된 기기</h3>
        {value?.devices.length ? (
          <p>
            같은 HTTPS 주소를 사용하면 연결 방식을 바꿔도 기존 기기는 다시
            등록할 필요가 없습니다.
          </p>
        ) : null}
        {value?.devices.length ? (
          value.devices.map((d) => (
            <div
              key={d.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>
                {d.name} · {d.kind === "desktop" ? "PC" : "모바일"} ·{" "}
                {d.notifications ? "알림 켜짐" : "알림 꺼짐"}
                <small style={{ display: "block" }}>
                  만료 {new Date(d.expiresAt).toLocaleDateString()}
                </small>
              </span>
              <button
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void api<Settings>(
                    `/mobile/devices/${d.id}`,
                    undefined,
                    "DELETE",
                  )
                    .then(setValue)
                    .catch((e) => setError(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                연결 해제
              </button>
            </div>
          ))
        ) : (
          <p>등록된 기기가 없습니다.</p>
        )}
        {error && <p role="alert">{error}</p>}
        <p>
          휴대폰이 잠겨도 PC 작업은 계속됩니다. PC Harbor 종료·PC 전원 종료 후
          독립 실행은 후속 단계입니다.
        </p>
        <a
          href="https://tailscale.com/download"
          target="_blank"
          rel="noreferrer"
        >
          Tailscale 다운로드
        </a>
      </div>
    </Modal>
  );
}
