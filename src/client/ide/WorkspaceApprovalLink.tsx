import { useEffect, useState } from "react";
import { api } from "../api";

export function WorkspaceApprovalLink({
  hostId,
  terminalId,
}: {
  hostId: string;
  terminalId: string;
}) {
  const [href, setHref] = useState("");
  const [error, setError] = useState("");
  const [revision, refresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let pending = false;
    async function load() {
      if (controller.signal.aborted || pending) return;
      clearTimeout(timer);
      setHref("");
      if (document.hidden) return;
      pending = true;
      setError("");
      try {
        const result = await api<{ url: string }>(
          "/hosts/" + encodeURIComponent(hostId) + "/server-workspace",
          { install: false },
          "POST",
          controller.signal,
        );
        const url = new URL(result.url);
        if (
          url.protocol !== "http:" ||
          !/^harbor-[a-f0-9]{24}\.localhost$/.test(url.hostname) ||
          !url.port ||
          url.pathname !== "/_workspace/open" ||
          url.username ||
          url.password ||
          !url.hash
        )
          throw Error("서버 작업 공간 주소를 확인할 수 없습니다.");
        url.searchParams.set("focus", terminalId);
        if (!controller.signal.aborted) {
          setHref(url.href);
          timer = setTimeout(load, 30000);
        }
      } catch {
        if (!controller.signal.aborted) setError("서버 연결 다시 확인");
      } finally {
        pending = false;
      }
    }
    void load();
    document.addEventListener("visibilitychange", load);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [hostId, terminalId, revision]);
  if (error)
    return (
      <button type="button" onClick={() => refresh((v) => v + 1)}>
        {error}
      </button>
    );
  if (!href) return <span role="status">서버 작업 공간 연결 중…</span>;
  return (
    <a
      className="button secondary small"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => setTimeout(() => refresh((v) => v + 1), 0)}
    >
      서버 작업 공간에서 확인
    </a>
  );
}
