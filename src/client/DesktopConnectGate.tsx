import { useEffect, useState, type ReactNode } from "react";
import "./desktop-connect.css";
import { restoreDesktopAppearance } from "./desktop-workspace";

export default function DesktopConnectGate({
  children,
}: {
  children: ReactNode;
}) {
  const [code, setCode] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get("pair") || "",
  );
  const [name, setName] = useState("내 PC");
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(!code);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (code) {
      history.replaceState(null, "", location.pathname + location.search);
      return;
    }
    const abort = new AbortController();
    void fetch("/api/bootstrap", { signal: abort.signal })
      .then(async (response) => {
        if (response.ok) {
          restoreDesktopAppearance((await response.json()).workspace);
          setReady(true);
          return;
        }
        if (response.status !== 401) {
          const value = await response.json().catch(() => ({}));
          setError(
            value.error ||
              "호스트 PC의 Harbor를 업데이트한 뒤 정상 재실행하세요.",
          );
        }
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setError("호스트 PC의 Harbor 연결을 확인하세요.");
      })
      .finally(() => {
        if (!abort.signal.aborted) setChecking(false);
      });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    const expired = () => {
      setReady(false);
      setError(
        "기기 연결이 해제되었습니다. 호스트에서 새 PC 연결 링크를 만드세요.",
      );
    };
    window.addEventListener("harbor:device-expired", expired);
    return () => window.removeEventListener("harbor:device-expired", expired);
  }, []);
  if (ready) return children;
  return (
    <main className="desktop-connect">
      <section>
        <h1>
          Harbor <small>다른 PC 연결</small>
        </h1>
        {checking ? (
          <p role="status">기기 연결 확인 중…</p>
        ) : (
          <>
            <h2>이 PC 연결</h2>
            <p>
              호스트와 같은 Harbor 화면에서 기존 터미널과 IDE를 이어서
              사용합니다.
            </p>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                setBusy(true);
                setError("");
                try {
                  const response = await fetch("/mobile-api/pair", {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      "X-Harbor-Mobile": "1",
                    },
                    body: JSON.stringify({
                      code: code.trim(),
                      name: name.trim(),
                    }),
                  });
                  const value = await response.json();
                  if (!response.ok)
                    throw new Error(value.error || "PC 연결에 실패했습니다.");
                  const check = await fetch("/api/bootstrap");
                  if (!check.ok)
                    throw new Error(
                      (await check.json()).error ||
                        "PC용 연결 링크로 등록하세요.",
                    );
                  restoreDesktopAppearance((await check.json()).workspace);
                  setCode("");
                  setReady(true);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                기기 이름
                <input
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </label>
              <label>
                연결 코드
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                  autoComplete="off"
                />
              </label>
              <p className="muted">
                호스트 PC의 ‘휴대폰 · 다른 PC 연결’에서 만든 PC 연결 링크를 이
                브라우저로 여세요.
              </p>
              <button
                className="primary"
                disabled={busy || !code.trim() || !name.trim()}
              >
                {busy ? "등록 중…" : "등록하고 세션 보기"}
              </button>
            </form>
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </section>
    </main>
  );
}
