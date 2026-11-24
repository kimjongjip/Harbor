import { useEffect, useRef, useState } from "react";
import { api } from "../api";

export function WorkspaceApprovalLink({
  hostId,
  terminalId,
}: {
  hostId: string;
  terminalId: string;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const inline = window.harborDesktop?.inlineApproval;
  const [href, setHref] = useState("");
  const [error, setError] = useState("");
  const [revision, refresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let pending = false;
    const key = crypto.randomUUID();
    let attached = false;
    function bounds() {
      const node = mount.current;
      const r = node?.getBoundingClientRect();
      if (!node || !r || document.hidden || r.width < 80 || r.height < 30 ||
          !node.contains(document.elementFromPoint(r.x + r.width / 2,r.y + r.height / 2)))
        return {x:0,y:0,width:0,height:0};
      return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};
    }
    let previous = "";
    function position() {
      if (!attached || !inline) return;
      const rect = bounds(), signature = JSON.stringify(rect);
      if (previous !== signature) {
        previous = signature;
        void inline(key,rect).catch(() => {});
      }
    }
    const positionTimer = inline ? setInterval(position,150) : undefined;
    async function load() {
      if (controller.signal.aborted || pending) return;
      if (attached) { position(); return; }
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
          if (inline) {
            await inline(key,bounds(),url.href);
            if (controller.signal.aborted) return;
            attached = true;
            position();
            return;
          }
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
      clearInterval(positionTimer);
      if (inline) void inline(key,null).catch(() => {});
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
  if (inline) return <section className="workspace-inline-approval" aria-label="서버 승인 요청">
    <div><strong>승인 요청</strong><span>아래 입력란에서 /approve 번호 또는 /deny</span></div>
    <div className="workspace-approval-terminal" ref={mount}/>
  </section>;
  if (!href) return <span role="status">서버 작업 공간 연결 중…</span>;
  return (
    <a
      className="button secondary small"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => setTimeout(() => refresh((v) => v + 1), 0)}
    >
      {window.harborDesktop?.workspaceApprovalWindow ? "Harbor에서 원본 터미널 열기" : "서버 작업 공간에서 확인"}
    </a>
  );
}
