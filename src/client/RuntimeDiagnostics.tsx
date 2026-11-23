import { useState } from "react";
import { api } from "./api";
import { Modal } from "./Dialogs";

interface ServerMetrics {
  at: number;
  pid: number;
  uptimeMs: number;
  available: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  samples: { at: number; rss: number; heapUsed: number }[];
}
const mib = (bytes: number) => (bytes / 1048576).toFixed(1) + " MiB";
export function RuntimeDiagnostics() {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [report, setReport] = useState<{
    backend: ServerMetrics;
    desktop: {
      pid: number;
      type: string;
      workingSetBytes: number;
      cpuPercent: number;
    }[];
  } | null>(null);
  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      const [backend, desktop] = await Promise.all([
        api<ServerMetrics>("/diagnostics/memory", undefined, "GET"),
        window.harborDesktop?.processMetrics?.() || [],
      ]);
      setReport({ backend, desktop });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const download = () => {
    if (!report) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "harbor-memory-" + report.backend.at + ".json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <>
      <button
        className="button secondary"
        onClick={() => {
          setOpen(true);
          void refresh();
        }}
      >
        메모리 진단
      </button>
      {open && (
        <Modal title="메모리 진단" onClose={() => setOpen(false)}>
          {report && (
            <>
              <p>
                확인 시각 {new Date(report.backend.at).toLocaleString()} ·
                시스템 여유 {mib(report.backend.available)}
              </p>
              <table>
                <thead>
                  <tr>
                    <th>프로세스</th>
                    <th>PID</th>
                    <th>메모리</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Harbor 백엔드</td>
                    <td>{report.backend.pid}</td>
                    <td>{mib(report.backend.rss)}</td>
                  </tr>
                  {report.desktop.map((row) => (
                    <tr key={row.pid}>
                      <td>{row.type === "Tab" ? "화면 렌더러" : row.type}</td>
                      <td>{row.pid}</td>
                      <td>{mib(row.workingSetBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>
                백엔드 샘플 {report.backend.samples.length}개 ·{" "}
                {new Date(report.backend.samples[0].at).toLocaleTimeString()}{" "}
                이후 최고{" "}
                {mib(Math.max(...report.backend.samples.map((s) => s.rss)))} ·
                현재 JS 힙 {mib(report.backend.heapUsed)}
              </p>
            </>
          )}
          {error && <p role="alert">{error}</p>}
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void refresh()}
          >
            {busy ? "확인 중…" : "다시 확인"}
          </button>
          <button
            className="button secondary"
            disabled={!report}
            onClick={download}
          >
            진단 JSON 저장
          </button>
        </Modal>
      )}
    </>
  );
}
