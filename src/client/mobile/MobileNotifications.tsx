import { useEffect, useState } from "react";

type PushState = {
  publicKey: string;
  enabled: boolean;
  delivery?: { state: "sent" | "failed" | "expired"; at: number };
};
type Api = (path: string, body?: unknown) => Promise<any>;
const supported = () =>
  "Notification" in window &&
  "PushManager" in window &&
  "serviceWorker" in navigator;
async function worker() {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "알림 준비가 지연됩니다. 앱을 새로고침하고 다시 켜주세요.",
              ),
            ),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
export function MobileNotifications({
  active,
  api,
}: {
  active: boolean;
  api: Api;
}) {
  const [state, setState] = useState<PushState>(),
    [local, setLocal] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [failure, setFailure] = useState("");
  const permission = supported() ? Notification.permission : "default";
  const enabled = !!state?.enabled && local && permission === "granted";
  useEffect(() => {
    if (!active || busy) return;
    let disposed = false;
    async function inspect() {
      try {
        const [remote, registration] = await Promise.all([
          api("/push"),
          supported()
            ? navigator.serviceWorker.getRegistration("/mobile/")
            : undefined,
        ]);
        const subscription = await registration?.pushManager.getSubscription();
        if (!disposed) {
          setState(remote);
          setLocal(!!subscription);
        }
      } catch (e) {
        if (!disposed) setFailure((e as Error).message);
      }
    }
    void inspect();
    const visible = () => {
      if (document.visibilityState === "visible") void inspect();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", visible);
    };
  }, [active, api, busy]);
  async function enable() {
    setBusy(true);
    setFailure("");
    setMessage("");
    try {
      if (!supported())
        throw new Error(
          "Safari 공유 메뉴에서 홈 화면에 추가한 뒤, 홈 화면의 Harbor에서 알림을 켜주세요. iOS 16.4 이상이 필요합니다.",
        );
      // Permission must be requested directly from the user's tap on iPhone.
      if ((await Notification.requestPermission()) !== "granted")
        throw new Error(
          "iPhone 설정 → 알림 → Harbor에서 알림을 허용한 뒤 다시 시도하세요.",
        );
      const [registration, remote] = await Promise.all([
        worker(),
        api("/push") as Promise<PushState>,
      ]);
      const key = Uint8Array.from(
        atob(remote.publicKey.replace(/-/g, "+").replace(/_/g, "/")),
        (c) => c.charCodeAt(0),
      );
      let subscription = await registration.pushManager.getSubscription();
      const oldKey = subscription?.options.applicationServerKey;
      if (
        subscription &&
        oldKey &&
        (oldKey.byteLength !== key.length ||
          new Uint8Array(oldKey).some((byte, i) => byte !== key[i]))
      ) {
        if (!(await subscription.unsubscribe()))
          throw new Error(
            "이전 알림 등록을 해제하지 못했습니다. 다시 시도하세요.",
          );
        subscription = null;
      }
      subscription ||= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
      await api("/push", subscription.toJSON());
      setState({ ...remote, enabled: true, delivery: undefined });
      setLocal(true);
      setMessage("알림을 켰습니다. 테스트 알림으로 휴대폰 수신을 확인하세요.");
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    setBusy(true);
    setFailure("");
    setMessage("");
    try {
      const result = await api("/push/test", {});
      setState(await api("/push"));
      if (!result.sent)
        throw new Error(
          "알림 전송에 실패했습니다. 알림을 다시 켜고 PC 인터넷 연결과 iPhone 알림 설정을 확인하세요.",
        );
      setMessage(
        "푸시 서비스에 테스트 알림을 전송했습니다. 휴대폰 알림 센터에서 수신을 확인하세요.",
      );
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function disable() {
    setBusy(true);
    setFailure("");
    setMessage("");
    try {
      await api("/push", null);
      setState(
        (value) => value && { ...value, enabled: false, delivery: undefined },
      );
      setLocal(false);
      // The server registration is already removed even if browser cleanup fails.
      if (supported()) {
        const registration =
          await navigator.serviceWorker.getRegistration("/mobile/");
        await (
          await registration?.pushManager.getSubscription()
        )
          ?.unsubscribe()
          .catch(() => {});
      }
      setMessage("이 기기의 알림을 껐습니다.");
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="card" aria-label="모바일 알림 설정">
      <h2>답변 완료 알림</h2>
      <p>
        Codex·Claude의 답변이 끝나면 이 기기에 알려줍니다. 승인·질문 요청도 받을
        수 있습니다. 알림을 누르면 해당 세션이 열립니다.
      </p>
      <p>
        <strong>
          알림:{" "}
          {busy
            ? "설정 중"
            : !state
              ? "확인 중"
              : enabled
                ? "켜짐"
                : permission === "denied"
                  ? "휴대폰에서 차단됨"
                  : "꺼짐"}
        </strong>
      </p>
      <div className="actions">
        <button disabled={busy || enabled} onClick={() => void enable()}>
          답변 완료 알림 켜기
        </button>
        <button disabled={busy || !enabled} onClick={() => void test()}>
          테스트 알림 보내기
        </button>
        <button
          disabled={busy || !state?.enabled}
          onClick={() => void disable()}
        >
          알림 끄기
        </button>
      </div>
      {state?.delivery?.state === "expired" && (
        <p>이 기기의 알림 등록이 만료됐습니다. 알림을 다시 켜주세요.</p>
      )}
      {state?.delivery?.state === "failed" && (
        <p>
          최근 알림을 전달하지 못했습니다. 테스트 알림으로 연결을 확인하세요.
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {failure && <p role="alert">{failure}</p>}
      <small>
        iPhone은 Safari → 공유 → 홈 화면에 추가 후 사용하세요. PC Harbor와 PC
        인터넷 연결은 유지되어야 합니다. 휴대폰 VPN은 Funnel 사용 시 필요
        없습니다. 집중 모드·알림 설정에 따라 표시가 늦어질 수 있습니다. 답변
        내용은 알림에 포함하지 않습니다.
      </small>
    </article>
  );
}
