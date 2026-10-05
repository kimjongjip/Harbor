import { useEffect, useState } from "react";
import { setToken } from "./api";
import { PreviewProvider, type Target } from "./ResourcePreview";
import type { HostView } from "../shared/types";
import { classifyLink } from "../shared/links";

function readTarget(): Target {
  const raw = JSON.parse(
    new URLSearchParams(location.hash.slice(1)).get("target") || "null",
  );
  if (!raw || typeof raw !== "object") throw new Error("파일 주소가 없습니다.");
  if (typeof raw.url === "string" && classifyLink(raw.url).kind === "web")
    return { url: raw.url, image: true };
  if (typeof raw.hostId !== "string" || typeof raw.path !== "string")
    throw new Error("올바르지 않은 파일 주소입니다.");
  return {
    hostId: raw.hostId,
    path: raw.path,
    cwd: typeof raw.cwd === "string" ? raw.cwd : "~",
    line: Number.isInteger(raw.line) && raw.line > 0 ? raw.line : undefined,
  };
}

// A document window never mounts useHarbor or subscribes/resizes a terminal.
export default function PreviewWindow() {
  const [ready, setReady] = useState<{
    hosts: HostView[];
    target: Target;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const target = readTarget();
      const response = await fetch("/api/bootstrap");
      if (!response.ok) throw new Error("Harbor에 연결하지 못했습니다.");
      const data = await response.json();
      if (cancelled) return;
      setToken(data.token);
      document.title = `${target.path?.split(/[\\/]/).pop() || "미리보기"} · Harbor`;
      setReady({ hosts: data.state.hosts, target });
    })().catch((e) => {
      if (!cancelled) setError(e.message);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (error) return <p role="alert">{error}</p>;
  if (!ready) return <p role="status">파일을 불러오는 중…</p>;
  return (
    <PreviewProvider
      hosts={ready.hosts}
      initialTarget={ready.target}
      standalone
      onFolder={() =>
        setError("폴더는 Harbor 본창의 파일 탐색기에서 열어 주세요.")
      }
    >
      {null}
    </PreviewProvider>
  );
}
