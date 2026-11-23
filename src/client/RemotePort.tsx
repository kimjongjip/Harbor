import { useEffect, useRef, useState } from "react";
import { api } from "./api";
type Forward = { id: string; remotePort: number; localPort: number };
export function RemotePort({
  id,
  password,
  disabled,
}: {
  id: string;
  password: string;
  disabled: boolean;
}) {
  const [port, setPort] = useState(""),
    [rows, setRows] = useState<Forward[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const generation = useRef(0),
    base = "/hosts/" + encodeURIComponent(id) + "/loopback-ports";
  useEffect(() => {
    let active = true;
    const load = async () => {
      const seq = generation.current;
      try {
        const result = await api<Forward[]>(base, undefined, "GET");
        if (active && seq === generation.current) setRows(result);
      } catch (e) {
        if (active && seq === generation.current)
          setError((e as Error).message);
      }
    };
    void load();
    const timer = setInterval(load, 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [base]);
  async function change(row?: Forward) {
    setBusy(true);
    setError("");
    generation.current++;
    try {
      if (row) await api(base + "/" + row.id, undefined, "DELETE");
      else
        await api(base, {
          remotePort: Number(port),
          password: password || undefined,
        });
      setRows(await api<Forward[]>(base, undefined, "GET"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      generation.current++;
      setBusy(false);
    }
  }
  return (
    <section className="host-workspace">
      <h3>원격 포트 열기</h3>
      <label>
        서버 포트{" "}
        <input
          type="number"
          aria-label="원격 서버 포트"
          min={1}
          max={65535}
          value={port}
          placeholder="예: 8888"
          onChange={(e) => setPort(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="button secondary"
        disabled={
          disabled ||
          busy ||
          !Number.isInteger(+port) ||
          +port < 1 ||
          +port > 65535
        }
        onClick={() => void change()}
      >
        이 PC에 연결
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {rows.map((row) => (
        <p key={row.id}>
          <a
            href={"http://127.0.0.1:" + row.localPort + "/"}
            target="_blank"
            rel="noopener noreferrer"
          >
            서버 {row.remotePort} 열기
          </a>{" "}
          · <code>127.0.0.1:{row.localPort}</code>{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() => void change(row)}
          >
            연결 닫기
          </button>
        </p>
      ))}
      {rows.length > 0 && <small>15분간 통신이 없으면 연결이 닫힙니다.</small>}
    </section>
  );
}
