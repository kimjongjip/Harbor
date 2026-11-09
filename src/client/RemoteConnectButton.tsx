import { useState } from "react";
import { MonitorUp } from "lucide-react";
import { Modal } from "./Dialogs";
export function RemoteConnectButton() {
  const [open, setOpen] = useState(false),
    [url, setUrl] = useState(""),
    [error, setError] = useState("");
  function connect() {
    try {
      const target = new URL(url.trim());
      if (
        target.protocol !== "https:" ||
        !target.hostname.endsWith(".ts.net") ||
        target.username ||
        target.password ||
        target.port
      )
        throw new Error(
          "호스트 PC에서 만든 Tailscale HTTPS 연결 링크를 입력하세요.",
        );
      target.pathname = "/desktop/";
      target.search = "";
      window.open(target.href, "_blank", "noopener,noreferrer");
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <button
        className="icon-button"
        aria-label="다른 Harbor 연결"
        title="다른 PC의 Harbor 이어 쓰기"
        onClick={() => setOpen(true)}
      >
        <MonitorUp size={17} />
      </button>
      {open && (
        <Modal
          title="다른 PC의 Harbor 연결"
          subtitle="호스트 PC에서 열어 둔 세션을 그대로 이어 씁니다."
          onClose={() => setOpen(false)}
        >
          <p>
            호스트 PC의 연결 아이콘 → PC 연결 링크 만들기를 누른 뒤 링크를
            이곳에 붙여 넣으세요. 등록 후에는 같은 주소로 다시 연결할 수
            있습니다.
          </p>
          <label>
            PC 연결 링크
            <input
              style={{ width: "100%" }}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://my-pc.example.ts.net/desktop/#pair=…"
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <button className="button primary" onClick={connect}>
            연결 창 열기
          </button>
        </Modal>
      )}
    </>
  );
}
