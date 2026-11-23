import { useState } from "react";
import { api } from "./api";

export function ServerWorkspace({
  hostId,
  password,
  disabled,
  enabled,
}: {
  hostId: string;
  password: string;
  disabled: boolean;
  enabled?: boolean;
}) {
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [workspace, setWorkspace] = useState<{
    url: string;
    updatePending: boolean;
  }>();
  async function open(install: boolean) {
    setPending(install ? "설치 확인 중…" : "연결 중…");
    setError("");
    setWorkspace(undefined);
    try {
      const result = await api<{ url: string; updatePending: boolean }>(
        "/hosts/" + encodeURIComponent(hostId) + "/server-workspace",
        { install, password: password || undefined },
      );
      const url = new URL(result.url);
      if (
        url.protocol !== "http:" ||
        !/^harbor-[0-9a-f]{24}\.localhost$/.test(url.hostname) ||
        !url.port ||
        url.pathname !== "/_workspace/open" ||
        url.username ||
        url.password
      )
        throw Error("서버 작업 공간 주소를 확인할 수 없습니다.");
      setWorkspace(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending("");
    }
  }
  return (
    <section>
      <strong>서버에서 세션 유지</strong>
      <p>서버 작업 공간에서 시작한 AI와 실험은 PC 연결을 끊어도 계속됩니다.</p>
      <div className="host-auth-row">
        <button
          type="button"
          className="button secondary"
          disabled={disabled || !!pending}
          onClick={() => void open(true)}
        >
          설치·업데이트
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={disabled || !!pending}
          onClick={() => void open(false)}
        >
          연결
        </button>
        {enabled && (
          <button
            type="button"
            className="button secondary"
            disabled={disabled || !!pending}
            onClick={async () => {
              setPending("연결 해제 중…");
              setError("");
              try {
                await api(
                  "/hosts/" + encodeURIComponent(hostId) + "/server-workspace",
                  undefined,
                  "DELETE",
                );
                setWorkspace(undefined);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setPending("");
              }
            }}
          >
            이 PC 연결 해제
          </button>
        )}
      </div>
      {pending && <p role="status">{pending}</p>}
      {workspace && (
        <>
          <a
            href={workspace.url}
            target="_blank"
            rel="noreferrer"
            className="button primary"
          >
            서버 작업 공간 열기
          </a>
          {workspace.updatePending && (
            <p>
              새 버전을 준비했습니다. 터미널과 작업이 끝나고 서버가 유휴 상태가
              되면 적용됩니다.
            </p>
          )}
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
